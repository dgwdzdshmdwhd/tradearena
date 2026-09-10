import { describe, expect, it } from 'vitest';

import { borrowFeeCents, chooseLiquidation, computeMargin } from './margin.js';
import { parseUsd } from './money.js';

describe('computeMargin ohne Hebel', () => {
  it('erlaubt nur, was man wirklich hat', () => {
    const margin = computeMargin({
      equityCents: parseUsd('10000'),
      exposureCents: parseUsd('4000'),
      maxLeverage: 1,
      maintenanceMarginBps: 5_000,
    });

    expect(margin.buyingPowerCents).toBe(parseUsd('6000'));
    expect(margin.liquidate).toBe(false);
  });

  it('gibt bei leerem Depot die volle Kaufkraft frei', () => {
    const margin = computeMargin({
      equityCents: parseUsd('10000'),
      exposureCents: 0n,
      maxLeverage: 1,
      maintenanceMarginBps: 5_000,
    });

    expect(margin.buyingPowerCents).toBe(parseUsd('10000'));
    expect(margin.marginCall).toBe(false);
    expect(margin.liquidate).toBe(false);
  });
});

describe('computeMargin mit Hebel', () => {
  it('vervielfacht die Kaufkraft', () => {
    const margin = computeMargin({
      equityCents: parseUsd('10000'),
      exposureCents: 0n,
      maxLeverage: 5,
      maintenanceMarginBps: 1_000,
    });

    expect(margin.buyingPowerCents).toBe(parseUsd('50000'));
  });

  it('bindet Sicherheit fuer offene Positionen', () => {
    const margin = computeMargin({
      equityCents: parseUsd('10000'),
      exposureCents: parseUsd('50000'),
      maxLeverage: 5,
      maintenanceMarginBps: 1_000,
    });

    expect(margin.usedMarginCents).toBe(parseUsd('10000'));
    expect(margin.buyingPowerCents).toBe(0n);
  });

  it('warnt, bevor es ernst wird', () => {
    // Erforderlich: 10 % von 50.000 = 5.000. Equity 5.500 -> Level 110 %.
    const margin = computeMargin({
      equityCents: parseUsd('5500'),
      exposureCents: parseUsd('50000'),
      maxLeverage: 5,
      maintenanceMarginBps: 1_000,
    });

    expect(margin.marginLevelBps).toBe(11_000n);
    expect(margin.marginCall).toBe(true);
    expect(margin.liquidate).toBe(false);
  });

  it('liquidiert, wenn die Sicherheit aufgebraucht ist', () => {
    const margin = computeMargin({
      equityCents: parseUsd('4000'),
      exposureCents: parseUsd('50000'),
      maxLeverage: 5,
      maintenanceMarginBps: 1_000,
    });

    expect(margin.marginLevelBps).toBeLessThan(10_000n);
    expect(margin.liquidate).toBe(true);
  });

  it('liquidiert auch bei negativer Equity', () => {
    const margin = computeMargin({
      equityCents: -parseUsd('100'),
      exposureCents: parseUsd('50000'),
      maxLeverage: 5,
      maintenanceMarginBps: 1_000,
    });

    expect(margin.liquidate).toBe(true);
    expect(margin.buyingPowerCents).toBe(0n);
  });
});

describe('chooseLiquidation', () => {
  it('nimmt die groesste Position zuerst', () => {
    const chosen = chooseLiquidation([
      { instrumentId: 'a', exposureCents: parseUsd('1000'), unrealizedPnlCents: -parseUsd('500') },
      { instrumentId: 'b', exposureCents: parseUsd('9000'), unrealizedPnlCents: -parseUsd('100') },
    ]);

    expect(chosen?.instrumentId).toBe('b');
  });

  it('nimmt bei Gleichstand die mit dem groesseren Verlust', () => {
    const chosen = chooseLiquidation([
      { instrumentId: 'a', exposureCents: parseUsd('1000'), unrealizedPnlCents: -parseUsd('50') },
      { instrumentId: 'b', exposureCents: parseUsd('1000'), unrealizedPnlCents: -parseUsd('900') },
    ]);

    expect(chosen?.instrumentId).toBe('b');
  });

  it('gibt null zurueck, wenn es nichts zu liquidieren gibt', () => {
    expect(chooseLiquidation([])).toBeNull();
    expect(
      chooseLiquidation([{ instrumentId: 'a', exposureCents: 0n, unrealizedPnlCents: 0n }]),
    ).toBeNull();
  });
});

describe('borrowFeeCents', () => {
  it('rechnet die Leihgebuehr anteilig ab', () => {
    // 8 bp pro Tag auf 10.000 $ = 8 $ pro Tag, also 4 $ fuer einen halben Tag.
    expect(borrowFeeCents(parseUsd('10000'), 8, 43_200_000)).toBe(parseUsd('4'));
  });

  it('kostet ueber einen ganzen Tag den vollen Satz', () => {
    expect(borrowFeeCents(parseUsd('10000'), 8, 86_400_000)).toBe(parseUsd('8'));
  });

  it('ist bei Long-Positionen und ohne Zeit gratis', () => {
    expect(borrowFeeCents(0n, 8, 86_400_000)).toBe(0n);
    expect(borrowFeeCents(parseUsd('10000'), 8, 0)).toBe(0n);
    expect(borrowFeeCents(parseUsd('10000'), 0, 86_400_000)).toBe(0n);
  });
});
