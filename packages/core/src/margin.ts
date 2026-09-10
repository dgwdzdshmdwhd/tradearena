/**
 * Hebel, Margin Call und Zwangsliquidation.
 *
 * Ohne Hebel (maxLeverage = 1) ist das alles trivial: man kann nur ausgeben,
 * was man hat. Mit Hebel wird es interessant - und gefaehrlich. Der Worker
 * prueft diese Funktionen bei JEDEM Tick, nicht nur wenn jemand handelt.
 * Sonst wacht man morgens mit einem Konto auf, das schon gestern Nacht
 * haette liquidiert werden muessen.
 */

import { BPS, divRound, type Cents } from './money.js';

export interface MarginSnapshot {
  /** Bargeld plus Marktwert aller Positionen. */
  equityCents: Cents;
  /** Summe der absoluten Positionswerte. */
  exposureCents: Cents;
  maxLeverage: number;
  maintenanceMarginBps: number;
}

export interface MarginState {
  /** Gebundene Sicherheit fuer die offenen Positionen. */
  usedMarginCents: Cents;
  /** Wie viel Sicherheit mindestens vorhanden sein muss. */
  maintenanceRequiredCents: Cents;
  /** Wie viel neues Engagement noch moeglich ist. */
  buyingPowerCents: Cents;
  /**
   * Verhaeltnis Equity zu Mindestsicherheit in Basispunkten.
   * 10_000 = exakt an der Grenze, darunter wird liquidiert.
   */
  marginLevelBps: bigint;
  marginCall: boolean;
  liquidate: boolean;
}

/** Warnschwelle: ab hier blinkt im UI die Margin-Call-Warnung. */
export const MARGIN_CALL_LEVEL_BPS = 12_000n;

export function computeMargin(snapshot: MarginSnapshot): MarginState {
  const leverage = BigInt(Math.max(1, Math.trunc(snapshot.maxLeverage)));

  const usedMarginCents = divRound(snapshot.exposureCents, leverage, 'ceil');
  const maintenanceRequiredCents = divRound(
    snapshot.exposureCents * BigInt(snapshot.maintenanceMarginBps),
    BPS,
    'ceil',
  );

  const maxExposure = snapshot.equityCents * leverage;
  const rawBuyingPower = maxExposure - snapshot.exposureCents;
  const buyingPowerCents = rawBuyingPower > 0n ? rawBuyingPower : 0n;

  // Ohne offene Positionen gibt es nichts zu liquidieren.
  if (maintenanceRequiredCents <= 0n) {
    return {
      usedMarginCents,
      maintenanceRequiredCents,
      buyingPowerCents,
      marginLevelBps: BPS * 100n,
      marginCall: false,
      liquidate: false,
    };
  }

  const marginLevelBps = (snapshot.equityCents * BPS) / maintenanceRequiredCents;

  return {
    usedMarginCents,
    maintenanceRequiredCents,
    buyingPowerCents,
    marginLevelBps,
    marginCall: marginLevelBps < MARGIN_CALL_LEVEL_BPS,
    liquidate: marginLevelBps < BPS,
  };
}

export interface LiquidationCandidate {
  instrumentId: string;
  exposureCents: Cents;
  unrealizedPnlCents: Cents;
}

/**
 * Welche Position fliegt zuerst raus?
 *
 * Die groesste - sie bindet am meisten Sicherheit und bringt das Konto mit
 * einem Schlag am weitesten aus der Gefahrenzone. Bei Gleichstand die mit dem
 * groessten Verlust.
 */
export function chooseLiquidation(
  candidates: readonly LiquidationCandidate[],
): LiquidationCandidate | null {
  let worst: LiquidationCandidate | null = null;

  for (const candidate of candidates) {
    if (candidate.exposureCents <= 0n) continue;
    if (worst === null) {
      worst = candidate;
      continue;
    }
    if (candidate.exposureCents > worst.exposureCents) {
      worst = candidate;
    } else if (
      candidate.exposureCents === worst.exposureCents &&
      candidate.unrealizedPnlCents < worst.unrealizedPnlCents
    ) {
      worst = candidate;
    }
  }

  return worst;
}

/**
 * Taegliche Leihgebuehr fuer eine Short-Position, anteilig fuer den
 * vergangenen Zeitraum. Shorts sind nicht gratis - wer eine Aktie leiht,
 * zahlt dafuer.
 */
export function borrowFeeCents(
  exposureCents: Cents,
  bpsPerDay: number,
  elapsedMs: number,
): Cents {
  if (exposureCents <= 0n || bpsPerDay <= 0 || elapsedMs <= 0) return 0n;

  const perDay = divRound(exposureCents * BigInt(bpsPerDay), BPS, 'ceil');
  return divRound(perDay * BigInt(Math.trunc(elapsedMs)), 86_400_000n, 'ceil');
}
