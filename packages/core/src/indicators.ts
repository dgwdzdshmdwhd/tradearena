/**
 * Indikatoren fuer Charts und Bot-Signale.
 *
 * Hier sind Fliesskommazahlen bewusst erlaubt: ein RSI ist ein Signal, kein
 * Kontostand. Es fliesst kein Geld durch diese Datei.
 */

export interface Candle {
  /** Startzeit der Kerze in Unix-Millisekunden. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function sma(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }

  return out;
}

export function ema(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  const k = 2 / (period + 1);
  let previous: number | null = null;
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!;
    sum += value;

    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      previous = sum / period;
      out.push(previous);
      continue;
    }

    previous = value * k + (previous as number) * (1 - k);
    out.push(previous);
  }

  return out;
}

/** Relative Strength Index nach Wilder. 0-100, unter 30 "ueberverkauft". */
export function rsi(values: readonly number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }

  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range - unser Mass fuer "wie wild geht es gerade zu". */
export function atr(candles: readonly Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const current = candles[i]!;
    const previous = candles[i - 1]!;
    const trueRange = Math.max(
      current.h - current.l,
      Math.abs(current.h - previous.c),
      Math.abs(current.l - previous.c),
    );
    sum += trueRange;
  }

  return sum / period;
}

/**
 * Volatilitaet in Basispunkten, wie sie das Slippage-Modell erwartet:
 * ATR im Verhaeltnis zum aktuellen Kurs.
 */
export function volatilityBps(candles: readonly Candle[], period = 20): number {
  const range = atr(candles, period);
  const last = candles[candles.length - 1]?.c;
  if (range === null || last === undefined || last <= 0) return 100;

  const bps = Math.round((range / last) * 10_000);
  return Math.min(5_000, Math.max(1, bps));
}

/** Prozentuale Veraenderung der letzten `lookback` Kerzen, in Basispunkten. */
export function changeBps(candles: readonly Candle[], lookback = 1): number {
  if (candles.length <= lookback) return 0;
  const now = candles[candles.length - 1]!.c;
  const before = candles[candles.length - 1 - lookback]!.c;
  if (before <= 0) return 0;
  return Math.round(((now - before) / before) * 10_000);
}

export function closes(candles: readonly Candle[]): number[] {
  return candles.map((candle) => candle.c);
}
