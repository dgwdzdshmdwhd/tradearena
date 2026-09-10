import { describe, expect, it } from 'vitest';

import { createRng } from './random.js';
import {
  EVENTS,
  FACTOR_SCALE,
  SIM_ASSETS,
  applyFactor,
  eventHeadline,
  gaussish,
  rollEvent,
  stepFactor,
  type SimParams,
} from './simmarket.js';

const RUHIG: SimParams = { driftBpsPerMin: 0, volBpsPerMin: 20 };

describe('stepFactor', () => {
  it('laesst den Kurs ohne verstrichene Zeit unveraendert', () => {
    expect(stepFactor(createRng(1), RUHIG, 0)).toBe(FACTOR_SCALE);
  });

  it('ist bei gleichem Seed reproduzierbar', () => {
    const a = stepFactor(createRng(7), RUHIG, 60_000);
    const b = stepFactor(createRng(7), RUHIG, 60_000);
    expect(a).toBe(b);
  });

  it('deckelt einzelne Ausschlaege bei zehn Prozent', () => {
    // Absurde Volatilitaet - ohne Deckel wuerde ein Wert hier explodieren.
    const wild: SimParams = { driftBpsPerMin: 0, volBpsPerMin: 100_000 };

    for (let seed = 0; seed < 200; seed += 1) {
      const factor = stepFactor(createRng(seed), wild, 60_000);
      expect(factor).toBeGreaterThanOrEqual(FACTOR_SCALE - 100_000n);
      expect(factor).toBeLessThanOrEqual(FACTOR_SCALE + 100_000n);
    }
  });

  it('laesst einen Aufwaertstrend im Mittel steigen', () => {
    const steigend: SimParams = { driftBpsPerMin: 40, volBpsPerMin: 10 };
    let price = 100_000n;

    for (let i = 0; i < 300; i += 1) {
      price = applyFactor(price, stepFactor(createRng(i), steigend, 60_000));
    }

    expect(price).toBeGreaterThan(100_000n);
  });

  it('laesst einen Abwaertstrend im Mittel fallen', () => {
    const fallend: SimParams = { driftBpsPerMin: -40, volBpsPerMin: 10 };
    let price = 100_000n;

    for (let i = 0; i < 300; i += 1) {
      price = applyFactor(price, stepFactor(createRng(i), fallend, 60_000));
    }

    expect(price).toBeLessThan(100_000n);
  });

  it('beschleunigt waehrend eines Ereignisses', () => {
    const jetzt = 1_000_000;
    const ohne = stepFactor(createRng(3), RUHIG, 60_000, null, jetzt);
    const mit = stepFactor(
      createRng(3),
      RUHIG,
      60_000,
      { driftBpsPerMin: 100, until: jetzt + 60_000 },
      jetzt,
    );

    expect(mit).toBeGreaterThan(ohne);
  });

  it('ignoriert ein abgelaufenes Ereignis', () => {
    const jetzt = 1_000_000;
    const ohne = stepFactor(createRng(3), RUHIG, 60_000, null, jetzt);
    const abgelaufen = stepFactor(
      createRng(3),
      RUHIG,
      60_000,
      { driftBpsPerMin: 100, until: jetzt - 1 },
      jetzt,
    );

    expect(abgelaufen).toBe(ohne);
  });
});

describe('applyFactor', () => {
  it('rechnet die Bewegung auf die Reserve', () => {
    expect(applyFactor(1_000_000n, FACTOR_SCALE)).toBe(1_000_000n);
    expect(applyFactor(1_000_000n, FACTOR_SCALE + 100_000n)).toBe(1_100_000n);
    expect(applyFactor(1_000_000n, FACTOR_SCALE - 100_000n)).toBe(900_000n);
  });

  it('laesst einen Kurs niemals auf null fallen', () => {
    let price = 100n;
    for (let i = 0; i < 500; i += 1) {
      price = applyFactor(price, FACTOR_SCALE - 100_000n);
    }
    expect(price).toBeGreaterThan(0n);
  });
});

describe('gaussish', () => {
  it('streut um null', () => {
    const rng = createRng(42);
    let sum = 0;
    for (let i = 0; i < 5_000; i += 1) sum += gaussish(rng);

    expect(Math.abs(sum / 5_000)).toBeLessThan(0.1);
  });

  it('liefert grosse Ausschlaege seltener als kleine', () => {
    const rng = createRng(11);
    let klein = 0;
    let gross = 0;

    for (let i = 0; i < 5_000; i += 1) {
      const value = Math.abs(gaussish(rng));
      if (value < 0.5) klein += 1;
      if (value > 1.5) gross += 1;
    }

    expect(klein).toBeGreaterThan(gross);
  });
});

describe('Ereignisse', () => {
  it('treten bei kleiner Wahrscheinlichkeit selten auf', () => {
    let treffer = 0;
    for (let seed = 0; seed < 1_000; seed += 1) {
      if (rollEvent(createRng(seed), 60_000, 0.02)) treffer += 1;
    }

    expect(treffer).toBeGreaterThan(0);
    expect(treffer).toBeLessThan(120);
  });

  it('treten ohne verstrichene Zeit nie auf', () => {
    expect(rollEvent(createRng(1), 0, 1)).toBeNull();
  });

  it('setzt den Namen in die Schlagzeile ein', () => {
    const template = EVENTS.find((entry) => entry.key === 'deal');
    expect(eventHeadline(template!, 'Nova Energie')).toBe('Grossauftrag fuer Nova Energie');
  });

  it('hat Ereignisse in beide Richtungen', () => {
    expect(EVENTS.some((entry) => entry.driftBpsPerMin > 0)).toBe(true);
    expect(EVENTS.some((entry) => entry.driftBpsPerMin < 0)).toBe(true);
  });
});

describe('Arena-Werte', () => {
  it('haben unterschiedliche Charaktere', () => {
    const vols = SIM_ASSETS.map((asset) => asset.params.volBpsPerMin);
    expect(Math.max(...vols) / Math.min(...vols)).toBeGreaterThan(4);
  });

  it('haben eindeutige Kuerzel und sinnvolle Startwerte', () => {
    const symbols = new Set(SIM_ASSETS.map((asset) => asset.symbol));
    expect(symbols.size).toBe(SIM_ASSETS.length);

    for (const asset of SIM_ASSETS) {
      expect(asset.startPriceCents).toBeGreaterThan(0n);
      expect(asset.depthCents).toBeGreaterThan(asset.startPriceCents);
    }
  });
});
