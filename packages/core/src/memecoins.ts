/**
 * Memecoins.
 *
 * Die Arena-Aktien sind der ruhige Teil des Marktes: Sie steigen um ein
 * Prozent, sie fallen um zwei, man kann ueber Stunden etwas aufbauen. Genau
 * das ist auf Dauer langweilig, weil nie etwas auf dem Spiel steht.
 *
 * Ein Memecoin ist das Gegenteil. Er wird geboren, er steigt absurd, und dann
 * ist er meistens tot - alles in zwanzig Minuten. Wer dabei ist, verzehnfacht
 * sein Geld oder verliert es. Wer zuschaut, aergert sich. Beides ist besser
 * als Langeweile.
 *
 * Der Ablauf steht bei der Geburt fest ("Lebenslauf") und wird gespeichert.
 * Das ist wichtig: Ein Memecoin, dessen Zukunft bei jedem Takt neu gewuerfelt
 * wird, ist reines Rauschen. Einer mit festem Lebenslauf hat einen Verlauf,
 * den man lesen kann - nicht sicher, aber besser als raten. Genau darin liegt
 * das Koennen: Wer merkt, dass der Anstieg abflacht, geht raus, bevor es
 * jeder tut.
 *
 * Was Spieler nicht sehen: den Lebenslauf selbst. Was sie sehen: Alter,
 * Kursverlauf, wie viel schon gelaufen ist - und dass jeder dasselbe sieht.
 */

import type { Rng } from './random.js';
import type { SimParams } from './simmarket.js';

export type MemePhase = 'start' | 'pump' | 'gipfel' | 'abverkauf' | 'ruhe' | 'grab';

/**
 * Grundtypen. Dass es mehrere gibt, ist der ganze Punkt - gaebe es nur den
 * einen Verlauf, waere die richtige Entscheidung immer dieselbe und damit
 * keine Entscheidung mehr.
 */
export type MemeArchetype =
  /** Der Normalfall: schoener Anstieg, dann Absturz. */
  | 'rakete'
  /** Faellt nach dem Gipfel nur zurueck und lebt weiter. Wer haelt, gewinnt. */
  | 'laeufer'
  /** Gipfel nach zwei Minuten, danach sofort weg. Bestraft blindes Nachkaufen. */
  | 'sofortrug'
  /** Kommt nie in Gang. Der Reinfall, den es geben muss, damit Start kein Freifahrtschein ist. */
  | 'niete';

export interface MemeSegment {
  phase: MemePhase;
  /** Ende des Abschnitts in Millisekunden seit der Geburt. */
  endsAt: number;
  params: SimParams;
}

export interface MemePlan {
  archetype: MemeArchetype;
  segments: MemeSegment[];
}

export const MEME_ARCHETYPE_LABELS: Record<MemeArchetype, string> = {
  rakete: 'Rakete',
  laeufer: 'Laeufer',
  sofortrug: 'Sofortrug',
  niete: 'Niete',
};

export const MEME_PHASE_LABELS: Record<MemePhase, string> = {
  start: 'frisch',
  pump: 'laeuft',
  gipfel: 'ueberhitzt',
  abverkauf: 'Abverkauf',
  ruhe: 'beruhigt',
  grab: 'tot',
};

/** Namen und Sprueche. Albern mit Absicht - das ist der Ton dieser Ecke. */
export interface MemeDef {
  symbol: string;
  name: string;
  blurb: string;
  color: string;
}

export const MEME_DEFS: readonly MemeDef[] = [
  { symbol: 'PUMPFISCH', name: 'Pumpfisch', blurb: 'Schwimmt nach oben. Bis er es nicht mehr tut.', color: '#3fb6d6' },
  { symbol: 'MOONKARL', name: 'Moonkarl', blurb: 'Karl hat einen Plan. Karl hat keinen Plan.', color: '#c9a227' },
  { symbol: 'HODLBERT', name: 'Hodlbert', blurb: 'Verkauft nie. Auch nicht, wenn er sollte.', color: '#7c9ef0' },
  { symbol: 'FOMOFRITZ', name: 'Fomofritz', blurb: 'Kauft immer genau dann, wenn alle davon reden.', color: '#f0803a' },
  { symbol: 'KATZENGOLD', name: 'Katzengold', blurb: 'Glaenzt wie das Echte. Ist es aber nicht.', color: '#d4a24c' },
  { symbol: 'DIAMANTHAND', name: 'Diamanthand', blurb: 'Haelt durch. Manchmal bis ganz nach unten.', color: '#8fd8e8' },
  { symbol: 'PAPIERHAND', name: 'Papierhand', blurb: 'Verkauft beim ersten roten Balken. Meistens zu frueh.', color: '#c2c8d0' },
  { symbol: 'ZOCKZOCK', name: 'Zockzock', blurb: 'Kein Geschaeftsmodell, dafuer ein sehr guter Name.', color: '#e0577f' },
  { symbol: 'RAKETENOTTO', name: 'Raketenotto', blurb: 'Otto baut Raketen. Otto hat noch keine gebaut.', color: '#f0555b' },
  { symbol: 'BANANE', name: 'Banane', blurb: 'Krumm, gelb, vollkommen wertlos. Steigt trotzdem.', color: '#e8c33a' },
  { symbol: 'HAMSTERRAD', name: 'Hamsterrad', blurb: 'Laeuft und laeuft und kommt nirgends an.', color: '#a0895f' },
  { symbol: 'KELLERKIND', name: 'Kellerkind', blurb: 'Kennt den Boden gut. War schon oft da.', color: '#7b8794' },
  { symbol: 'LAMBOLUTZ', name: 'Lambolutz', blurb: 'Lutz faehrt Bus. Lutz traeumt gross.', color: '#31c48d' },
  { symbol: 'NOKOMMA', name: 'Nokomma', blurb: 'Der Kurs hat so viele Nullen, dass keiner mehr zaehlt.', color: '#a78bfa' },
  { symbol: 'SPARFUCHS', name: 'Sparfuchs', blurb: 'Guenstig einsteigen. Noch guenstiger aussteigen.', color: '#e07a3f' },
  { symbol: 'GLUECKSRITTER', name: 'Gluecksritter', blurb: 'Alles auf eine Karte. Die Karte ist unbekannt.', color: '#d17ae0' },
  { symbol: 'BODENLOS', name: 'Bodenlos', blurb: 'Ehrlicher Name. Man kann sich nicht beschweren.', color: '#8b5cf6' },
  { symbol: 'SCHNITZEL', name: 'Schnitzel', blurb: 'Paniert, flach geklopft, kurz sehr heiss.', color: '#e8a33a' },
  { symbol: 'MONDFAHRT', name: 'Mondfahrt', blurb: 'Ticket geloest. Abfahrt unklar.', color: '#5b8def' },
  { symbol: 'DUMPFBACKE', name: 'Dumpfbacke', blurb: 'Der Name war schon die ganze Warnung.', color: '#9aa4b0' },
  { symbol: 'TENDIES', name: 'Tendies', blurb: 'Am Ende gibt es Tendies. Angeblich.', color: '#f0b23a' },
  { symbol: 'BRRRR', name: 'Brrrr', blurb: 'Geld wird gedruckt. Der Drucker gehoert jemand anderem.', color: '#4ec9a0' },
  { symbol: 'KAESEIGEL', name: 'Kaeseigel', blurb: 'Ergibt keinen Sinn. Steht trotzdem im Chart.', color: '#e8d03a' },
  { symbol: 'REKTOR', name: 'Rektor', blurb: 'Unterrichtet in Verlusten. Sehr erfahren.', color: '#f0555b' },
  { symbol: 'ALLESODER', name: 'Allesoder', blurb: 'Alles oder nichts. Meistens das Zweite.', color: '#e05757' },
  { symbol: 'WOLLMILCH', name: 'Wollmilch', blurb: 'Kann alles, macht nichts, kostet viel.', color: '#b0a08f' },
];

/** Wie tief der Pool eines Memecoins ist - klein, damit Kaeufe wirken. */
export const MEME_DEPTH_CENTS = 45_000_00n;

/**
 * Wuerfelt einen Lebenslauf aus.
 *
 * Die Verteilung ist mit Absicht schief: Die Mehrheit endet schlecht. Wuerde
 * jeder Memecoin sich lohnen, waere Mitmachen keine Entscheidung, sondern
 * eine Pflicht - und der erste Reinfall gehoert zur Geschichte dazu.
 */
export function rollMemePlan(rng: Rng): MemePlan {
  const roll = rng.next();
  const archetype: MemeArchetype =
    roll < 0.12 ? 'niete' : roll < 0.32 ? 'sofortrug' : roll < 0.72 ? 'rakete' : 'laeufer';

  const minutes = (value: number): number => Math.round(value * 60_000);
  const between = (low: number, high: number): number => low + rng.next() * (high - low);

  if (archetype === 'niete') {
    // Kommt nie in Gang: ein Zucken nach oben, dann Seitwaerts ins Nichts.
    const start = minutes(between(1.5, 3));
    return {
      archetype,
      segments: [
        { phase: 'start', endsAt: start, params: { driftBpsPerMin: 260, volBpsPerMin: 420 } },
        {
          phase: 'abverkauf',
          endsAt: start + minutes(between(5, 9)),
          params: { driftBpsPerMin: -420, volBpsPerMin: 380 },
        },
        { phase: 'grab', endsAt: Number.MAX_SAFE_INTEGER, params: { driftBpsPerMin: -25, volBpsPerMin: 150 } },
      ],
    };
  }

  if (archetype === 'sofortrug') {
    const start = minutes(between(1, 2));
    const gipfel = start + minutes(between(0.5, 1.2));
    return {
      archetype,
      segments: [
        { phase: 'start', endsAt: start, params: { driftBpsPerMin: 2_600, volBpsPerMin: 900 } },
        { phase: 'gipfel', endsAt: gipfel, params: { driftBpsPerMin: 0, volBpsPerMin: 1_400 } },
        {
          phase: 'abverkauf',
          endsAt: gipfel + minutes(between(3, 6)),
          params: { driftBpsPerMin: -3_400, volBpsPerMin: 1_100 },
        },
        { phase: 'grab', endsAt: Number.MAX_SAFE_INTEGER, params: { driftBpsPerMin: -30, volBpsPerMin: 200 } },
      ],
    };
  }

  const start = minutes(between(1.5, 3));
  const pump = start + minutes(between(4, 9));
  const gipfel = pump + minutes(between(1, 3));

  if (archetype === 'laeufer') {
    return {
      archetype,
      segments: [
        { phase: 'start', endsAt: start, params: { driftBpsPerMin: 1_100, volBpsPerMin: 500 } },
        {
          phase: 'pump',
          endsAt: pump,
          params: { driftBpsPerMin: between(1_800, 3_000), volBpsPerMin: 850 },
        },
        { phase: 'gipfel', endsAt: gipfel, params: { driftBpsPerMin: 0, volBpsPerMin: 1_200 } },
        {
          phase: 'abverkauf',
          endsAt: gipfel + minutes(between(3, 6)),
          params: { driftBpsPerMin: between(-900, -500), volBpsPerMin: 700 },
        },
        // Der Unterschied zum Absturz: Hier bleibt etwas uebrig.
        { phase: 'ruhe', endsAt: Number.MAX_SAFE_INTEGER, params: { driftBpsPerMin: 6, volBpsPerMin: 160 } },
      ],
    };
  }

  return {
    archetype: 'rakete',
    segments: [
      { phase: 'start', endsAt: start, params: { driftBpsPerMin: 1_200, volBpsPerMin: 520 } },
      {
        phase: 'pump',
        endsAt: pump,
        params: { driftBpsPerMin: between(2_200, 4_200), volBpsPerMin: 900 },
      },
      { phase: 'gipfel', endsAt: gipfel, params: { driftBpsPerMin: 0, volBpsPerMin: 1_300 } },
      {
        phase: 'abverkauf',
        endsAt: gipfel + minutes(between(5, 11)),
        params: { driftBpsPerMin: between(-3_000, -1_700), volBpsPerMin: 1_000 },
      },
      { phase: 'grab', endsAt: Number.MAX_SAFE_INTEGER, params: { driftBpsPerMin: -30, volBpsPerMin: 200 } },
    ],
  };
}

/** Welcher Abschnitt gerade laeuft. */
export function segmentAt(plan: MemePlan, ageMs: number): MemeSegment {
  for (const segment of plan.segments) {
    if (ageMs < segment.endsAt) return segment;
  }

  return plan.segments[plan.segments.length - 1]!;
}

/** Ob der Coin am Ende seines Lebenslaufs angekommen ist. */
export function isBuried(plan: MemePlan, ageMs: number): boolean {
  return segmentAt(plan, ageMs).phase === 'grab';
}
