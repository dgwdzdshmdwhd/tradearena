/**
 * Der KI-Trader.
 *
 * Zwei Dinge sind hier wichtig, und beide sind Design-Entscheidungen, keine
 * technischen Zwaenge:
 *
 * 1. Der Bot bekommt KEINE Sonderrechte. Er sieht dieselben Kerzen wie du,
 *    zahlt dieselben Gebuehren, bekommt dieselbe Slippage. Er kann nicht in
 *    die Zukunft sehen. Seine Orders laufen durch exakt dieselbe Engine.
 *
 * 2. Er macht Fehler. Absichtlich. Ein fehlerfreier Bot waere entweder
 *    langweilig (er gewinnt immer) oder eine Luege (er kann es gar nicht).
 *    Die Fehlerquote sinkt mit dem Level, erreicht aber nie null - so wie
 *    bei einem menschlichen Trader auch.
 *
 * Alles ist deterministisch: gleicher Seed, gleiche Entscheidung. Damit kann
 * man jede Bot-Aktion im Nachhinein erklaeren, statt nur zu behaupten,
 * "die KI hat halt so entschieden".
 */

import {
  atr,
  changeBps,
  closes,
  rsi,
  sma,
  type Candle,
} from './indicators.js';
import { abs, applyBps, min, qtyFromNotional, type Cents, type Qty } from './money.js';
import { createRng, type Rng } from './random.js';
import type { PositionState, Quote } from './types.js';

export type BotStrategy = 'dca' | 'mean_reversion' | 'momentum' | 'grid' | 'scalper';

export type MistakeType =
  /** Kauft einer Kerze hinterher, die schon gelaufen ist. */
  | 'fomo'
  /** Wirft beim ersten roten Docht alles raus. */
  | 'panic'
  /** Vergisst den Stop-Loss. */
  | 'no_stop'
  /** Vertippt sich in der Ordergroesse. */
  | 'fat_finger'
  /** Handelt viel zu oft und verbrennt Gebuehren. */
  | 'overtrading'
  /** Haelt stur gegen den Trend, "das muss doch drehen". */
  | 'stubborn';

export interface BotParams {
  /** Mindestabstand zwischen zwei Aktionen. */
  intervalMs: number;
  /** Ordergroesse als Anteil des Budgets, in Basispunkten. */
  tradeSizeBps: number;
  /** Stop-Loss-Abstand in Basispunkten (0 = keiner). */
  stopLossBps: number;
  /** Take-Profit-Abstand in Basispunkten (0 = keiner). */
  takeProfitBps: number;
}

export interface BotConfig {
  strategy: BotStrategy;
  params: BotParams;
  /** Fehlerwahrscheinlichkeit je Entscheidung, in Basispunkten. */
  errorRateBps: number;
  level: number;
  /** Basis fuer den Zufallsgenerator - z. B. die Bot-ID. */
  seed: number;
}

export interface BotView {
  now: number;
  candles: readonly Candle[];
  quote: Quote;
  position: PositionState;
  /** Gesamtes dem Bot zugeteiltes Kapital. */
  budgetCents: Cents;
  /** Davon aktuell frei verfuegbar. */
  availableCents: Cents;
  lastActionAt: number | null;
}

export interface BotIntent {
  action: 'buy' | 'sell' | 'hold';
  qty: Qty;
  /** Klartext fuer den Feed und das Bot-Protokoll. */
  reason: string;
  mistake: MistakeType | null;
  /** Stop-Loss, der an die Position gehaengt werden soll. */
  attachStopBps: number | null;
  attachTakeProfitBps: number | null;
}

export const DEFAULT_BOT_PARAMS: Record<BotStrategy, BotParams> = {
  dca: { intervalMs: 15 * 60_000, tradeSizeBps: 1_000, stopLossBps: 0, takeProfitBps: 0 },
  mean_reversion: {
    intervalMs: 3 * 60_000,
    tradeSizeBps: 2_500,
    stopLossBps: 400,
    takeProfitBps: 600,
  },
  momentum: { intervalMs: 2 * 60_000, tradeSizeBps: 3_000, stopLossBps: 300, takeProfitBps: 900 },
  grid: { intervalMs: 60_000, tradeSizeBps: 1_200, stopLossBps: 0, takeProfitBps: 250 },
  scalper: { intervalMs: 30_000, tradeSizeBps: 800, stopLossBps: 150, takeProfitBps: 200 },
};

export const STRATEGY_LABELS: Record<BotStrategy, string> = {
  dca: 'DCA',
  mean_reversion: 'Mean Reversion',
  momentum: 'Momentum',
  grid: 'Grid',
  scalper: 'Scalper',
};

/**
 * Fehlerquote nach Level.
 * Level 1: 18 % - der Bot ist ein Praktikant.
 * Level 10: 4 % - erfahren, aber immer noch Mensch genug fuer Fehler.
 */
export function errorRateForLevel(level: number): number {
  const clamped = Math.max(1, Math.min(10, Math.trunc(level)));
  return Math.max(400, 1_800 - (clamped - 1) * 156);
}

/** XP-Schwelle fuer das naechste Level. */
export function xpForLevel(level: number): number {
  return Math.round(100 * Math.pow(1.6, Math.max(0, level - 1)));
}

export function decide(config: BotConfig, view: BotView): BotIntent {
  const rng = createRng(config.seed + Math.floor(view.now / 1_000));

  const cooldownOver =
    view.lastActionAt === null || view.now - view.lastActionAt >= config.params.intervalMs;

  const base = cooldownOver
    ? strategySignal(config, view)
    : { action: 'hold' as const, reason: 'Wartet auf den naechsten Takt.' };

  return applyMistakes(config, view, base, rng, cooldownOver);
}

interface BaseSignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
}

function strategySignal(config: BotConfig, view: BotView): BaseSignal {
  const values = closes(view.candles);
  if (values.length < 30) {
    return { action: 'hold', reason: 'Zu wenig Kursdaten, wartet ab.' };
  }

  const holding = view.position.qty > 0n;

  switch (config.strategy) {
    case 'dca':
      return holding && view.availableCents < view.budgetCents / 10n
        ? { action: 'hold', reason: 'Budget ausgereizt, spart wieder an.' }
        : { action: 'buy', reason: 'DCA: kauft stur die naechste Rate.' };

    case 'mean_reversion': {
      const rsiSeries = rsi(values, 14);
      const current = rsiSeries[rsiSeries.length - 1];
      if (current === null || current === undefined) {
        return { action: 'hold', reason: 'RSI noch nicht berechenbar.' };
      }
      if (current < 30) {
        return { action: 'buy', reason: `RSI bei ${current.toFixed(0)} - ueberverkauft, kauft.` };
      }
      if (current > 70 && holding) {
        return { action: 'sell', reason: `RSI bei ${current.toFixed(0)} - ueberkauft, nimmt mit.` };
      }
      return { action: 'hold', reason: `RSI bei ${current.toFixed(0)} - neutral.` };
    }

    case 'momentum': {
      const fast = sma(values, 10);
      const slow = sma(values, 30);
      const fastNow = fast[fast.length - 1];
      const slowNow = slow[slow.length - 1];
      if (fastNow == null || slowNow == null) {
        return { action: 'hold', reason: 'Trend noch unklar.' };
      }
      if (fastNow > slowNow * 1.001) {
        return { action: 'buy', reason: 'SMA10 ueber SMA30 - Trend laeuft, springt auf.' };
      }
      if (fastNow < slowNow && holding) {
        return { action: 'sell', reason: 'Trend gebrochen, steigt aus.' };
      }
      return { action: 'hold', reason: 'Kein klarer Trend.' };
    }

    case 'grid': {
      const range = atr(view.candles, 14);
      const last = values[values.length - 1]!;
      const anchor = sma(values, 20)[values.length - 1];
      if (range === null || anchor == null) {
        return { action: 'hold', reason: 'Netz noch nicht gespannt.' };
      }
      if (last < anchor - range) {
        return { action: 'buy', reason: 'Unteres Gitternetz getroffen.' };
      }
      if (last > anchor + range && holding) {
        return { action: 'sell', reason: 'Oberes Gitternetz getroffen.' };
      }
      return { action: 'hold', reason: 'Kurs mitten im Netz.' };
    }

    case 'scalper': {
      const move = changeBps(view.candles, 1);
      if (move < -40) return { action: 'buy', reason: 'Kurzer Dip, greift zu.' };
      if (move > 40 && holding) return { action: 'sell', reason: 'Kleiner Schub, nimmt mit.' };
      return { action: 'hold', reason: 'Nichts zu holen gerade.' };
    }
  }
}

function applyMistakes(
  config: BotConfig,
  view: BotView,
  base: BaseSignal,
  rng: Rng,
  cooldownOver: boolean,
): BotIntent {
  const probability = Math.max(0, config.errorRateBps) / 10_000;
  const holding = view.position.qty > 0n;
  const move = changeBps(view.candles, 3);

  let action = base.action;
  let reason = base.reason;
  let mistake: MistakeType | null = null;
  let sizeMultiplier = 1;
  let stopBps: number | null = config.params.stopLossBps > 0 ? config.params.stopLossBps : null;

  if (rng.chance(probability)) {
    const options = availableMistakes(action, holding, move, cooldownOver);
    if (options.length > 0) {
      mistake = rng.pick(options);

      switch (mistake) {
        case 'fomo':
          action = 'buy';
          reason = `FOMO: kauft nach +${(move / 100).toFixed(1)} % hinterher.`;
          break;
        case 'panic':
          action = 'sell';
          reason = `Panik: wirft bei ${(move / 100).toFixed(1)} % alles raus.`;
          break;
        case 'no_stop':
          stopBps = null;
          reason = `${reason} (Stop-Loss vergessen.)`;
          break;
        case 'fat_finger':
          sizeMultiplier = 5;
          reason = `${reason} (Ordergroesse vertippt.)`;
          break;
        case 'overtrading':
          if (action === 'hold') action = holding ? 'sell' : 'buy';
          reason = 'Overtrading: handelt ohne echten Grund.';
          break;
        case 'stubborn':
          action = 'hold';
          reason = 'Sturheit: haelt gegen den Trend, "das dreht schon noch".';
          break;
      }
    }
  }

  if (action === 'hold') {
    return {
      action: 'hold',
      qty: 0n,
      reason,
      mistake,
      attachStopBps: null,
      attachTakeProfitBps: null,
    };
  }

  const qty = sizeFor(config, view, action, sizeMultiplier);
  if (qty <= 0n) {
    return {
      action: 'hold',
      qty: 0n,
      reason: action === 'buy' ? 'Kein Budget mehr frei.' : 'Nichts zu verkaufen.',
      mistake,
      attachStopBps: null,
      attachTakeProfitBps: null,
    };
  }

  return {
    action,
    qty,
    reason,
    mistake,
    attachStopBps: action === 'buy' ? stopBps : null,
    attachTakeProfitBps:
      action === 'buy' && config.params.takeProfitBps > 0 ? config.params.takeProfitBps : null,
  };
}

function availableMistakes(
  action: 'buy' | 'sell' | 'hold',
  holding: boolean,
  moveBps: number,
  cooldownOver: boolean,
): MistakeType[] {
  const options: MistakeType[] = [];

  if (moveBps > 300) options.push('fomo');
  if (holding && moveBps < -120) options.push('panic');
  if (action === 'buy') {
    options.push('no_stop', 'fat_finger');
  }
  if (!cooldownOver) options.push('overtrading');
  if (action === 'sell') options.push('stubborn');

  return options;
}

function sizeFor(
  config: BotConfig,
  view: BotView,
  action: 'buy' | 'sell',
  multiplier: number,
): Qty {
  if (action === 'sell') {
    const held = abs(view.position.qty);
    if (held <= 0n) return 0n;
    // Beim Verkauf nie mehr als vorhanden - auch ein Fat Finger kann keine
    // Token erfinden, die es nicht gibt.
    const portion = (held * BigInt(Math.min(10_000, config.params.tradeSizeBps * multiplier))) / 10_000n;
    return portion > 0n ? min(portion, held) : held;
  }

  const wanted = applyBps(view.budgetCents, config.params.tradeSizeBps * multiplier, 'floor');
  const spend = min(wanted, view.availableCents);
  if (spend <= 0n) return 0n;

  return qtyFromNotional(spend, view.quote.ask, 'floor');
}

/** Menschlich klingende Namen fuer neue Bots. */
export const BOT_NAMES = [
  'BENDER',
  'HAL',
  'MARVIN',
  'GLaDOS',
  'ROBOKOP',
  'CLIPPY',
  'SKYNET JR',
  'DEEP POCKET',
  'ALGO ANDI',
  'BLECHTRADER',
] as const;
