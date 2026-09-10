import { abs, applyBps, type Cents } from './money.js';
import type { FeeConfig, Liquidity } from './types.js';

/**
 * Gebuehr fuer einen Trade.
 *
 * Immer AUFGERUNDET, also zu Lasten des Spielers. Echte Broker machen es
 * genauso, und es verhindert, dass jemand mit Mikro-Orders systematisch
 * Bruchteile von Cents gewinnt.
 */
export function computeFeeCents(
  grossCents: Cents,
  config: FeeConfig,
  liquidity: Liquidity = 'taker',
): Cents {
  const bps = liquidity === 'maker' ? config.makerBps : config.takerBps;
  const variable = applyBps(abs(grossCents), bps, 'ceil');
  const total = variable + config.fixedCents;
  return total < 0n ? 0n : total;
}
