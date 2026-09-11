/**
 * Der Takt einer Runde.
 *
 * Eine Liga lief bisher einfach von Anfang bis Ende durch - die Zeit bedeutete
 * nichts ausser "irgendwann vorbei". Ein Abend braucht aber einen Verlauf:
 * ruhig anfangen, anziehen, und zum Schluss soll noch einmal alles auf dem
 * Spiel stehen.
 *
 * Die Phasen ergeben sich aus dem Anteil der verstrichenen Zeit, nicht aus
 * festen Minuten. Damit funktioniert derselbe Verlauf fuer eine
 * Viertelstunde Blitz wie fuer eine Feierabendrunde.
 *
 * Fuer sehr lange Ligen gibt es keine Phasen. Bei sieben Tagen waere der
 * "Endspurt" achteinhalb Stunden lang - eine Spannung, die niemand so lange
 * aushaelt, und eine Ankuendigung, die mitten in der Nacht kommt.
 */

export type RoundPhase = 'aufwaermen' | 'hitze' | 'endspurt' | 'finale';

export interface PhaseInfo {
  key: RoundPhase;
  label: string;
  /** Ein Satz, der sagt, was jetzt anders ist. */
  blurb: string;
  /**
   * Wie stark der Markt in dieser Phase zulegt. 1 = normal.
   * Wirkt auf Schwankung und darauf, wie oft ein Memecoin startet.
   */
  heat: number;
}

/** Ab dieser Rundenlaenge gibt es keine Phasen mehr. */
export const PHASES_MAX_MS = 6 * 60 * 60_000;

const PHASEN: Array<{ bis: number; info: PhaseInfo }> = [
  {
    bis: 0.35,
    info: {
      key: 'aufwaermen',
      label: 'Aufwaermen',
      blurb: 'Ruhiger Markt. Zeit, sich eine Position aufzubauen.',
      heat: 1,
    },
  },
  {
    bis: 0.75,
    info: {
      key: 'hitze',
      label: 'Es zieht an',
      blurb: 'Mehr Bewegung, mehr Memecoins. Jetzt wird es unuebersichtlich.',
      heat: 1.6,
    },
  },
  {
    bis: 0.93,
    info: {
      key: 'endspurt',
      label: 'Endspurt',
      blurb: 'Doppelte Schwankung. Wer vorn liegt, muss sich entscheiden.',
      heat: 2.4,
    },
  },
  {
    bis: Infinity,
    info: {
      key: 'finale',
      label: 'Letzte Minuten',
      blurb: 'Alles oder nichts. Danach wird abgerechnet.',
      heat: 3,
    },
  },
];

/**
 * In welcher Phase eine Runde gerade steckt.
 *
 * `null` heisst: kein Takt - entweder ohne Enddatum oder zu lang dafuer.
 */
export function phaseAt(
  startsAt: number,
  endsAt: number | null,
  at: number,
): PhaseInfo | null {
  if (endsAt === null) return null;

  const dauer = endsAt - startsAt;
  if (dauer <= 0 || dauer > PHASES_MAX_MS) return null;

  const anteil = (at - startsAt) / dauer;
  if (anteil < 0) return PHASEN[0]!.info;

  for (const phase of PHASEN) {
    if (anteil < phase.bis) return phase.info;
  }

  return PHASEN[PHASEN.length - 1]!.info;
}
