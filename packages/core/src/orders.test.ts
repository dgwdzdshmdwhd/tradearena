import { describe, expect, it } from 'vitest';

import { parsePrice, parseQty } from './money.js';
import {
  cryptoSessionStart,
  evaluateOrder,
  remainingQty,
  trailingStopPrice,
  type EvaluationContext,
  type OpenOrder,
} from './orders.js';
import type { Quote } from './types.js';

const quote = (bid: string, ask: string): Quote => ({
  bid: parsePrice(bid),
  ask: parsePrice(ask),
  last: parsePrice(bid),
  at: 0,
});

const ctx = (q: Quote, extra: Partial<EvaluationContext> = {}): EvaluationContext => ({
  quote: q,
  now: 1_000_000,
  sessionStart: 0,
  ...extra,
});

const order = (overrides: Partial<OpenOrder>): OpenOrder => ({
  id: 'o1',
  side: 'buy',
  type: 'limit',
  qty: parseQty('1'),
  filledQty: 0n,
  limitPrice: null,
  stopPrice: null,
  trailBps: null,
  trailAnchor: null,
  tif: 'gtc',
  triggered: false,
  createdAt: 500_000,
  ocoGroup: null,
  reduceOnly: false,
  ...overrides,
});

describe('Limit-Orders', () => {
  it('fuellt nicht, solange der Kurs zu hoch ist', () => {
    const decision = evaluateOrder(
      order({ side: 'buy', limitPrice: parsePrice('90') }),
      ctx(quote('100', '100.1')),
    );

    expect(decision.fill).toBeUndefined();
  });

  it('fuellt, sobald das Limit erreicht ist', () => {
    const decision = evaluateOrder(
      order({ side: 'buy', limitPrice: parsePrice('100') }),
      ctx(quote('99.8', '99.9')),
    );

    expect(decision.fill?.price).toBe(parsePrice('99.9'));
    expect(decision.fill?.liquidity).toBe('maker');
  });

  it('schenkt dem Kaeufer die Preisverbesserung', () => {
    // Limit 100, Markt bei 95: gefuellt wird zu 95, nicht zu 100.
    const decision = evaluateOrder(
      order({ side: 'buy', limitPrice: parsePrice('100') }),
      ctx(quote('94.9', '95')),
    );

    expect(decision.fill?.price).toBe(parsePrice('95'));
  });

  it('funktioniert spiegelbildlich beim Verkauf', () => {
    const tooLow = evaluateOrder(
      order({ side: 'sell', limitPrice: parsePrice('110') }),
      ctx(quote('100', '100.1')),
    );
    expect(tooLow.fill).toBeUndefined();

    const hit = evaluateOrder(
      order({ side: 'sell', limitPrice: parsePrice('110') }),
      ctx(quote('115', '115.1')),
    );
    expect(hit.fill?.price).toBe(parsePrice('115'));
  });
});

describe('Stop-Orders', () => {
  it('bleibt ruhig, solange die Schwelle nicht beruehrt wird', () => {
    const decision = evaluateOrder(
      order({ side: 'sell', type: 'stop', stopPrice: parsePrice('90') }),
      ctx(quote('100', '100.1')),
    );

    expect(decision.trigger).toBeUndefined();
    expect(decision.fill).toBeUndefined();
  });

  it('loest aus und fuellt zum Marktpreis, nicht zum Stop-Preis', () => {
    const decision = evaluateOrder(
      order({ side: 'sell', type: 'stop', stopPrice: parsePrice('90') }),
      ctx(quote('89', '89.1')),
    );

    expect(decision.trigger).toBe(true);
    expect(decision.fill?.price).toBe(parsePrice('89'));
    expect(decision.fill?.liquidity).toBe('taker');
  });

  it('fuellt bei einer Kursluecke zum Eroeffnungskurs - die teure Lektion', () => {
    // Stop bei 90, aber der Markt eroeffnet bei 70. Der Stop ist ein
    // Ausloeser, keine Garantie. Genau das kostet in echt Geld.
    const decision = evaluateOrder(
      order({ side: 'sell', type: 'stop', stopPrice: parsePrice('90') }),
      ctx(quote('70', '70.1'), { gapOpenPrice: parsePrice('70') }),
    );

    expect(decision.fill?.price).toBe(parsePrice('70'));
  });

  it('macht aus einem Stop-Limit erst eine Limit-Order', () => {
    const triggered = evaluateOrder(
      order({
        side: 'sell',
        type: 'stop_limit',
        stopPrice: parsePrice('90'),
        limitPrice: parsePrice('88'),
      }),
      ctx(quote('89', '89.1')),
    );

    expect(triggered.trigger).toBe(true);
    expect(triggered.fill).toBeUndefined(); // wartet jetzt auf sein Limit

    const filled = evaluateOrder(
      order({
        side: 'sell',
        type: 'stop_limit',
        stopPrice: parsePrice('90'),
        limitPrice: parsePrice('88'),
        triggered: true,
      }),
      ctx(quote('88.5', '88.6')),
    );

    expect(filled.fill?.price).toBe(parsePrice('88.5'));
  });

  it('faellt ein Stop-Limit ins Leere, wenn der Kurs durchrauscht', () => {
    // Genau der Nachteil gegenueber dem einfachen Stop: unter dem Limit
    // wird nicht mehr gefuellt, die Position bleibt offen.
    const decision = evaluateOrder(
      order({
        side: 'sell',
        type: 'stop_limit',
        stopPrice: parsePrice('90'),
        limitPrice: parsePrice('88'),
        triggered: true,
      }),
      ctx(quote('80', '80.1')),
    );

    expect(decision.fill).toBeUndefined();
  });
});

describe('Trailing Stop', () => {
  it('setzt beim ersten Blick den Anker', () => {
    const decision = evaluateOrder(
      order({ side: 'sell', type: 'trailing_stop', trailBps: 500 }),
      ctx(quote('100', '100.1')),
    );

    expect(decision.trailAnchor).toBe(parsePrice('100'));
  });

  it('zieht mit steigendem Kurs nach', () => {
    const decision = evaluateOrder(
      order({
        side: 'sell',
        type: 'trailing_stop',
        trailBps: 500,
        trailAnchor: parsePrice('100'),
      }),
      ctx(quote('120', '120.1')),
    );

    expect(decision.trailAnchor).toBe(parsePrice('120'));
    expect(decision.fill).toBeUndefined();
  });

  it('bleibt bei fallendem Kurs stehen und loest dann aus', () => {
    const stillSafe = evaluateOrder(
      order({
        side: 'sell',
        type: 'trailing_stop',
        trailBps: 500,
        trailAnchor: parsePrice('120'),
      }),
      ctx(quote('117', '117.1')),
    );
    expect(stillSafe.fill).toBeUndefined();
    expect(stillSafe.trailAnchor).toBeUndefined(); // Anker bleibt, wo er war

    // 5 % unter 120 sind 114 - hier ist Schluss.
    const triggered = evaluateOrder(
      order({
        side: 'sell',
        type: 'trailing_stop',
        trailBps: 500,
        trailAnchor: parsePrice('120'),
      }),
      ctx(quote('113', '113.1')),
    );
    expect(triggered.fill?.price).toBe(parsePrice('113'));
  });

  it('rechnet den aktuellen Ausloesepreis fuer die Anzeige aus', () => {
    const price = trailingStopPrice(
      order({ side: 'sell', type: 'trailing_stop', trailBps: 500, trailAnchor: parsePrice('120') }),
    );

    expect(price).toBe(parsePrice('114'));
  });

  it('funktioniert auch kaufseitig, nur andersherum', () => {
    const decision = evaluateOrder(
      order({
        side: 'buy',
        type: 'trailing_stop',
        trailBps: 500,
        trailAnchor: parsePrice('100'),
      }),
      ctx(quote('105.9', '106')),
    );

    expect(decision.fill?.price).toBe(parsePrice('106'));
  });
});

describe('Gueltigkeit', () => {
  it('laesst Day-Orders zum Handelsschluss verfallen', () => {
    const decision = evaluateOrder(
      order({ tif: 'day', createdAt: 1_000, limitPrice: parsePrice('1') }),
      ctx(quote('100', '100.1'), { sessionStart: 500_000 }),
    );

    expect(decision.expire).toBe(true);
  });

  it('laesst GTC-Orders liegen', () => {
    const decision = evaluateOrder(
      order({ tif: 'gtc', createdAt: 1_000, limitPrice: parsePrice('1') }),
      ctx(quote('100', '100.1'), { sessionStart: 500_000 }),
    );

    expect(decision.expire).toBeUndefined();
  });

  it('ignoriert bereits vollstaendig gefuellte Orders', () => {
    const decision = evaluateOrder(
      order({ qty: parseQty('1'), filledQty: parseQty('1'), limitPrice: parsePrice('999') }),
      ctx(quote('100', '100.1')),
    );

    expect(decision).toEqual({});
  });

  it('fuellt nur die Restmenge', () => {
    const partial = order({ qty: parseQty('3'), filledQty: parseQty('1'), type: 'market' });

    expect(remainingQty(partial)).toBe(parseQty('2'));
    expect(evaluateOrder(partial, ctx(quote('100', '100.1'))).fill?.qty).toBe(parseQty('2'));
  });

  it('bestimmt den Beginn des Krypto-Handelstages als 00:00 UTC', () => {
    const noon = Date.UTC(2026, 8, 10, 12, 30);
    expect(cryptoSessionStart(noon)).toBe(Date.UTC(2026, 8, 10));
  });
});
