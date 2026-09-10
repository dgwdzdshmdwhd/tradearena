/**
 * Die Zeitmaschine.
 *
 * Echte historische Kurse im Zeitraffer. Die Engine bleibt exakt dieselbe -
 * nur die Uhr ist eine andere. Deshalb gelten hier auch dieselben Gebuehren,
 * dieselbe Slippage und dieselben Ordertypen wie im Live-Markt.
 *
 * Damit niemand schummelt, werden die Symbole waehrend des Laufs
 * anonymisiert ("ASSET A") und die Zeitachse verschwiegen. Erst am Ende
 * wird aufgeloest, welcher Zeitraum das war.
 */

import { parsePrice, type Candle, type Quote } from '@tradearena/core';

import type { MarketFeed } from './market.js';

export interface Scenario {
  key: string;
  name: string;
  /** Wird erst nach dem Lauf angezeigt. */
  reveal: string;
  symbols: string[];
  from: number;
  to: number;
  /** Empfohlene Dauer des Laufs in Minuten. */
  minutes: number;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    key: 'covid',
    name: 'Der grosse Absturz',
    reveal: 'COVID-Crash, 9.-14. Maerz 2020. Bitcoin verlor an einem Tag die Haelfte.',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    from: Date.UTC(2020, 2, 9),
    to: Date.UTC(2020, 2, 14),
    minutes: 15,
  },
  {
    key: 'ftx',
    name: 'Das Kartenhaus',
    reveal: 'FTX-Kollaps, 7.-11. November 2022. Eine der groessten Boersen loeste sich auf.',
    symbols: ['BTCUSDT', 'SOLUSDT'],
    from: Date.UTC(2022, 10, 7),
    to: Date.UTC(2022, 10, 11),
    minutes: 15,
  },
  {
    key: 'luna',
    name: 'Die Todesspirale',
    reveal: 'LUNA/UST-Kollaps, 9.-13. Mai 2022. Ein Stablecoin, der nicht stabil war.',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    from: Date.UTC(2022, 4, 9),
    to: Date.UTC(2022, 4, 13),
    minutes: 15,
  },
  {
    key: 'bull21',
    name: 'Die Rakete',
    reveal: 'Bull Run, Januar bis Maerz 2021. Alles ging nur nach oben - bis es das nicht mehr tat.',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    from: Date.UTC(2021, 0, 1),
    to: Date.UTC(2021, 2, 1),
    minutes: 20,
  },
  {
    key: 'may21',
    name: 'Der Mittwoch',
    reveal: '19. Mai 2021. Ein einziger Handelstag, an dem 30 % verschwanden.',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    from: Date.UTC(2021, 4, 19),
    to: Date.UTC(2021, 4, 20),
    minutes: 10,
  },
];

export const SCENARIO_BY_KEY = new Map(SCENARIOS.map((scenario) => [scenario.key, scenario]));

interface LeagueReplay {
  candles: Map<string, Candle[]>;
  loadedAt: number;
}

export class ReplayStore {
  private readonly leagues = new Map<string, LeagueReplay>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(private readonly feed: MarketFeed) {}

  /** Waehlt ein Kerzenintervall, das den Zeitraum in ~600 Schritte teilt. */
  static intervalFor(from: number, to: number): { interval: string; ms: number } {
    const span = Math.max(60_000, to - from);
    const target = span / 600;

    const options: Array<[string, number]> = [
      ['1m', 60_000],
      ['3m', 180_000],
      ['5m', 300_000],
      ['15m', 900_000],
      ['1h', 3_600_000],
      ['4h', 14_400_000],
    ];

    for (const [interval, ms] of options) {
      if (ms >= target) return { interval, ms };
    }
    return { interval: '4h', ms: 14_400_000 };
  }

  async ensureLoaded(leagueId: string, symbols: string[], from: number, to: number): Promise<void> {
    if (this.leagues.has(leagueId)) return;

    const pending = this.loading.get(leagueId);
    if (pending) return pending;

    const task = (async () => {
      const { interval, ms } = ReplayStore.intervalFor(from, to);
      const candles = new Map<string, Candle[]>();

      for (const symbol of symbols) {
        const limit = Math.min(1_000, Math.ceil((to - from) / ms) + 2);
        const rows = await this.feed.fetchCandles(symbol, interval, limit, from, to);
        candles.set(symbol, rows);
      }

      this.leagues.set(leagueId, { candles, loadedAt: Date.now() });
      this.loading.delete(leagueId);
    })();

    this.loading.set(leagueId, task);
    return task;
  }

  isLoaded(leagueId: string): boolean {
    return this.leagues.has(leagueId);
  }

  forget(leagueId: string): void {
    this.leagues.delete(leagueId);
  }

  /** Kerzen bis zum aktuellen Stand der virtuellen Uhr. */
  candlesUpTo(leagueId: string, symbol: string, cursor: number): Candle[] {
    const replay = this.leagues.get(leagueId);
    const candles = replay?.candles.get(symbol);
    if (!candles) return [];

    const out: Candle[] = [];
    for (const candle of candles) {
      if (candle.t > cursor) break;
      out.push(candle);
    }
    return out;
  }

  /**
   * Kurs zum Zeitpunkt der virtuellen Uhr.
   *
   * Innerhalb einer Kerze wird zwischen Eroeffnung und Schluss interpoliert,
   * damit der Ticker fluessig laeuft statt einmal pro Kerze zu springen.
   */
  quoteAt(leagueId: string, symbol: string, cursor: number): Quote | null {
    const replay = this.leagues.get(leagueId);
    const candles = replay?.candles.get(symbol);
    if (!candles || candles.length === 0) return null;

    let current: Candle | null = null;
    let next: Candle | null = null;

    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i]!;
      if (candle.t > cursor) {
        next = candle;
        break;
      }
      current = candle;
    }

    if (!current) current = candles[0]!;

    const span = next ? next.t - current.t : 60_000;
    const progress = span > 0 ? Math.min(1, Math.max(0, (cursor - current.t) / span)) : 1;
    const value = current.o + (current.c - current.o) * progress;

    if (!Number.isFinite(value) || value <= 0) return null;

    const price = parsePrice(value.toFixed(8));
    const half = price / 5_000n; // 2 bp Spread

    return {
      bid: price - half > 0n ? price - half : price,
      ask: price + half,
      last: price,
      at: cursor,
    };
  }

  /** Ist der Zeitraum durchgelaufen? */
  isFinished(leagueId: string, symbol: string, cursor: number): boolean {
    const replay = this.leagues.get(leagueId);
    const candles = replay?.candles.get(symbol);
    if (!candles || candles.length === 0) return false;
    return cursor >= candles[candles.length - 1]!.t;
  }
}

/** Anonymer Anzeigename waehrend eines laufenden Szenarios. */
export function maskSymbol(symbols: string[], symbol: string): string {
  const index = symbols.indexOf(symbol);
  if (index < 0) return 'ASSET ?';
  return `ASSET ${String.fromCharCode(65 + index)}`;
}
