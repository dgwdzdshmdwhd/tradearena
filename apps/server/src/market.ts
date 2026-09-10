/**
 * Der Preis-Feed.
 *
 * EINE WebSocket-Verbindung zu Binance fuer alle Spieler zusammen. Egal ob
 * zwei oder fuenfzig Leute online sind - die Last zur Boerse bleibt gleich,
 * und niemand laeuft in ein Rate Limit. Die Kurse werden hier gecacht und
 * von `hub.ts` gedrosselt an die Browser verteilt.
 *
 * `bookTicker` liefert echtes Bid und Ask. Deshalb muss fuer Krypto gar kein
 * Spread simuliert werden: Market Buy geht wirklich zum Ask, Sell zum Bid.
 *
 * Faellt Binance aus oder ist nicht erreichbar, springt ein Simulator ein.
 * Lieber ein klar gekennzeichneter Ersatzkurs als eine tote App.
 */

import { parsePrice, volatilityBps, type Candle, type Price, type Quote } from '@tradearena/core';
import WebSocket from 'ws';

import { config } from './config.js';

const BINANCE_WS = 'wss://stream.binance.com:9443/stream';
const BINANCE_REST = 'https://api.binance.com/api/v3';

export type FeedStatus = 'connecting' | 'live' | 'simulated';

interface SymbolState {
  quote: Quote;
  candles: Candle[];
  candlesFetchedAt: number;
}

export class MarketFeed {
  private readonly state = new Map<string, SymbolState>();
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private simulator: NodeJS.Timeout | null = null;
  private closed = false;

  status: FeedStatus = 'connecting';

  constructor(readonly symbols: readonly string[]) {}

  start(): void {
    if (config.offline) {
      this.startSimulator('Offline-Modus aktiv');
      return;
    }
    this.connect();
    void this.refreshAllCandles();
  }

  stop(): void {
    this.closed = true;
    this.socket?.close();
    if (this.simulator) clearInterval(this.simulator);
  }

  quote(symbol: string): Quote | null {
    return this.state.get(symbol)?.quote ?? null;
  }

  candles(symbol: string): Candle[] {
    return this.state.get(symbol)?.candles ?? [];
  }

  volatility(symbol: string): number {
    const candles = this.candles(symbol);
    return candles.length > 25 ? volatilityBps(candles, 20) : 100;
  }

  allQuotes(): Record<string, { bid: string; ask: string; last: string; at: number }> {
    const out: Record<string, { bid: string; ask: string; last: string; at: number }> = {};
    for (const [symbol, entry] of this.state) {
      out[symbol] = {
        bid: entry.quote.bid.toString(),
        ask: entry.quote.ask.toString(),
        last: entry.quote.last.toString(),
        at: entry.quote.at,
      };
    }
    return out;
  }

  // --- Binance-WebSocket --------------------------------------------------

  private connect(): void {
    if (this.closed) return;

    const streams = this.symbols.map((symbol) => `${symbol.toLowerCase()}@bookTicker`).join('/');
    const url = `${BINANCE_WS}?streams=${streams}`;

    this.status = this.state.size > 0 ? this.status : 'connecting';
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempts = 0;
      this.status = 'live';
      this.stopSimulator();
      console.log(`[markt] Binance verbunden, ${this.symbols.length} Symbole`);
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(String(raw)) as {
          data?: { s?: string; b?: string; a?: string };
        };
        const data = message.data;
        if (!data?.s || !data.b || !data.a) return;
        this.applyBookTicker(data.s, data.b, data.a);
      } catch {
        // Kaputte Nachricht einfach verwerfen - der naechste Tick kommt gleich.
      }
    });

    socket.on('error', () => {
      // Details kommen im close-Handler.
    });

    socket.on('close', () => {
      if (this.closed) return;
      this.reconnectAttempts += 1;

      // Nach drei Fehlversuchen ist klar: Binance ist gerade nicht erreichbar.
      if (this.reconnectAttempts >= 3 && this.status !== 'simulated') {
        this.startSimulator('Binance nicht erreichbar');
      }

      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.reconnectAttempts));
      setTimeout(() => this.connect(), delay);
    });
  }

  private applyBookTicker(symbol: string, bidRaw: string, askRaw: string): void {
    const bid = parsePrice(bidRaw);
    const ask = parsePrice(askRaw);
    if (bid <= 0n || ask <= 0n) return;

    const existing = this.state.get(symbol);
    const quote: Quote = { bid, ask, last: (bid + ask) / 2n, at: Date.now() };

    if (existing) {
      existing.quote = quote;
    } else {
      this.state.set(symbol, { quote, candles: [], candlesFetchedAt: 0 });
    }
  }

  // --- Historische Kerzen -------------------------------------------------

  /**
   * Kerzen von Binance holen. Wird fuer Charts, Indikatoren, die
   * Volatilitaets-Schaetzung und die Zeitmaschine gebraucht.
   */
  async fetchCandles(
    symbol: string,
    interval: string,
    limit = 300,
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]> {
    if (config.offline) return simulateCandles(symbol, limit, interval);

    const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(1000, limit)) });
    if (startTime) params.set('startTime', String(startTime));
    if (endTime) params.set('endTime', String(endTime));

    try {
      const response = await fetch(`${BINANCE_REST}/klines?${params.toString()}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const rows = (await response.json()) as Array<[number, string, string, string, string, string]>;
      return rows.map((row) => ({
        t: row[0],
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: Number(row[5]),
      }));
    } catch {
      return simulateCandles(symbol, limit, interval);
    }
  }

  private async refreshAllCandles(): Promise<void> {
    for (const symbol of this.symbols) {
      const candles = await this.fetchCandles(symbol, '1m', 300);
      const entry = this.state.get(symbol);
      if (entry) {
        entry.candles = candles;
        entry.candlesFetchedAt = Date.now();
      } else if (candles.length > 0) {
        const last = parsePrice(String(candles[candles.length - 1]!.c));
        this.state.set(symbol, {
          quote: { bid: last, ask: last, last, at: Date.now() },
          candles,
          candlesFetchedAt: Date.now(),
        });
      }
    }

    if (!this.closed) {
      // Einmal pro Minute nachladen reicht - der Live-Kurs kommt ja per WebSocket.
      setTimeout(() => void this.refreshAllCandles(), 60_000);
    }
  }

  // --- Simulator als Rueckfallebene ---------------------------------------

  private startSimulator(reason: string): void {
    if (this.simulator) return;

    this.status = 'simulated';
    console.warn(`[markt] Simulator aktiv (${reason}). Kurse sind erfunden.`);

    for (const symbol of this.symbols) {
      if (!this.state.has(symbol)) {
        const seed = SIMULATED_START[symbol] ?? 100;
        const price = parsePrice(String(seed));
        this.state.set(symbol, {
          quote: { bid: price, ask: price, last: price, at: Date.now() },
          candles: simulateCandles(symbol, 300, '1m'),
          candlesFetchedAt: Date.now(),
        });
      }
    }

    this.simulator = setInterval(() => {
      for (const [, entry] of this.state) {
        // Zufaelliger Gang mit leichtem Zittern, damit sich etwas bewegt.
        const drift = (Math.random() - 0.5) * 0.002;
        const next = Number(entry.quote.last) * (1 + drift);
        const last = BigInt(Math.max(1, Math.round(next)));
        const halfSpread = last / 5_000n;
        entry.quote = {
          bid: last - halfSpread,
          ask: last + halfSpread,
          last,
          at: Date.now(),
        };
      }
    }, 1_000);
  }

  private stopSimulator(): void {
    if (!this.simulator) return;
    clearInterval(this.simulator);
    this.simulator = null;
  }
}

const SIMULATED_START: Record<string, number> = {
  BTCUSDT: 68_000,
  ETHUSDT: 3_500,
  SOLUSDT: 175,
  XRPUSDT: 0.62,
  DOGEUSDT: 0.16,
  ADAUSDT: 0.48,
  AVAXUSDT: 34,
  LINKUSDT: 17,
  PEPEUSDT: 0.000012,
  BNBUSDT: 600,
};

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function intervalMs(interval: string): number {
  return INTERVAL_MS[interval] ?? 60_000;
}

/** Erfundene, aber plausibel aussehende Kerzen fuer den Notfall. */
function simulateCandles(symbol: string, limit: number, interval: string): Candle[] {
  const step = intervalMs(interval);
  const start = SIMULATED_START[symbol] ?? 100;
  const candles: Candle[] = [];

  let price = start;
  let time = Date.now() - limit * step;

  for (let i = 0; i < limit; i += 1) {
    const open = price;
    const move = (Math.random() - 0.5) * 0.01;
    price = Math.max(0.000001, price * (1 + move));
    const high = Math.max(open, price) * (1 + Math.random() * 0.002);
    const low = Math.min(open, price) * (1 - Math.random() * 0.002);

    candles.push({ t: time, o: open, h: high, l: low, c: price, v: 100 + Math.random() * 900 });
    time += step;
  }

  return candles;
}

/** Preis in eine `Quote` verwandeln, wenn nur ein Kurs bekannt ist. */
export function quoteFromPrice(price: Price, spreadBps = 4): Quote {
  const half = (price * BigInt(spreadBps)) / 20_000n;
  return {
    bid: price - half > 0n ? price - half : price,
    ask: price + half,
    last: price,
    at: Date.now(),
  };
}
