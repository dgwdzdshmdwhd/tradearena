/**
 * Wann wird eine liegende Order ausgeloest - und zu welchem Preis?
 *
 * Alles hier ist eine reine Funktion des aktuellen Kurses. Der Worker ruft
 * `evaluateOrder` bei jedem Tick fuer jede offene Order auf und fuehrt aus,
 * was zurueckkommt. Kein Zustand, keine Ueberraschungen, voll testbar.
 */

import { applyBps, max, min, type Price, type Qty } from './money.js';
import type { Liquidity, OrderType, Quote, Side, TimeInForce } from './types.js';

export interface OpenOrder {
  id: string;
  side: Side;
  type: OrderType;
  qty: Qty;
  filledQty: Qty;
  limitPrice: Price | null;
  stopPrice: Price | null;
  /** Abstand fuer Trailing Stops in Basispunkten (z. B. 300 = 3 %). */
  trailBps: number | null;
  /** Bester bisher gesehener Kurs seit Aktivierung - der "Anker". */
  trailAnchor: Price | null;
  tif: TimeInForce;
  /** Wurde die Stop-Schwelle schon beruehrt? */
  triggered: boolean;
  createdAt: number;
  /** Orders derselben OCO-Gruppe stornieren sich gegenseitig. */
  ocoGroup: string | null;
  /** Darf nur bestehende Positionen verkleinern (Take-Profit / Stop-Loss). */
  reduceOnly: boolean;
}

export interface OrderDecision {
  /** Stop-Schwelle wurde beruehrt, die Order ist jetzt scharf. */
  trigger?: boolean;
  /** Neuer Anker fuer Trailing Stops. */
  trailAnchor?: Price;
  /** Ausfuehren - zu diesem Preis. */
  fill?: { price: Price; qty: Qty; liquidity: Liquidity };
  /** Verfallen (Day-Order nach Handelsschluss). */
  expire?: boolean;
}

export interface EvaluationContext {
  quote: Quote;
  now: number;
  /**
   * Beginn des aktuellen Handelstages als Zeitstempel. Day-Orders, die davor
   * erstellt wurden, verfallen. Fuer Krypto ist das 00:00 UTC.
   */
  sessionStart: number;
  /**
   * Bei einer Kursluecke der Eroeffnungskurs. Ist er gesetzt, fuellen
   * ausgeloeste Stops zu DIESEM Preis - nicht zum Stop-Preis. Genau das
   * kostet in echt Geld: der Stop ist ein Ausloeser, keine Garantie.
   */
  gapOpenPrice?: Price;
}

export function remainingQty(order: OpenOrder): Qty {
  const rest = order.qty - order.filledQty;
  return rest > 0n ? rest : 0n;
}

export function evaluateOrder(order: OpenOrder, ctx: EvaluationContext): OrderDecision {
  const rest = remainingQty(order);
  if (rest <= 0n) return {};

  // Day-Orders ueberleben den Handelstag nicht.
  if (order.tif === 'day' && order.createdAt < ctx.sessionStart) {
    return { expire: true };
  }

  switch (order.type) {
    case 'market':
      return {
        fill: {
          price: ctx.gapOpenPrice ?? marketPrice(ctx.quote, order.side),
          qty: rest,
          liquidity: 'taker',
        },
      };

    case 'limit':
      return evaluateLimit(order, rest, ctx);

    case 'stop':
      return evaluateStop(order, rest, ctx, 'market');

    case 'stop_limit':
      return evaluateStop(order, rest, ctx, 'limit');

    case 'trailing_stop':
      return evaluateTrailing(order, rest, ctx);
  }
}

function marketPrice(quote: Quote, side: Side): Price {
  return side === 'buy' ? quote.ask : quote.bid;
}

/**
 * Limit-Order: fuellt nur zum Limit oder besser.
 * Der Kaeufer bekommt eine eventuelle Preisverbesserung geschenkt - so
 * machen es echte Boersen auch.
 */
function evaluateLimit(order: OpenOrder, rest: Qty, ctx: EvaluationContext): OrderDecision {
  const limit = order.limitPrice;
  if (limit === null) return {};

  if (order.side === 'buy') {
    if (ctx.quote.ask > limit) return {};
    return { fill: { price: min(limit, ctx.quote.ask), qty: rest, liquidity: 'maker' } };
  }

  if (ctx.quote.bid < limit) return {};
  return { fill: { price: max(limit, ctx.quote.bid), qty: rest, liquidity: 'maker' } };
}

/**
 * Stop-Order: die Schwelle macht die Order scharf, ausgefuehrt wird zum
 * aktuellen Marktpreis. Bei einer Kursluecke ist das schlechter als der
 * Stop-Preis - und genau so ist es in echt.
 */
function evaluateStop(
  order: OpenOrder,
  rest: Qty,
  ctx: EvaluationContext,
  after: 'market' | 'limit',
): OrderDecision {
  if (!order.triggered) {
    const stop = order.stopPrice;
    if (stop === null) return {};

    const touched =
      order.side === 'buy' ? ctx.quote.ask >= stop : ctx.quote.bid <= stop;
    if (!touched) return {};

    if (after === 'limit') {
      // Wird zur Limit-Order und wartet ab jetzt auf sein Limit.
      return { trigger: true };
    }

    return {
      trigger: true,
      fill: {
        price: ctx.gapOpenPrice ?? marketPrice(ctx.quote, order.side),
        qty: rest,
        liquidity: 'taker',
      },
    };
  }

  // Bereits ausgeloest: ein Stop-Limit verhaelt sich jetzt wie eine Limit-Order.
  if (after === 'limit') return evaluateLimit(order, rest, ctx);

  return {
    fill: {
      price: ctx.gapOpenPrice ?? marketPrice(ctx.quote, order.side),
      qty: rest,
      liquidity: 'taker',
    },
  };
}

/**
 * Trailing Stop: laeuft dem Kurs hinterher, aber nie zurueck.
 * Bei einer Verkaufsorder merkt er sich den hoechsten Kurs und loest aus,
 * wenn der Kurs um `trailBps` darunter faellt. Steigt der Kurs weiter, zieht
 * der Stop nach - faellt er, bleibt der Stop stehen.
 */
function evaluateTrailing(order: OpenOrder, rest: Qty, ctx: EvaluationContext): OrderDecision {
  if (order.trailBps === null) return {};

  const reference = order.side === 'sell' ? ctx.quote.bid : ctx.quote.ask;
  const anchor = order.trailAnchor;

  if (anchor === null) {
    return { trailAnchor: reference };
  }

  if (order.side === 'sell') {
    if (reference > anchor) return { trailAnchor: reference };

    const stop = anchor - applyBps(anchor, order.trailBps, 'floor');
    if (reference > stop) return {};

    return {
      trigger: true,
      fill: { price: ctx.gapOpenPrice ?? ctx.quote.bid, qty: rest, liquidity: 'taker' },
    };
  }

  // Kaufseitiger Trailing Stop: folgt dem Kurs nach unten.
  if (reference < anchor) return { trailAnchor: reference };

  const stop = anchor + applyBps(anchor, order.trailBps, 'ceil');
  if (reference < stop) return {};

  return {
    trigger: true,
    fill: { price: ctx.gapOpenPrice ?? ctx.quote.ask, qty: rest, liquidity: 'taker' },
  };
}

/** Aktueller Ausloesepreis eines Trailing Stops - fuer die Anzeige im UI. */
export function trailingStopPrice(order: OpenOrder): Price | null {
  if (order.trailBps === null || order.trailAnchor === null) return null;
  return order.side === 'sell'
    ? order.trailAnchor - applyBps(order.trailAnchor, order.trailBps, 'floor')
    : order.trailAnchor + applyBps(order.trailAnchor, order.trailBps, 'ceil');
}

/** Beginn des Krypto-Handelstages (00:00 UTC) fuer Day-Orders. */
export function cryptoSessionStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
