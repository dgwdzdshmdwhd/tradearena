import { BPS, abs, applyBps, divRound, isqrt, type Cents, type Price } from './money.js';
import type { Side, SlippageConfig } from './types.js';

/** Volatilitaet, die als "normal" gilt: 100 bps = 1 %. */
export const BASE_VOL_BPS = 100n;

/** Zwischenskala fuer die Wurzel, damit wir ohne Fliesskomma auskommen. */
const SQRT_SCALE = 1_000_000n;

/**
 * Wie weit laeuft mir der Kurs beim Ausfuehren weg?
 *
 *     impact = factorBps * sqrt(volumen / referenztiefe) * (vola / normalvola)
 *
 * Die Wurzel sorgt fuer das Verhalten, das man aus echten Maerkten kennt:
 * die doppelte Ordergroesse kostet nicht das Doppelte an Slippage, sondern
 * das 1,41-Fache. Kleine Orders spuert man kaum, richtig grosse tun weh -
 * und in einem volatilen Markt tun sie deutlich mehr weh.
 *
 * `volBps` ist die aktuelle Volatilitaet in Basispunkten (z. B. ATR der
 * letzten 20 Minutenkerzen relativ zum Kurs).
 */
export function slippageBps(
  grossCents: Cents,
  volBps: number | bigint,
  config: SlippageConfig,
): bigint {
  if (config.factorBps <= 0) return 0n;
  if (config.refDepthCents <= 0n) return 0n;

  const notional = abs(grossCents);
  if (notional === 0n) return 0n;

  // sqrt(notional / refDepth) * SQRT_SCALE, komplett in Ganzzahlen gerechnet.
  const scaledRatio = (notional * SQRT_SCALE * SQRT_SCALE) / config.refDepthCents;
  const sqrtScaled = isqrt(scaledRatio);

  const vol = BigInt(volBps) < 0n ? 0n : BigInt(volBps);
  const impact =
    (BigInt(config.factorBps) * sqrtScaled * vol) / (SQRT_SCALE * BASE_VOL_BPS);

  return impact;
}

/**
 * Slippage auf den Ausfuehrungspreis anwenden - immer zu Ungunsten des
 * Spielers: beim Kauf teurer, beim Verkauf billiger.
 */
export function applySlippageToPrice(price: Price, side: Side, bps: bigint): Price {
  if (bps <= 0n) return price;

  const delta = applyBps(price, bps, 'ceil');
  if (side === 'buy') return price + delta;

  const worse = price - delta;
  // Ein Preis von 0 oder darunter waere Unsinn; ein Restwert bleibt immer.
  return worse > 0n ? worse : divRound(price, BPS, 'ceil');
}
