import { describe, expect, it } from 'vitest';

import { executeMarket } from './execution.js';
import { parsePrice, parseQty, parseUsd, type Cents } from './money.js';
import { accountEquityCents, applyFillToPosition, unrealizedPnlCents } from './position.js';
import { computeStats, type EquityPoint } from './stats.js';
import { FLAT_POSITION, type LeagueRules, type PositionState, type Quote, type Side } from './types.js';

/**
 * Das goldene Szenario.
 *
 * Hier wird nicht eine einzelne Formel geprueft, sondern ob die Teile
 * zusammen ein Konto ergeben, das aufgeht. Die entscheidende Invariante:
 *
 *   Aenderung der Equity == realisierter Gewinn - Gebuehren + nicht realisierter Gewinn
 *
 * Wenn diese Gleichung stimmt, kann kein Cent aus dem Nichts entstehen und
 * keiner verschwinden. Genau das muss man einem Freund beweisen koennen,
 * der sich am Ende der Liga ueber sein Ergebnis beschwert.
 */

const RULES: LeagueRules = {
  fees: { takerBps: 10, makerBps: 4, fixedCents: 0n },
  slippage: { factorBps: 0, refDepthCents: 5_000_000_00n },
  shortBorrowBpsDaily: 8,
  maxLeverage: 1,
  maintenanceMarginBps: 5000,
};

const quoteAt = (price: string, spreadCents = '6'): Quote => ({
  bid: parsePrice(price),
  ask: parsePrice(price) + parsePrice(spreadCents),
  last: parsePrice(price),
  at: 0,
});

interface Account {
  cashCents: Cents;
  position: PositionState;
  feesPaidCents: Cents;
  realizedCents: Cents;
}

function trade(account: Account, side: Side, qty: string, quote: Quote): Account {
  const fill = executeMarket({ side, qty: parseQty(qty), quote, rules: RULES });
  const applied = applyFillToPosition(account.position, side, fill.qty, fill.price);

  return {
    cashCents: account.cashCents + fill.cashDeltaCents,
    position: applied.position,
    feesPaidCents: account.feesPaidCents + fill.feeCents,
    realizedCents: account.realizedCents + applied.realizedCents,
  };
}

describe('Goldenes Szenario: ein kompletter Handelstag', () => {
  const START = parseUsd('100000');

  it('geht bei einem Gewinn-Trade auf den Cent auf', () => {
    let account: Account = {
      cashCents: START,
      position: { ...FLAT_POSITION },
      feesPaidCents: 0n,
      realizedCents: 0n,
    };

    account = trade(account, 'buy', '1', quoteAt('60000'));
    account = trade(account, 'sell', '1', quoteAt('61000'));

    expect(account.position.qty).toBe(0n);

    const equity = accountEquityCents(account.cashCents, []);
    expect(equity - START).toBe(account.realizedCents - account.feesPaidCents);

    // Gekauft zum Ask (60.006 $), verkauft zum Bid (61.000 $) = 994 $ Gewinn,
    // abzueglich zweier Gebuehren von zusammen 121,01 $.
    expect(account.realizedCents).toBe(99_400n);
    expect(account.feesPaidCents).toBe(12_101n);
    expect(equity).toBeGreaterThan(START);
  });

  it('geht auch mit offener Position auf', () => {
    let account: Account = {
      cashCents: START,
      position: { ...FLAT_POSITION },
      feesPaidCents: 0n,
      realizedCents: 0n,
    };

    account = trade(account, 'buy', '2', quoteAt('60000'));
    account = trade(account, 'sell', '1', quoteAt('62000'));

    const mark = parsePrice('62000');
    const equity = accountEquityCents(account.cashCents, [{ position: account.position, mark }]);

    const unrealized = unrealizedPnlCents(account.position, mark);

    expect(account.position.qty).toBe(parseQty('1'));
    expect(unrealized).toBeGreaterThan(0n);
    expect(equity - START).toBe(account.realizedCents - account.feesPaidCents + unrealized);
  });

  it('geht bei einem Short-Trade genauso auf', () => {
    let account: Account = {
      cashCents: START,
      position: { ...FLAT_POSITION },
      feesPaidCents: 0n,
      realizedCents: 0n,
    };

    account = trade(account, 'sell', '1', quoteAt('60000'));
    account = trade(account, 'buy', '1', quoteAt('58000'));

    expect(account.position.qty).toBe(0n);
    expect(account.realizedCents).toBeGreaterThan(0n); // gefallener Kurs = Gewinn

    const equity = accountEquityCents(account.cashCents, []);
    expect(equity - START).toBe(account.realizedCents - account.feesPaidCents);
  });

  it('bestraft Overtrading, auch wenn der Kurs sich gar nicht bewegt', () => {
    // 20 Hin-und-her-Trades bei stehendem Kurs: am Ende fehlt Geld.
    // Genau diese Lektion soll die App vermitteln.
    let account: Account = {
      cashCents: START,
      position: { ...FLAT_POSITION },
      feesPaidCents: 0n,
      realizedCents: 0n,
    };

    const quote = quoteAt('60000');
    for (let i = 0; i < 20; i += 1) {
      account = trade(account, 'buy', '0.1', quote);
      account = trade(account, 'sell', '0.1', quote);
    }

    expect(account.position.qty).toBe(0n);
    expect(account.cashCents).toBeLessThan(START);
    expect(account.feesPaidCents).toBeGreaterThan(0n);

    const equity = accountEquityCents(account.cashCents, []);
    expect(equity - START).toBe(account.realizedCents - account.feesPaidCents);
  });

  it('liefert am Ende auswertbare Kennzahlen', () => {
    const curve: EquityPoint[] = [
      { at: 0, equityCents: START },
      { at: 1, equityCents: parseUsd('105000') },
      { at: 2, equityCents: parseUsd('98000') }, // Drawdown von 105k auf 98k
      { at: 3, equityCents: parseUsd('112000') },
    ];

    const stats = computeStats(curve, [
      { pnlCents: parseUsd('5000'), openedAt: 0, closedAt: 1 },
      { pnlCents: parseUsd('-7000'), openedAt: 1, closedAt: 2 },
      { pnlCents: parseUsd('14000'), openedAt: 2, closedAt: 3 },
    ]);

    expect(stats.totalPnlCents).toBe(parseUsd('12000'));
    expect(stats.returnBps).toBe(1_200n); // +12 %
    expect(stats.maxDrawdownCents).toBe(parseUsd('7000'));
    expect(stats.maxDrawdownBps).toBe(666n); // -6,66 % vom Hoch
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRateBps).toBe(6_666n);
    expect(stats.bestTradeCents).toBe(parseUsd('14000'));
    expect(stats.worstTradeCents).toBe(parseUsd('-7000'));
    expect(stats.profitFactor).toBeCloseTo(19_000 / 7_000, 5);
    expect(stats.sharpe).not.toBeNull();
  });
});
