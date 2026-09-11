import { describe, expect, it } from 'vitest';

import { PHASES_MAX_MS, phaseAt, type RoundPhase } from './rounds.js';

const START = 1_000_000;
const MINUTE = 60_000;

/** Eine Feierabendrunde von 45 Minuten. */
const ENDE = START + 45 * MINUTE;

function phaseNach(minuten: number): RoundPhase | null {
  return phaseAt(START, ENDE, START + minuten * MINUTE)?.key ?? null;
}

describe('Rundentakt', () => {
  it('durchlaeuft die Phasen in der richtigen Reihenfolge', () => {
    expect(phaseNach(0)).toBe('aufwaermen');
    expect(phaseNach(10)).toBe('aufwaermen');
    expect(phaseNach(20)).toBe('hitze');
    expect(phaseNach(30)).toBe('hitze');
    expect(phaseNach(36)).toBe('endspurt');
    expect(phaseNach(43)).toBe('finale');
  });

  it('springt nie zurueck', () => {
    let zuletzt = -1;
    const reihenfolge = ['aufwaermen', 'hitze', 'endspurt', 'finale'];

    for (let minute = 0; minute <= 45; minute += 1) {
      const jetzt = reihenfolge.indexOf(phaseNach(minute)!);
      expect(jetzt).toBeGreaterThanOrEqual(zuletzt);
      zuletzt = jetzt;
    }
  });

  it('wird von Phase zu Phase heisser', () => {
    const hitzen = [0, 20, 36, 44].map(
      (minute) => phaseAt(START, ENDE, START + minute * MINUTE)!.heat,
    );

    for (let i = 1; i < hitzen.length; i += 1) {
      expect(hitzen[i]!).toBeGreaterThan(hitzen[i - 1]!);
    }
  });

  it('bleibt nach dem Ende im Finale stehen', () => {
    expect(phaseNach(50)).toBe('finale');
    expect(phaseNach(5_000)).toBe('finale');
  });

  it('behandelt einen Start in der Zukunft als Aufwaermen', () => {
    expect(phaseAt(START, ENDE, START - 10 * MINUTE)?.key).toBe('aufwaermen');
  });

  it('gibt bei einer Liga ohne Enddatum keinen Takt vor', () => {
    expect(phaseAt(START, null, START + 10 * MINUTE)).toBeNull();
  });

  it('laesst lange Ligen in Ruhe', () => {
    // Sieben Tage: ein "Endspurt" waere hier achteinhalb Stunden lang, und
    // die Ankuendigung kaeme mitten in der Nacht.
    const woche = START + 7 * 24 * 60 * MINUTE;
    expect(phaseAt(START, woche, START + 3 * 24 * 60 * MINUTE)).toBeNull();

    // Genau an der Grenze ist noch Schluss, knapp darunter gibt es Phasen.
    expect(phaseAt(START, START + PHASES_MAX_MS, START)).not.toBeNull();
    expect(phaseAt(START, START + PHASES_MAX_MS + 1, START)).toBeNull();
  });

  it('kommt mit einer unsinnigen Dauer klar', () => {
    expect(phaseAt(START, START, START)).toBeNull();
    expect(phaseAt(START, START - 1000, START)).toBeNull();
  });

  it('liefert zu jeder Phase eine Beschriftung und einen Satz', () => {
    for (const minute of [0, 20, 36, 44]) {
      const phase = phaseAt(START, ENDE, START + minute * MINUTE)!;
      expect(phase.label.length).toBeGreaterThan(3);
      expect(phase.blurb.length).toBeGreaterThan(10);
    }
  });
});
