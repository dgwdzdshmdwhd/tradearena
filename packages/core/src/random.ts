/**
 * Deterministischer Zufall.
 *
 * Die Bots muessen Fehler machen - aber reproduzierbar. Mit `Math.random()`
 * koennte niemand im Nachhinein nachvollziehen, warum ein Bot um 3 Uhr nachts
 * das halbe Konto verbrannt hat. Mit einem gesaeten Generator schon: gleicher
 * Seed, gleiche Entscheidung, jederzeit nachspielbar.
 */

export interface Rng {
  /** Gleichverteilt in [0, 1). */
  next(): number;
  /** Ganzzahl in [min, max]. */
  int(min: number, max: number): number;
  /** Trifft mit der Wahrscheinlichkeit `probability` (0..1) zu. */
  chance(probability: number): boolean;
  /** Ein Element aus der Liste. */
  pick<T>(items: readonly T[]): T;
}

/** Mulberry32 - klein, schnell, gut genug fuer Spielmechanik. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('pick: leere Liste');
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}

/** Aus einem String einen Seed machen (FNV-1a), damit IDs als Seed taugen. */
export function seedFrom(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}
