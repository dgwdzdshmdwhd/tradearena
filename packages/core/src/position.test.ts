import { describe, expect, it } from 'vitest';

import { parsePrice, parseQty } from './money.js';
import {
  accountEquityCents,
  applyFillToPosition,
  exposureCents,
  positionSide,
  positionValueCents,
  unrealizedPnlCents,
} from './position.js';
import { FLAT_POSITION, type PositionState } from './types.js';

const flat = (): PositionState => ({ ...FLAT_POSITION });

describe('applyFillToPosition', () => {
  it('eroeffnet eine Long-Position', () => {
    const { position, realizedCents } = applyFillToPosition(
      flat(),
      'buy',
      parseQty('1'),
      parsePrice('100'),
    );

    expect(position.qty).toBe(parseQty('1'));
    expect(position.avgEntry).toBe(parsePrice('100'));
    expect(realizedCents).toBe(0n);
    expect(positionSide(position)).toBe('long');
  });

  it('eroeffnet eine Short-Position', () => {
    const { position } = applyFillToPosition(flat(), 'sell', parseQty('2'), parsePrice('50'));

    expect(position.qty).toBe(-parseQty('2'));
    expect(positionSide(position)).toBe('short');
  });

  it('mittelt den Einstand beim Nachkaufen', () => {
    let state = applyFillToPosition(flat(), 'buy', parseQty('1'), parsePrice('100')).position;
    state = applyFillToPosition(state, 'buy', parseQty('1'), parsePrice('200')).position;

    expect(state.qty).toBe(parseQty('2'));
    expect(state.avgEntry).toBe(parsePrice('150'));
  });

  it('mittelt gewichtet nach Menge, nicht stumpf nach Preis', () => {
    let state = applyFillToPosition(flat(), 'buy', parseQty('3'), parsePrice('100')).position;
    state = applyFillToPosition(state, 'buy', parseQty('1'), parsePrice('200')).position;

    // (3 * 100 + 1 * 200) / 4 = 125
    expect(state.avgEntry).toBe(parsePrice('125'));
  });

  it('realisiert Gewinn beim Teilverkauf und laesst den Einstand stehen', () => {
    let state = applyFillToPosition(flat(), 'buy', parseQty('2'), parsePrice('100')).position;
    const result = applyFillToPosition(state, 'sell', parseQty('1'), parsePrice('150'));
    state = result.position;

    expect(result.realizedCents).toBe(5_000n); // 50 $ Gewinn
    expect(state.qty).toBe(parseQty('1'));
    expect(state.avgEntry).toBe(parsePrice('100'));
    expect(state.realizedPnlCents).toBe(5_000n);
  });

  it('realisiert Verlust mit korrektem Vorzeichen', () => {
    const opened = applyFillToPosition(flat(), 'buy', parseQty('1'), parsePrice('100')).position;
    const closed = applyFillToPosition(opened, 'sell', parseQty('1'), parsePrice('80'));

    expect(closed.realizedCents).toBe(-2_000n); // 20 $ Verlust
    expect(closed.position.qty).toBe(0n);
    expect(closed.position.avgEntry).toBe(0n);
  });

  it('verdient an fallenden Kursen, wenn man short ist', () => {
    const opened = applyFillToPosition(flat(), 'sell', parseQty('1'), parsePrice('200')).position;
    const closed = applyFillToPosition(opened, 'buy', parseQty('1'), parsePrice('150'));

    expect(closed.realizedCents).toBe(5_000n);
    expect(closed.position.qty).toBe(0n);
  });

  it('dreht die Position um, wenn man mehr verkauft als man hat', () => {
    // Der Fall, den Simulatoren gern falsch machen.
    const long = applyFillToPosition(flat(), 'buy', parseQty('1'), parsePrice('100')).position;
    const flipped = applyFillToPosition(long, 'sell', parseQty('3'), parsePrice('200'));

    expect(flipped.realizedCents).toBe(10_000n); // nur das eine Stueck zaehlt: +100 $
    expect(flipped.position.qty).toBe(-parseQty('2'));
    // Der neue Einstand ist der aktuelle Preis, nicht der alte.
    expect(flipped.position.avgEntry).toBe(parsePrice('200'));
    expect(flipped.closedQty).toBe(parseQty('1'));
    expect(flipped.openedQty).toBe(parseQty('2'));
  });

  it('ueberlebt eine komplette Handelskette', () => {
    let state = flat();
    const steps: Array<[('buy' | 'sell'), string, string]> = [
      ['buy', '2', '100'],
      ['buy', '2', '120'], // Einstand 110
      ['sell', '1', '130'], // +20 $
      ['sell', '3', '90'], // schliesst 3 zu je -20 $, keine Umkehr
    ];

    let realized = 0n;
    for (const [side, qty, price] of steps) {
      const result = applyFillToPosition(state, side, parseQty(qty), parsePrice(price));
      state = result.position;
      realized += result.realizedCents;
    }

    expect(state.qty).toBe(0n);
    expect(realized).toBe(2_000n - 6_000n); // +20 $, dann -60 $
    expect(state.realizedPnlCents).toBe(realized);
  });

  it('weist ungueltige Mengen ab', () => {
    expect(() => applyFillToPosition(flat(), 'buy', 0n, parsePrice('1'))).toThrow();
  });
});

describe('Bewertung', () => {
  it('rechnet den nicht realisierten Gewinn aus', () => {
    const long = applyFillToPosition(flat(), 'buy', parseQty('2'), parsePrice('100')).position;

    expect(unrealizedPnlCents(long, parsePrice('110'))).toBe(2_000n);
    expect(unrealizedPnlCents(long, parsePrice('90'))).toBe(-2_000n);
  });

  it('dreht das Vorzeichen bei Short-Positionen um', () => {
    const short = applyFillToPosition(flat(), 'sell', parseQty('2'), parsePrice('100')).position;

    expect(unrealizedPnlCents(short, parsePrice('90'))).toBe(2_000n);
    expect(unrealizedPnlCents(short, parsePrice('110'))).toBe(-2_000n);
  });

  it('bewertet Shorts als Verbindlichkeit, das Engagement aber positiv', () => {
    const short = applyFillToPosition(flat(), 'sell', parseQty('1'), parsePrice('100')).position;

    expect(positionValueCents(short, parsePrice('100'))).toBe(-10_000n);
    expect(exposureCents(short, parsePrice('100'))).toBe(10_000n);
  });
});

describe('accountEquityCents', () => {
  it('laesst die Equity beim Eroeffnen einer Long-Position unveraendert', () => {
    // Bar bezahlt, dafuer Ware im Depot: unterm Strich gleich viel wert.
    const cashBefore = 1_000_000n;
    const long = applyFillToPosition(flat(), 'buy', parseQty('1'), parsePrice('100')).position;
    const cashAfter = cashBefore - 10_000n;

    expect(accountEquityCents(cashAfter, [{ position: long, mark: parsePrice('100') }])).toBe(
      cashBefore,
    );
  });

  it('laesst die Equity auch beim Eroeffnen einer Short-Position unveraendert', () => {
    // Der Verkaufserloes liegt als Bargeld da, die Rueckkaufpflicht zieht ihn ab.
    const cashBefore = 1_000_000n;
    const short = applyFillToPosition(flat(), 'sell', parseQty('1'), parsePrice('100')).position;
    const cashAfter = cashBefore + 10_000n;

    expect(accountEquityCents(cashAfter, [{ position: short, mark: parsePrice('100') }])).toBe(
      cashBefore,
    );
  });

  it('addiert mehrere Positionen', () => {
    const long = applyFillToPosition(flat(), 'buy', parseQty('1'), parsePrice('100')).position;
    const short = applyFillToPosition(flat(), 'sell', parseQty('1'), parsePrice('50')).position;

    const equity = accountEquityCents(0n, [
      { position: long, mark: parsePrice('120') },
      { position: short, mark: parsePrice('40') },
    ]);

    expect(equity).toBe(12_000n - 4_000n);
  });
});
