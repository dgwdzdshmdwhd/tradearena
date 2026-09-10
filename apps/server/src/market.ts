/**
 * Der Preis-Feed.
 *
 * EINE WebSocket-Verbindung zu Binance fuer alle Spieler zusammen. Egal ob
 * zwei oder fuenfzig Leute online sind - die Last zur Boerse bleibt gleich.
 * `bookTicker` liefert echtes Bid und Ask, deshalb muss fuer Krypto kein
 * Spread simuliert werden.
 *
 * ZWEI QUELLEN, DIE AUSEINANDERLAUFEN KOENNEN:
 * Der Live-Kurs kommt ueber den WebSocket, die Kurshistorie ueber die
 * REST-Schnittstelle. Binance sperrt REST fuer manche Rechenzentren (HTTP 451),
 * waehrend der WebSocket weiter laeuft. Genau das ist im Betrieb passiert:
 * erfundene Ersatz-Kerzen trafen auf einen echten Live-Kurs, und der Chart
 * zeigte einen senkrechten Absturz von 3.700 auf 2.467.
 *
 * Daraus zwei Lehren, die hier umgesetzt sind:
 *   1. Mehrere REST-Hosts probieren, angefangen beim oeffentlichen
 *      Datenspiegel data-api.binance.vision, der aus Rechenzentren
 *      zuverlaessiger erreichbar ist.
 *   2. Niemals Historie erfinden, die dem Live-Kurs widerspricht. Faellt REST
 *      komplett aus, bauen wir die Kerzen aus den eigenen Live-Ticks. Die
 *      Historie ist dann kurz - aber sie stimmt.
 */

import { parsePrice, volatilityBps, type Candle, type Price, type Quote } from '@tradearena/core';
import WebSocket from 'ws';

import { config } from './config.js';

const BINANCE_WS = 'wss://stream.binance.com:9443/stream';

/** In dieser Reihenfolge probiert. Der Datenspiegel zuerst. */
const REST_HOSTS = [
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.com/api/v3',
  'https://api-gcp.binance.com/api/v3',
];

export type FeedStatus = 'connecting' | 'live' | 'simulated';
export type HistoryStatus = 'unknown' | 'rest' | 'ticks-only';

/** So viele selbst gebaute Minutenkerzen behalten wir je Symbol. */
const MAX_LIVE_CANDLES = 720;

interface SymbolState {
  quote: Quote;
  /** Von der Boerse geholte Historie. */
  history: Candle[];
  /** Aus den eigenen Live-Ticks gebaute Minutenkerzen. */
  live: Candle[];
  historyFetchedAt: number;
}

export class MarketFeed {
  private readonly state = new Map<string, SymbolState>();
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private simulator: NodeJS.Timeout | null = null;
  private closed = false;
  private restHost: string | null = null;

  status: FeedStatus = 'connecting';
  historyStatus: HistoryStatus = 'unknown';

  constructor(readonly symbols: readonly string[]) {}

  start(): void {
    if (config.offline) {
      this.startSimulator('Offline-Modus aktiv');
      return;
    }
    this.connect();
    void this.refreshAllHistory();
  }

  stop(): void {
    this.closed = true;
    this.socket?.close();
    if (this.simulator) clearInterval(this.simulator);
  }

  quote(symbol: string): Quote | null {
    return this.state.get(symbol)?.quote ?? null;
  }

  /**
   * Kerzen fuer den Chart: geholte Historie plus die selbst gebauten
   * Minutenkerzen. Doppelte Zeitstempel gewinnt die eigene Kerze, weil sie
   * aktueller ist.
   */
  candles(symbol: string): Candle[] {
    const entry = this.state.get(symbol);
    if (!entry) return [];

    const merged = new Map<number, Candle>();
    for (const candle of entry.history) merged.set(candle.t, candle);
    for (const candle of entry.live) merged.set(candle.t, candle);

    return [...merged.values()].sort((a, b) => a.t - b.t);
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

  // --- WebSocket ----------------------------------------------------------

  private connect(): void {
    if (this.closed) return;

    const streams = this.symbols.map((symbol) => `${symbol.toLowerCase()}@bookTicker`).join('/');
    const socket = new WebSocket(`${BINANCE_WS}?streams=${streams}`);
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
        // Kaputte Nachricht verwerfen, der naechste Tick kommt gleich.
      }
    });

    socket.on('error', () => {
      // Details kommen im close-Handler.
    });

    socket.on('close', () => {
      if (this.closed) return;
      this.reconnectAttempts += 1;

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

    const last = (bid + ask) / 2n;
    const quote: Quote = { bid, ask, last, at: Date.now() };
    const entry = this.state.get(symbol);

    if (!entry) {
      this.state.set(symbol, { quote, history: [], live: [], historyFetchedAt: 0 });
      this.appendTick(symbol, last);
      return;
    }

    entry.quote = quote;
    this.appendTick(symbol, last);
  }

  /**
   * Aus dem Tick eine Minutenkerze bauen bzw. die laufende fortschreiben.
   * Damit hat der Chart immer echte Daten, die zum Live-Kurs passen -
   * auch wenn die Boersen-Historie gar nicht erreichbar ist.
   */
  private appendTick(symbol: string, price: Price): void {
    const entry = this.state.get(symbol);
    if (!entry) return;

    const value = Number(price) / 1e8;
    if (!Number.isFinite(value) || value <= 0) return;

    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const current = entry.live[entry.live.length - 1];

    if (current && current.t === minute) {
      current.c = value;
      current.h = Math.max(current.h, value);
      current.l = Math.min(current.l, value);
      current.v += 1;
      return;
    }

    entry.live.push({ t: minute, o: value, h: value, l: value, c: value, v: 1 });
    if (entry.live.length > MAX_LIVE_CANDLES) entry.live.shift();
  }

  // --- Historie -----------------------------------------------------------

  /**
   * Kerzen von der Boerse holen. Probiert die Hosts der Reihe nach und merkt
   * sich den, der geantwortet hat.
   */
  async fetchCandles(
    symbol: string,
    interval: string,
    limit = 300,
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]> {
    if (config.offline) return [];

    const params = new URLSearchParams({ symbol, interval, limit: String(Math.min(1000, limit)) });
    if (startTime) params.set('startTime', String(startTime));
    if (endTime) params.set('endTime', String(endTime));

    const hosts = this.restHost ? [this.restHost, ...REST_HOSTS] : REST_HOSTS;

    for (const host of hosts) {
      try {
        const response = await fetch(`${host}/klines?${params.toString()}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) continue;

        const rows = (await response.json()) as Array<
          [number, string, string, string, string, string]
        >;
        if (!Array.isArray(rows)) continue;

        if (this.restHost !== host) {
          this.restHost = host;
          console.log(`[markt] Historie ueber ${host}`);
        }
        this.historyStatus = 'rest';

        return rows.map((row) => ({
          t: row[0],
          o: Number(row[1]),
          h: Number(row[2]),
          l: Number(row[3]),
          c: Number(row[4]),
          v: Number(row[5]),
        }));
      } catch {
        // naechsten Host probieren
      }
    }

    // Kein Host erreichbar. Es wird bewusst NICHTS erfunden - lieber eine
    // kurze, richtige Historie aus eigenen Ticks als eine lange, falsche.
    if (this.historyStatus !== 'ticks-only') {
      this.historyStatus = 'ticks-only';
      console.warn(
        '[markt] Kurshistorie nicht erreichbar. Der Chart waechst aus den Live-Ticks mit.',
      );
    }
    return [];
  }

  private async refreshAllHistory(): Promise<void> {
    for (const symbol of this.symbols) {
      const candles = await this.fetchCandles(symbol, '1m', 300);
      if (candles.length === 0) continue;

      const entry = this.state.get(symbol);
      if (entry) {
        entry.history = candles;
        entry.historyFetchedAt = Date.now();
      } else {
        const last = parsePrice(String(candles[candles.length - 1]!.c));
        this.state.set(symbol, {
          quote: { bid: last, ask: last, last, at: Date.now() },
          history: candles,
          live: [],
          historyFetchedAt: Date.now(),
        });
      }
    }

    if (!this.closed) {
      setTimeout(() => void this.refreshAllHistory(), 60_000);
    }
  }

  // --- Simulator (nur ohne Internet) --------------------------------------

  private startSimulator(reason: string): void {
    if (this.simulator) return;

    this.status = 'simulated';
    console.warn(`[markt] Simulator aktiv (${reason}). Kurse sind erfunden.`);

    for (const symbol of this.symbols) {
      if (!this.state.has(symbol)) {
        const price = parsePrice(String(SIMULATED_START[symbol] ?? 100));
        this.state.set(symbol, {
          quote: { bid: price, ask: price, last: price, at: Date.now() },
          history: [],
          live: [],
          historyFetchedAt: Date.now(),
        });
      }
    }

    this.simulator = setInterval(() => {
      for (const [symbol, entry] of this.state) {
        const drift = (Math.random() - 0.5) * 0.002;
        const next = Number(entry.quote.last) * (1 + drift);
        const last = BigInt(Math.max(1, Math.round(next)));
        const halfSpread = last / 5_000n;

        entry.quote = { bid: last - halfSpread, ask: last + halfSpread, last, at: Date.now() };
        this.appendTick(symbol, last);
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

/** Ein Kurs zu einer `Quote` machen, wenn die Quelle kein Bid/Ask liefert. */
export function quoteFromPrice(price: Price, spreadBps = 4): Quote {
  const half = (price * BigInt(spreadBps)) / 20_000n;
  return {
    bid: price - half > 0n ? price - half : price,
    ask: price + half,
    last: price,
    at: Date.now(),
  };
}
