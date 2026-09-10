/**
 * Zahlen formatieren.
 *
 * Der Server schickt Geld, Preise und Mengen als Zeichenketten mit fester
 * Skala (Cent, 1e-8). Umgerechnet wird erst hier, kurz vor der Anzeige -
 * gerechnet wird nie im Browser.
 */

const usd = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });

export const PRICE_SCALE = 100_000_000;
export const QTY_SCALE = 100_000_000;

export function centsToNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value) / 100;
}

export function priceToNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value) / PRICE_SCALE;
}

export function qtyToNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value) / QTY_SCALE;
}

/** 1.234.567,89 $ */
export function fmtUsd(cents: string | number | null | undefined, withSign = false): string {
  const value = centsToNumber(cents);
  const sign = withSign && value > 0 ? '+' : '';
  return `${sign}${usd.format(value)} $`;
}

/** Kompakt fuer enge Spalten: 1,2 Mio. $ */
export function fmtUsdCompact(cents: string | number | null | undefined): string {
  return `${compact.format(centsToNumber(cents))} $`;
}

/**
 * Kurse: BTC braucht zwei Nachkommastellen, ein Memecoin zehn.
 * Die Zahl bestimmt selbst, wie genau sie angezeigt wird.
 */
export function fmtPrice(price: string | number | null | undefined): string {
  const value = priceToNumber(price);
  if (value === 0) return '0,00';
  if (value >= 1000) return usd.format(value);
  if (value >= 1) return value.toLocaleString('de-DE', { maximumFractionDigits: 4 });
  if (value >= 0.0001) return value.toLocaleString('de-DE', { maximumFractionDigits: 8 });
  return value.toLocaleString('de-DE', { maximumFractionDigits: 12 });
}

export function fmtQty(qty: string | number | null | undefined): string {
  const value = qtyToNumber(qty);
  if (Math.abs(value) >= 1_000_000) return compact.format(value);
  if (Math.abs(value) >= 1) return value.toLocaleString('de-DE', { maximumFractionDigits: 4 });
  return value.toLocaleString('de-DE', { maximumFractionDigits: 8 });
}

/** Basispunkte als Prozent: 1234 -> +12,34 % */
export function fmtBps(bps: string | number | null | undefined, withSign = true): string {
  const value = Number(bps ?? 0) / 100;
  const sign = withSign && value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`;
}

export function fmtPct(value: number, digits = 1): string {
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: digits })} %`;
}

export function fmtTime(at: number | string | null | undefined): string {
  if (!at) return '';
  return new Date(Number(at)).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function fmtDateTime(at: number | string | null | undefined): string {
  if (!at) return '';
  return new Date(Number(at)).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "noch 2 Std. 14 Min." */
export function fmtCountdown(until: number | null | undefined): string {
  if (!until) return '-';
  const ms = Number(until) - Date.now();
  if (ms <= 0) return 'vorbei';

  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;

  if (days > 0) return `${days} T ${hours} Std.`;
  if (hours > 0) return `${hours} Std. ${rest} Min.`;
  if (minutes > 0) return `${minutes} Min. ${Math.floor((ms % 60_000) / 1000)} Sek.`;
  return `${Math.floor(ms / 1000)} Sek.`;
}

export function fmtDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} Std.`;
  return `${Math.round(hours / 24)} Tage`;
}

/** Rendite eines Kontos in Basispunkten. */
export function returnBps(equityCents: string, startCents: string): number {
  const start = Number(startCents);
  if (!start) return 0;
  return Math.round(((Number(equityCents) - start) / start) * 10_000);
}

export function signClass(value: number): string {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'muted';
}

/** Menge in die Server-Skala bringen (Eingabefeld -> API). */
export function toScaled(input: string, scale: number): string {
  const cleaned = input.replace(/\s/g, '').replace(',', '.');
  if (!cleaned || Number.isNaN(Number(cleaned))) return '0';

  const [whole, fraction = ''] = cleaned.split('.');
  const digits = String(scale).length - 1;
  const padded = fraction.slice(0, digits).padEnd(digits, '0');

  return String(BigInt(whole || '0') * BigInt(scale) + BigInt(padded || '0'));
}

export const toCents = (input: string): string => toScaled(input, 100);
export const toPrice = (input: string): string => toScaled(input, PRICE_SCALE);
export const toQty = (input: string): string => toScaled(input, QTY_SCALE);
