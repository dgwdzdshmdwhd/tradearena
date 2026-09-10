import { describe, expect, it } from 'vitest';

import { cashRequiredForBuy, executeAtPrice, executeMarket, validateOrder } from './execution.js';
import { parsePrice, parseQty, parseUsd } from './money.js';
import { syntheticQuote } from './quote.js';
import type { Instrument, LeagueRules, Quote } from './types.js';

const RULES: LeagueRules = {
  fees: { takerBps: 10, makerBps: 4, fixedCents: 0n },
  slippage: { factorBps: 0, refDepthCents: 5_000_000_00n },
  shortBorrowBpsDaily: 8,
  maxLeverage: 1,
  maintenanceMarginBps: 5000,
};

const RULES_WITH_SLIPPAGE: LeagueRules = {
  ...RULES,
  slippage: { factorBps: 8, refDepthCents: 5_000_000_00n },
};

const QUOTE: Quote = {
  bid: parsePrice('100.00'),
  ask: parsePrice('100.10'),
  last: parsePrice('100.05'),
  at: 0,
};

const BTC: Instrument = {
  id: 'btc',
  symbol: 'BTCUSDT',
  display: 'BTC/USD',
  assetClass: 'crypto',
  priceSource: 'external',
  qtyStep: parseQty('0.00000001'),
  priceStep: parsePrice('0.01'),
  minNotionalCents: 100n,
};

describe('executeMarket', () => {
  it('kauft zum Ask und verkauft zum Bid, niemals zum Mittelkurs', () => {
    const buy = executeMarket({ side: 'buy', qty: parseQty('1'), quote: QUOTE, rules: RULES });
    const sell = executeMarket({ side: 'sell', qty: parseQty('1'), quote: QUOTE, rules: RULES });

    expect(buy.price).toBe(QUOTE.ask);
    expect(sell.price).toBe(QUOTE.bid);
    expect(buy.price).toBeGreaterThan(sell.price);
  });

  it('rechnet Volumen, Gebuehr und Kassenwirkung korrekt', () => {
    const buy = executeMarket({ side: 'buy', qty: parseQty('1'), quote: QUOTE, rules: RULES });

    expect(buy.grossCents).toBe(10_010n); // 100,10 $
    expect(buy.feeCents).toBe(11n); // 10 bps auf 100,10 $ = 10,01 Cent -> aufgerundet
    expect(buy.cashDeltaCents).toBe(-10_021n);
    expect(cashRequiredForBuy(buy)).toBe(10_021n);
  });

  it('zieht die Gebuehr beim Verkauf vom Erloes ab', () => {
    const sell = executeMarket({ side: 'sell', qty: parseQty('1'), quote: QUOTE, rules: RULES });

    expect(sell.grossCents).toBe(10_000n);
    expect(sell.feeCents).toBe(10n);
    expect(sell.cashDeltaCents).toBe(9_990n);
  });

  it('macht Maker-Orders guenstiger als Taker-Orders', () => {
    const taker = executeMarket({
      side: 'buy',
      qty: parseQty('1'),
      quote: QUOTE,
      rules: RULES,
      liquidity: 'taker',
    });
    const maker = executeMarket({
      side: 'buy',
      qty: parseQty('1'),
      quote: QUOTE,
      rules: RULES,
      liquidity: 'maker',
    });

    expect(maker.feeCents).toBeLessThan(taker.feeCents);
  });

  it('kostet beim sofortigen Hin und Zurueck Geld (Spread plus Gebuehren)', () => {
    // Der wichtigste Realismus-Test ueberhaupt: wer kauft und sofort wieder
    // verkauft, muss aermer sein. Sonst waere Overtrading kostenlos.
    const buy = executeMarket({ side: 'buy', qty: parseQty('1'), quote: QUOTE, rules: RULES });
    const sell = executeMarket({ side: 'sell', qty: parseQty('1'), quote: QUOTE, rules: RULES });

    expect(buy.cashDeltaCents + sell.cashDeltaCents).toBeLessThan(0n);
  });

  it('laesst kleine Orders von der Slippage unbehelligt', () => {
    const small = executeMarket({
      side: 'buy',
      qty: parseQty('1'),
      quote: QUOTE,
      rules: RULES_WITH_SLIPPAGE,
    });

    expect(small.price).toBe(QUOTE.ask);
    expect(small.slippageCents).toBe(0n);
  });

  it('bestraft grosse Orders mit spuerbarer Slippage', () => {
    const bigQuote: Quote = {
      bid: parsePrice('60000'),
      ask: parsePrice('60000'),
      last: parsePrice('60000'),
      at: 0,
    };

    const big = executeMarket({
      side: 'buy',
      qty: parseQty('1000'),
      quote: bigQuote,
      rules: RULES_WITH_SLIPPAGE,
    });

    expect(big.price).toBeGreaterThan(bigQuote.ask);
    expect(big.slippageCents).toBeGreaterThan(0n);
  });

  it('dreht die Slippage beim Verkauf um - schlechter heisst dort niedriger', () => {
    const bigQuote: Quote = {
      bid: parsePrice('60000'),
      ask: parsePrice('60000'),
      last: parsePrice('60000'),
      at: 0,
    };

    const sell = executeMarket({
      side: 'sell',
      qty: parseQty('1000'),
      quote: bigQuote,
      rules: RULES_WITH_SLIPPAGE,
    });

    expect(sell.price).toBeLessThan(bigQuote.bid);
  });

  it('wird bei hoher Volatilitaet teurer', () => {
    const bigQuote: Quote = {
      bid: parsePrice('60000'),
      ask: parsePrice('60000'),
      last: parsePrice('60000'),
      at: 0,
    };

    const calm = executeMarket({
      side: 'buy',
      qty: parseQty('1000'),
      quote: bigQuote,
      rules: RULES_WITH_SLIPPAGE,
      volBps: 100,
    });
    const panic = executeMarket({
      side: 'buy',
      qty: parseQty('1000'),
      quote: bigQuote,
      rules: RULES_WITH_SLIPPAGE,
      volBps: 800,
    });

    expect(panic.price).toBeGreaterThan(calm.price);
  });

  it('waechst unterlinear mit der Ordergroesse (Wurzelgesetz)', () => {
    const bigQuote: Quote = {
      bid: parsePrice('60000'),
      ask: parsePrice('60000'),
      last: parsePrice('60000'),
      at: 0,
    };
    const impact = (qty: string): bigint =>
      executeMarket({
        side: 'buy',
        qty: parseQty(qty),
        quote: bigQuote,
        rules: RULES_WITH_SLIPPAGE,
      }).price - bigQuote.ask;

    const single = impact('1000');
    const quadruple = impact('4000');

    // Vierfache Groesse -> etwa doppelte Slippage, nicht vierfache.
    expect(quadruple).toBeGreaterThan(single);
    expect(quadruple).toBeLessThan(single * 3n);
  });

  it('weist Mengen kleiner oder gleich null ab', () => {
    expect(() => executeMarket({ side: 'buy', qty: 0n, quote: QUOTE, rules: RULES })).toThrow();
    expect(() =>
      executeMarket({ side: 'buy', qty: parseQty('-1'), quote: QUOTE, rules: RULES }),
    ).toThrow();
  });
});

describe('executeAtPrice', () => {
  it('fuellt ohne Slippage zum vorgegebenen Preis', () => {
    const fill = executeAtPrice('buy', parseQty('2'), parsePrice('50'), RULES);

    expect(fill.price).toBe(parsePrice('50'));
    expect(fill.grossCents).toBe(10_000n);
    expect(fill.slippageCents).toBe(0n);
    expect(fill.liquidity).toBe('maker');
  });
});

describe('validateOrder', () => {
  const base = {
    instrument: BTC,
    quote: QUOTE,
    side: 'buy' as const,
    availableCashCents: parseUsd('100000'),
    rules: RULES,
  };

  it('laesst eine gedeckte Order durch', () => {
    expect(validateOrder({ ...base, qty: parseQty('1') })).toEqual({ ok: true });
  });

  it('blockt Orders ohne Deckung', () => {
    const result = validateOrder({
      ...base,
      qty: parseQty('1000'),
      availableCashCents: parseUsd('1000'),
    });

    expect(result).toMatchObject({ ok: false, code: 'funds' });
  });

  it('blockt Orders unter dem Mindestvolumen', () => {
    const result = validateOrder({
      ...base,
      instrument: { ...BTC, minNotionalCents: parseUsd('1000') },
      qty: parseQty('1'),
    });

    expect(result).toMatchObject({ ok: false, code: 'min_notional' });
  });

  it('blockt Mengen neben dem Lot-Raster', () => {
    const result = validateOrder({
      ...base,
      instrument: { ...BTC, qtyStep: parseQty('0.1') },
      qty: parseQty('0.15'),
    });

    expect(result).toMatchObject({ ok: false, code: 'qty' });
  });

  it('blockt Orders ohne gueltigen Kurs', () => {
    const result = validateOrder({
      ...base,
      qty: parseQty('1'),
      quote: { bid: 0n, ask: 0n, last: 0n, at: 0 },
    });

    expect(result).toMatchObject({ ok: false, code: 'price' });
  });
});

describe('syntheticQuote', () => {
  it('legt einen Spread um den letzten Kurs, wenn die Quelle keinen liefert', () => {
    const quote = syntheticQuote(parsePrice('200'), 10);

    expect(quote.ask).toBeGreaterThan(quote.last);
    expect(quote.bid).toBeLessThan(quote.last);
    expect(quote.ask - quote.last).toBe(quote.last - quote.bid);
  });
});
