/**
 * Kennzahlen fuer die Auswertung.
 *
 * Hier - und nur hier - sind Fliesskommazahlen erlaubt: Sharpe Ratio und
 * Renditen sind Statistik, kein Geld. Ein Rundungsfehler in der 12. Stelle
 * aendert keine Kontostaende. Alles, was mit Cent zu tun hat, bleibt bigint.
 */

import { abs, type Cents } from './money.js';

export interface EquityPoint {
  at: number;
  equityCents: Cents;
}

export interface ClosedTrade {
  /** Realisierter Gewinn/Verlust nach Gebuehren. */
  pnlCents: Cents;
  openedAt: number;
  closedAt: number;
}

export interface PerformanceStats {
  startEquityCents: Cents;
  endEquityCents: Cents;
  totalPnlCents: Cents;
  /** Rendite in Basispunkten - so bleibt auch das eine Ganzzahl. */
  returnBps: bigint;
  /** Groesster Rueckgang vom Hoechststand, in Basispunkten. */
  maxDrawdownBps: bigint;
  maxDrawdownCents: Cents;
  trades: number;
  wins: number;
  losses: number;
  /** Trefferquote in Basispunkten (5000 = 50 %). */
  winRateBps: bigint;
  bestTradeCents: Cents;
  worstTradeCents: Cents;
  /** Summe der Gewinne geteilt durch Summe der Verluste. */
  profitFactor: number | null;
  sharpe: number | null;
  avgHoldMs: number | null;
}

/**
 * Maximaler Drawdown: der schmerzhafteste Rueckgang vom bisherigen
 * Hoechststand. Die ehrlichste Zahl im ganzen Spiel - sie zeigt, wie weit
 * jemand mit dem Konto unter Wasser war, bevor er wieder hochkam.
 */
export function maxDrawdown(curve: readonly EquityPoint[]): {
  bps: bigint;
  cents: Cents;
} {
  let peak: Cents | null = null;
  let worstCents: Cents = 0n;
  let worstBps = 0n;

  for (const point of curve) {
    if (peak === null || point.equityCents > peak) peak = point.equityCents;
    if (peak === null || peak <= 0n) continue;

    const drop = peak - point.equityCents;
    if (drop > worstCents) worstCents = drop;

    const dropBps = (drop * 10_000n) / peak;
    if (dropBps > worstBps) worstBps = dropBps;
  }

  return { bps: worstBps, cents: worstCents };
}

/**
 * Sharpe Ratio aus der Equity-Kurve: Rendite pro Einheit Schwankung.
 * Ohne Annualisierung - wir vergleichen Spieler innerhalb derselben Liga,
 * da wuerde ein Jahresfaktor nur eine Genauigkeit vortaeuschen, die es nicht gibt.
 */
export function sharpeRatio(curve: readonly EquityPoint[]): number | null {
  if (curve.length < 3) return null;

  const returns: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const previous = curve[i - 1]!.equityCents;
    const current = curve[i]!.equityCents;
    if (previous <= 0n) continue;
    returns.push(Number(current - previous) / Number(previous));
  }

  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) * (r - mean), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return null;
  return mean / stdDev;
}

export function computeStats(
  curve: readonly EquityPoint[],
  trades: readonly ClosedTrade[],
): PerformanceStats {
  const startEquityCents = curve[0]?.equityCents ?? 0n;
  const endEquityCents = curve[curve.length - 1]?.equityCents ?? startEquityCents;
  const totalPnlCents = endEquityCents - startEquityCents;

  const returnBps =
    startEquityCents > 0n ? (totalPnlCents * 10_000n) / startEquityCents : 0n;

  const drawdown = maxDrawdown(curve);

  let wins = 0;
  let losses = 0;
  let grossProfit = 0n;
  let grossLoss = 0n;
  let best: Cents = 0n;
  let worst: Cents = 0n;
  let holdSum = 0;

  for (const trade of trades) {
    if (trade.pnlCents > 0n) {
      wins += 1;
      grossProfit += trade.pnlCents;
    } else if (trade.pnlCents < 0n) {
      losses += 1;
      grossLoss += abs(trade.pnlCents);
    }
    if (trade.pnlCents > best) best = trade.pnlCents;
    if (trade.pnlCents < worst) worst = trade.pnlCents;
    holdSum += Math.max(0, trade.closedAt - trade.openedAt);
  }

  const decided = wins + losses;

  return {
    startEquityCents,
    endEquityCents,
    totalPnlCents,
    returnBps,
    maxDrawdownBps: drawdown.bps,
    maxDrawdownCents: drawdown.cents,
    trades: trades.length,
    wins,
    losses,
    winRateBps: decided > 0 ? (BigInt(wins) * 10_000n) / BigInt(decided) : 0n,
    bestTradeCents: best,
    worstTradeCents: worst,
    profitFactor: grossLoss > 0n ? Number(grossProfit) / Number(grossLoss) : null,
    sharpe: sharpeRatio(curve),
    avgHoldMs: trades.length > 0 ? holdSum / trades.length : null,
  };
}
