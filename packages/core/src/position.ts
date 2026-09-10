import { abs, divRound, notionalCents, sign, type Cents, type Price, type Qty } from './money.js';
import type { PositionState, PositionSide, Side } from './types.js';

export interface ApplyFillResult {
  position: PositionState;
  /** In diesem Fill realisierter Gewinn/Verlust, OHNE Gebuehren. */
  realizedCents: Cents;
  /** Wie viel bestehende Position geschlossen wurde. */
  closedQty: Qty;
  /** Wie viel neue Position eroeffnet wurde. */
  openedQty: Qty;
}

/**
 * Ein Fill auf eine Position anwenden.
 *
 * Deckt alle vier Faelle ab, und der vierte ist der, den Simulatoren gern
 * falsch machen:
 *   1. Neue Position eroeffnen
 *   2. Bestehende Position aufstocken (Durchschnittseinstand neu berechnen)
 *   3. Teilweise oder ganz schliessen (Gewinn/Verlust realisieren)
 *   4. Umdrehen: mehr verkaufen als man hat -> Rest wird zur Short-Position,
 *      und zwar mit dem AKTUELLEN Preis als neuem Einstand, nicht mit dem alten
 *
 * `position.qty` ist vorzeichenbehaftet: positiv = long, negativ = short.
 */
export function applyFillToPosition(
  position: PositionState,
  side: Side,
  qty: Qty,
  price: Price,
): ApplyFillResult {
  if (qty <= 0n) throw new RangeError('applyFillToPosition: Menge muss positiv sein');

  const delta: Qty = side === 'buy' ? qty : -qty;

  // Fall 1: bisher flach.
  if (position.qty === 0n) {
    return {
      position: { qty: delta, avgEntry: price, realizedPnlCents: position.realizedPnlCents },
      realizedCents: 0n,
      closedQty: 0n,
      openedQty: qty,
    };
  }

  // Fall 2: gleiche Richtung -> Durchschnittseinstand gewichtet neu berechnen.
  if (sign(position.qty) === sign(delta)) {
    const oldQty = abs(position.qty);
    const addQty = abs(delta);
    const avgEntry = divRound(
      position.avgEntry * oldQty + price * addQty,
      oldQty + addQty,
      'half_up',
    );

    return {
      position: {
        qty: position.qty + delta,
        avgEntry,
        realizedPnlCents: position.realizedPnlCents,
      },
      realizedCents: 0n,
      closedQty: 0n,
      openedQty: addQty,
    };
  }

  // Fall 3 und 4: Gegenrichtung -> erst schliessen, ggf. dann umdrehen.
  const openQty = abs(position.qty);
  const incomingQty = abs(delta);
  const closedQty = openQty < incomingQty ? openQty : incomingQty;

  const wasLong = position.qty > 0n;
  const priceDiff = wasLong ? price - position.avgEntry : position.avgEntry - price;
  const realizedCents = notionalCents(priceDiff, closedQty, 'half_up');

  const remaining = incomingQty - closedQty;
  const newRealized = position.realizedPnlCents + realizedCents;

  if (remaining === 0n) {
    const newQty = position.qty + delta;
    return {
      position: {
        qty: newQty,
        avgEntry: newQty === 0n ? 0n : position.avgEntry,
        realizedPnlCents: newRealized,
      },
      realizedCents,
      closedQty,
      openedQty: 0n,
    };
  }

  // Fall 4: umgedreht. Der Rest eroeffnet eine Gegenposition zum aktuellen Preis.
  return {
    position: {
      qty: sign(delta) * remaining,
      avgEntry: price,
      realizedPnlCents: newRealized,
    },
    realizedCents,
    closedQty,
    openedQty: remaining,
  };
}

/** Nicht realisierter Gewinn/Verlust zum aktuellen Kurs. */
export function unrealizedPnlCents(position: PositionState, mark: Price): Cents {
  if (position.qty === 0n) return 0n;
  const priceDiff = position.qty > 0n ? mark - position.avgEntry : position.avgEntry - mark;
  return notionalCents(priceDiff, abs(position.qty), 'half_up');
}

/** Marktwert der Position, vorzeichenbehaftet (Shorts sind eine Verbindlichkeit). */
export function positionValueCents(position: PositionState, mark: Price): Cents {
  return notionalCents(mark, position.qty, 'half_up');
}

/** Betragsmaessiges Engagement - Grundlage fuer Margin und Hebel. */
export function exposureCents(position: PositionState, mark: Price): Cents {
  return notionalCents(mark, abs(position.qty), 'half_up');
}

export function positionSide(position: PositionState): PositionSide | 'flat' {
  if (position.qty > 0n) return 'long';
  if (position.qty < 0n) return 'short';
  return 'flat';
}

/**
 * Kontowert (Equity) = Bargeld + Marktwert aller Positionen.
 *
 * Fuer Shorts ist der Marktwert negativ: der Verkaufserloes liegt bereits als
 * Bargeld auf dem Konto, die Rueckkaufpflicht zieht ihn wieder ab. Genau so
 * bleibt die Equity direkt nach dem Eroeffnen unveraendert (bis auf Gebuehren).
 */
export function accountEquityCents(
  cashCents: Cents,
  positions: Iterable<{ position: PositionState; mark: Price }>,
): Cents {
  let equity = cashCents;
  for (const entry of positions) {
    equity += positionValueCents(entry.position, entry.mark);
  }
  return equity;
}
