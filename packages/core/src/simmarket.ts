/**
 * Der Arena-Markt.
 *
 * Erfundene Werte statt echter Boersenkurse. Das hat drei Gruende, und alle
 * drei sind Spielgruende, keine technischen:
 *
 *   1. Fuer alle gleich. Niemand kann nebenbei die echten Kurse nachschlagen.
 *   2. Man hat Einfluss. Wer kauft, treibt den Kurs - sichtbar, sofort.
 *      Bei einem echten Markt ist die eigene Order ein Staubkorn.
 *   3. Man kann es tunen. Ein echter Markt bewegt sich an einem ruhigen
 *      Dienstagabend kaum. Hier kann etwas passieren.
 *
 * Der Kurs entsteht aus derselben Bonding Curve wie bei den Spieler-Coins
 * (`amm.ts`), nur mit tieferen Reserven. Dadurch bewegen Trades den Kurs
 * automatisch und mit derselben, bereits getesteten Mathematik.
 *
 * Obendrauf legt der Server bei jedem Takt eine Kursbewegung: Grundtrend,
 * Zufall und gelegentlich ein Ereignis. Alles hier ist eine reine Funktion -
 * gerechnet wird mit Ganzzahlen, damit auf jedem Rechner exakt dasselbe
 * herauskommt.
 */

import { divRound, type Cents } from './money.js';
import type { Rng } from './random.js';

/** Kursbewegungen werden als Bruch in Millionsteln gerechnet. */
export const FACTOR_SCALE = 1_000_000n;

export interface SimParams {
  /** Grundtrend je Minute in Basispunkten. Negativ = faellt. */
  driftBpsPerMin: number;
  /** Schwankungsbreite je Minute in Basispunkten. */
  volBpsPerMin: number;
}

export interface SimEvent {
  /** Zusaetzlicher Trend je Minute, solange das Ereignis laeuft. */
  driftBpsPerMin: number;
  /** Zeitstempel, bis wann es wirkt. */
  until: number;
}

/**
 * Naeherung einer Normalverteilung aus drei Gleichverteilungen.
 *
 * Der zentrale Grenzwertsatz in seiner billigsten Form. Reicht voellig:
 * Wir wollen ein glaubwuerdiges Zittern, keine Doktorarbeit. Wichtig ist
 * nur, dass grosse Ausschlaege selten sind und kleine haeufig - genau das
 * liefert die Summe.
 */
export function gaussish(rng: Rng): number {
  return (rng.next() + rng.next() + rng.next() - 1.5) * 2;
}

/**
 * Wie stark sich der Kurs im vergangenen Zeitraum bewegt.
 *
 * Ergebnis ist ein Bruch (Zaehler/`FACTOR_SCALE`), mit dem die USD-Reserve
 * multipliziert wird. Gedeckelt auf +/-10 % je Schritt: ohne Deckel kann ein
 * einzelner Ausreisser einen Kurs zerlegen, und niemand hat Spass daran,
 * morgens einen Wert bei 0,0001 vorzufinden.
 */
export function stepFactor(
  rng: Rng,
  params: SimParams,
  elapsedMs: number,
  event?: SimEvent | null,
  now = Date.now(),
): bigint {
  const minutes = Math.max(0, elapsedMs) / 60_000;
  if (minutes === 0) return FACTOR_SCALE;

  const eventDrift = event && event.until > now ? event.driftBpsPerMin : 0;
  const drift = (params.driftBpsPerMin + eventDrift) * minutes;
  const shock = params.volBpsPerMin * Math.sqrt(minutes) * gaussish(rng);

  // Basispunkte in Millionstel: 1 bp = 100 ppm.
  const movePpm = Math.round((drift + shock) * 100);
  const capped = Math.max(-100_000, Math.min(100_000, movePpm));

  return FACTOR_SCALE + BigInt(capped);
}

/** Kursbewegung auf die USD-Reserve anwenden. */
export function applyFactor(reserveUsdCents: Cents, factor: bigint): Cents {
  const next = divRound(reserveUsdCents * factor, FACTOR_SCALE, 'half_up');
  // Ein Wert darf beliebig tief fallen, aber nie auf null - sonst gibt es
  // keinen Kurs mehr und der Markt ist kaputt statt billig.
  return next > 0n ? next : 1n;
}

export interface SimAssetDef {
  symbol: string;
  name: string;
  /** Kurzbeschreibung, die im Spiel Charakter gibt. */
  blurb: string;
  color: string;
  startPriceCents: Cents;
  /** Startkapital des Pools - bestimmt, wie stark Trades den Kurs bewegen. */
  depthCents: Cents;
  params: SimParams;
}

/**
 * Die Werte der Arena.
 *
 * Bewusst unterschiedliche Charaktere: ein ruhiger Anker, auf dem man
 * langweilig, aber sicher unterwegs ist - und ein paar Wackelkandidaten, bei
 * denen in zehn Minuten alles passieren kann. Ohne diese Spreizung waeren
 * alle Werte austauschbar und die Wahl des Marktes egal.
 *
 * Die Tiefe bestimmt, wie viel Einfluss eine Order hat: Bei 400.000 $ Tiefe
 * bewegt ein Kauf ueber 4.000 $ den Kurs um rund ein Prozent. Man merkt sich
 * selbst im Chart.
 */
export const SIM_ASSETS: readonly SimAssetDef[] = [
  {
    symbol: 'ANKR',
    name: 'Anker Industrie',
    blurb: 'Langweilig und verlaesslich. Bewegt sich kaum, faellt aber auch nicht ins Bodenlose.',
    color: '#8ba3c7',
    startPriceCents: 12_000n,
    depthCents: 1_200_000_00n,
    params: { driftBpsPerMin: 0.4, volBpsPerMin: 12 },
  },
  {
    symbol: 'NOVA',
    name: 'Nova Energie',
    blurb: 'Solider Wachstumswert mit gelegentlichen Ausschlaegen.',
    color: '#5b8def',
    startPriceCents: 4_500n,
    depthCents: 800_000_00n,
    params: { driftBpsPerMin: 1.1, volBpsPerMin: 28 },
  },
  {
    symbol: 'HELIX',
    name: 'Helix Biotech',
    blurb: 'Haengt an Studienergebnissen. Entweder Rakete oder Ruine.',
    color: '#31c48d',
    startPriceCents: 2_800n,
    depthCents: 500_000_00n,
    params: { driftBpsPerMin: 0.9, volBpsPerMin: 52 },
  },
  {
    symbol: 'ORBIT',
    name: 'Orbit Logistik',
    blurb: 'Zyklisch. Laeuft in Wellen, wer den Rhythmus trifft, verdient.',
    color: '#d4a24c',
    startPriceCents: 7_600n,
    depthCents: 700_000_00n,
    params: { driftBpsPerMin: 0.2, volBpsPerMin: 38 },
  },
  {
    symbol: 'VOLT',
    name: 'Voltmark',
    blurb: 'Spekulativ bis zum Anschlag. Nichts fuer schwache Nerven.',
    color: '#f0555b',
    startPriceCents: 950n,
    depthCents: 300_000_00n,
    params: { driftBpsPerMin: -0.3, volBpsPerMin: 85 },
  },
  {
    symbol: 'GRAIN',
    name: 'Grain & Co',
    blurb: 'Rohstoffe. Traege, aber wenn sie laufen, laufen sie lange.',
    color: '#c9a227',
    startPriceCents: 3_400n,
    depthCents: 900_000_00n,
    params: { driftBpsPerMin: 0.5, volBpsPerMin: 20 },
  },
  {
    symbol: 'PIXL',
    name: 'Pixel Studios',
    blurb: 'Lebt von Hype. Steigt auf Geruechte und faellt auf Fakten.',
    color: '#a78bfa',
    startPriceCents: 1_800n,
    depthCents: 400_000_00n,
    params: { driftBpsPerMin: 0.6, volBpsPerMin: 70 },
  },
  {
    symbol: 'FORT',
    name: 'Fortis Bank',
    blurb: 'Der ruhige Pol. Wer keine Lust auf Achterbahn hat, parkt hier.',
    color: '#7b8794',
    startPriceCents: 21_000n,
    depthCents: 1_500_000_00n,
    params: { driftBpsPerMin: 0.3, volBpsPerMin: 9 },
  },
];

export const SIM_ASSET_BY_SYMBOL = new Map(SIM_ASSETS.map((asset) => [asset.symbol, asset]));

/** Ereignisse, die den Markt in Bewegung bringen. */
export interface EventTemplate {
  key: string;
  headline: string;
  /** Zusaetzlicher Trend je Minute in Basispunkten. */
  driftBpsPerMin: number;
  /** Dauer in Minuten. */
  minutes: number;
}

/**
 * Ereignisse sind der eigentliche Spielinhalt.
 *
 * Ein Markt, der nur zufaellig zittert, belohnt niemanden fuer
 * Aufmerksamkeit. Ein angekuendigtes Ereignis dagegen schon: Wer den Feed
 * liest und schnell ist, verdient daran - wer schlaeft, kauft am Hoch.
 */
export const EVENTS: readonly EventTemplate[] = [
  { key: 'deal', headline: 'Grossauftrag fuer {name}', driftBpsPerMin: 60, minutes: 4 },
  { key: 'study', headline: '{name} meldet Studienerfolg', driftBpsPerMin: 110, minutes: 3 },
  { key: 'hype', headline: 'Geruechte um {name} machen die Runde', driftBpsPerMin: 45, minutes: 5 },
  { key: 'upgrade', headline: 'Analysten stufen {name} hoch', driftBpsPerMin: 35, minutes: 6 },
  { key: 'probe', headline: 'Ermittlungen gegen {name}', driftBpsPerMin: -90, minutes: 4 },
  { key: 'miss', headline: '{name} verfehlt die Erwartungen', driftBpsPerMin: -70, minutes: 5 },
  { key: 'recall', headline: '{name} ruft Produkte zurueck', driftBpsPerMin: -120, minutes: 3 },
  { key: 'panic', headline: 'Abverkauf bei {name}', driftBpsPerMin: -150, minutes: 2 },
];

export function eventHeadline(template: EventTemplate, assetName: string): string {
  return template.headline.replace('{name}', assetName);
}

/**
 * Wuerfelt aus, ob gerade ein Ereignis eintritt.
 *
 * `chancePerMinute` liegt bewusst niedrig: Ereignisse sollen besonders sein.
 * Passiert staendig etwas, achtet niemand mehr darauf.
 */
export function rollEvent(
  rng: Rng,
  elapsedMs: number,
  chancePerMinute: number,
): EventTemplate | null {
  const minutes = Math.max(0, elapsedMs) / 60_000;
  if (minutes <= 0) return null;
  if (!rng.chance(Math.min(0.9, chancePerMinute * minutes))) return null;

  return rng.pick(EVENTS);
}
