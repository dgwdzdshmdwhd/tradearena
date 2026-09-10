import { describe, expect, it } from 'vitest';

import {
  MEME_DEFS,
  isBuried,
  rollMemePlan,
  segmentAt,
  type MemeArchetype,
} from './memecoins.js';
import { createRng } from './random.js';
import { FACTOR_SCALE, applyFactor, stepFactor } from './simmarket.js';

/** Spielt einen Lebenslauf durch und gibt den Kursverlauf zurueck. */
function simulate(seed: number, stepMs = 1_000): { peak: number; ende: number; verlauf: number[] } {
  const plan = rollMemePlan(createRng(seed));
  const rng = createRng(seed + 7_000);

  let reserve = 45_000_00n;
  const start = reserve;
  const verlauf: number[] = [];
  let peak = 1;

  // 45 Minuten reichen fuer jeden Lebenslauf inklusive Grab.
  for (let age = 0; age < 45 * 60_000; age += stepMs) {
    const segment = segmentAt(plan, age);
    reserve = applyFactor(reserve, stepFactor(rng, segment.params, stepMs));

    const vielfaches = Number(reserve) / Number(start);
    if (vielfaches > peak) peak = vielfaches;
    if (age % 30_000 === 0) verlauf.push(vielfaches);
  }

  return { peak, ende: Number(reserve) / Number(start), verlauf };
}

describe('Memecoin-Lebenslauf', () => {
  it('liefert zu jedem Zeitpunkt genau einen Abschnitt', () => {
    const plan = rollMemePlan(createRng(1));

    for (const age of [0, 1_000, 60_000, 600_000, 3_600_000, Number.MAX_SAFE_INTEGER - 1]) {
      expect(segmentAt(plan, age)).toBeDefined();
    }
  });

  it('ist reproduzierbar - gleicher Seed, gleicher Lebenslauf', () => {
    const a = rollMemePlan(createRng(42));
    const b = rollMemePlan(createRng(42));

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('durchlaeuft die Abschnitte in fester Reihenfolge, ohne Rueckschritt', () => {
    const reihenfolge = ['start', 'pump', 'gipfel', 'abverkauf', 'ruhe', 'grab'];

    for (let seed = 0; seed < 60; seed += 1) {
      const plan = rollMemePlan(createRng(seed));
      const indizes = plan.segments.map((segment) => reihenfolge.indexOf(segment.phase));

      expect(indizes.every((value) => value >= 0)).toBe(true);
      for (let i = 1; i < indizes.length; i += 1) {
        expect(indizes[i]!).toBeGreaterThan(indizes[i - 1]!);
      }
    }
  });

  it('endet immer in Grab oder Ruhe - kein Coin laeuft ewig weiter', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const plan = rollMemePlan(createRng(seed));
      const letzte = plan.segments[plan.segments.length - 1]!;

      expect(['grab', 'ruhe']).toContain(letzte.phase);
      expect(letzte.endsAt).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it('bringt alle vier Grundtypen hervor, und die Mehrheit endet schlecht', () => {
    const gezaehlt: Record<MemeArchetype, number> = {
      rakete: 0,
      laeufer: 0,
      sofortrug: 0,
      niete: 0,
    };

    for (let seed = 0; seed < 400; seed += 1) {
      gezaehlt[rollMemePlan(createRng(seed)).archetype] += 1;
    }

    expect(gezaehlt.rakete).toBeGreaterThan(0);
    expect(gezaehlt.laeufer).toBeGreaterThan(0);
    expect(gezaehlt.sofortrug).toBeGreaterThan(0);
    expect(gezaehlt.niete).toBeGreaterThan(0);

    // Wer blind jeden Coin haelt, soll auf Dauer verlieren. Sonst waere
    // Mitmachen keine Entscheidung, sondern eine Pflicht.
    const schlecht = gezaehlt.rakete + gezaehlt.sofortrug + gezaehlt.niete;
    expect(schlecht).toBeGreaterThan(gezaehlt.laeufer);
  });

  it('markiert nur die tatsaechlich toten Coins als begraben', () => {
    const plan = rollMemePlan(createRng(3));

    expect(isBuried(plan, 0)).toBe(false);
    // Nach zwei Stunden ist jeder Lebenslauf durch - ausser dem Laeufer,
    // der endet in Ruhe und bleibt handelbar.
    const spaet = isBuried(plan, 2 * 60 * 60_000);
    expect(spaet).toBe(plan.archetype !== 'laeufer');
  });
});

describe('Memecoin-Kursverlauf', () => {
  it('steigt spuerbar, bevor es abwaerts geht', () => {
    // Ueber viele Coins hinweg muss ein sichtbarer Anstieg herauskommen -
    // sonst gibt es nichts zu erwischen und das ganze Ding ist sinnlos.
    let mitAnstieg = 0;

    for (let seed = 0; seed < 40; seed += 1) {
      if (simulate(seed).peak >= 1.5) mitAnstieg += 1;
    }

    expect(mitAnstieg).toBeGreaterThan(25);
  });

  it('macht mindestens gelegentlich einen echten Verzehnfacher', () => {
    let raketen = 0;

    for (let seed = 0; seed < 40; seed += 1) {
      if (simulate(seed).peak >= 10) raketen += 1;
    }

    expect(raketen).toBeGreaterThan(0);
  });

  it('faellt beim Absturz weit unter den Gipfel zurueck', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const plan = rollMemePlan(createRng(seed));
      if (plan.archetype === 'laeufer') continue;

      const { peak, ende } = simulate(seed);
      if (peak < 2) continue;

      // Wer den Ausstieg verpasst, soll es merken.
      expect(ende).toBeLessThan(peak * 0.5);
    }
  });

  it('kommt nie bei null an - ein Kurs von null waere kein Kurs mehr', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      expect(simulate(seed).ende).toBeGreaterThan(0);
    }
  });

  it('bleibt beim Laeufer am Ende ueber dem Start', () => {
    let ueberStart = 0;
    let laeufer = 0;

    for (let seed = 0; seed < 120; seed += 1) {
      if (rollMemePlan(createRng(seed)).archetype !== 'laeufer') continue;
      laeufer += 1;
      if (simulate(seed).ende > 1) ueberStart += 1;
    }

    expect(laeufer).toBeGreaterThan(5);
    // Nicht jeder einzelne, aber die klare Mehrheit - sonst waere "Laeufer"
    // ein leeres Versprechen.
    expect(ueberStart).toBeGreaterThan(laeufer * 0.6);
  });

  it('haelt jeden Einzelschritt im gedeckelten Bereich', () => {
    const plan = rollMemePlan(createRng(5));
    const rng = createRng(99);

    for (let age = 0; age < 30 * 60_000; age += 1_000) {
      const factor = stepFactor(rng, segmentAt(plan, age).params, 1_000);
      expect(factor).toBeGreaterThanOrEqual(FACTOR_SCALE - 100_000n);
      expect(factor).toBeLessThanOrEqual(FACTOR_SCALE + 100_000n);
    }
  });
});

describe('Memecoin-Namen', () => {
  it('sind eindeutig und tragen alle einen Spruch', () => {
    const symbole = new Set(MEME_DEFS.map((def) => def.symbol));

    expect(symbole.size).toBe(MEME_DEFS.length);
    expect(MEME_DEFS.length).toBeGreaterThan(15);

    for (const def of MEME_DEFS) {
      expect(def.blurb.length).toBeGreaterThan(10);
      expect(def.color).toMatch(/^#[0-9a-f]{6}$/i);
      // Keine Emoji - die Oberflaeche zeichnet ihre Zeichen selbst.
      expect(def.symbol).toMatch(/^[A-Z]+$/);
    }
  });
});
