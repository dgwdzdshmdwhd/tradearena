import { randomBytes, randomUUID } from 'node:crypto';

/** Kurze, gut vorlesbare Einladungscodes - ohne 0/O und 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newId(): string {
  return randomUUID();
}

export function inviteCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export const now = (): number => Date.now();

/** Datenbankwert -> bigint. Alles Geld liegt als TEXT in der DB. */
export function big(value: unknown): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(String(value));
}

/** Wie `big`, aber null bleibt null (fuer optionale Preise). */
export function bigOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  return big(value);
}

/** bigint -> Datenbankwert. */
export const str = (value: bigint | null): string | null =>
  value === null ? null : value.toString();

export const int = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const bool = (value: unknown): boolean => value === 1 || value === true || value === '1';

export const flag = (value: boolean): number => (value ? 1 : 0);

export function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Tagesschluessel in UTC, fuer "Trades heute". */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Kappt Nutzertexte auf eine vernuenftige Laenge. */
export function trimText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

/**
 * Ein einfacher Schlossmechanismus.
 *
 * Alle schreibenden Vorgaenge laufen hier durch. Damit kann nicht passieren,
 * dass zwei gleichzeitige Orders denselben Kontostand lesen und beide
 * ausgefuehrt werden, obwohl das Geld nur einmal da ist. Klassische Race
 * Condition - und der Grund, warum manche Simulatoren "unendlich Geld"-Bugs
 * haben, wenn man schnell genug klickt.
 */
export class Mutex {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, message);
export const unauthorized = (message = 'Nicht angemeldet.'): HttpError =>
  new HttpError(401, message);
export const forbidden = (message = 'Keine Berechtigung.'): HttpError => new HttpError(403, message);
export const notFound = (message = 'Nicht gefunden.'): HttpError => new HttpError(404, message);
