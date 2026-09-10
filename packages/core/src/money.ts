/**
 * Geld-Arithmetik fuer TradeArena.
 *
 * Grundregel: In dieser Datei und ueberall, wo Geld fliesst, gibt es KEINE
 * Fliesskommazahlen. `0.1 + 0.2 !== 0.3` ist in einer Trading-Engine kein
 * Schoenheitsfehler, sondern ein Bug-Generator: nach ein paar tausend Trades
 * stimmt die Rangliste nicht mehr und niemand kann erklaeren, warum.
 *
 * Deshalb ist alles `bigint` mit einer festen Skala:
 *
 *   Cents  = 1e-2 USD   -> Cash, PnL, Gebuehren, Equity
 *   Price  = 1e-8 USD   -> Kurse (reicht auch fuer Coins mit 0,00000123 $)
 *   Qty    = 1e-8 Stueck -> Mengen (Coins wie Aktien)
 *
 * Gerundet wird immer EXPLIZIT. Es gibt keine stillschweigende Rundung.
 */

/** Preis-Skala: 1 USD entspricht 100_000_000 Einheiten. */
export const PRICE_SCALE = 100_000_000n;
/** Mengen-Skala: 1 Stueck/Coin entspricht 100_000_000 Einheiten. */
export const QTY_SCALE = 100_000_000n;
/** Cent-Skala: 1 USD entspricht 100 Cent. */
export const CENTS_PER_USD = 100n;

/**
 * Preis * Menge ergibt 1e-16 USD. Um daraus Cent (1e-2 USD) zu machen,
 * teilen wir durch 1e14.
 */
export const NOTIONAL_DIVISOR = (PRICE_SCALE * QTY_SCALE) / CENTS_PER_USD; // 1e14

/** Basispunkte: 10_000 bps = 100 %. */
export const BPS = 10_000n;

export type Cents = bigint;
export type Price = bigint;
export type Qty = bigint;

export type Rounding =
  /** Richtung null (wie die normale bigint-Division). */
  | 'trunc'
  /** Richtung minus unendlich. */
  | 'floor'
  /** Richtung plus unendlich. */
  | 'ceil'
  /** Ab exakt der Haelfte weg von der Null. */
  | 'half_up';

/**
 * Division mit explizitem Rundungsmodus. `denominator` muss positiv sein.
 * Negative Zaehler werden korrekt behandelt - genau da versagen naive
 * Implementierungen, und genau da entstehen bei Short-Positionen die Fehler.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  if (denominator <= 0n) {
    throw new RangeError(`divRound: denominator muss positiv sein, war ${denominator}`);
  }

  const quotient = numerator / denominator; // trunkiert Richtung null
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  switch (mode) {
    case 'trunc':
      return quotient;
    case 'floor':
      return numerator < 0n ? quotient - 1n : quotient;
    case 'ceil':
      return numerator > 0n ? quotient + 1n : quotient;
    case 'half_up': {
      const twiceRest = (remainder < 0n ? -remainder : remainder) * 2n;
      if (twiceRest < denominator) return quotient;
      return numerator < 0n ? quotient - 1n : quotient + 1n;
    }
  }
}

/** (a * b) / divisor mit explizitem Rundungsmodus, ohne Zwischen-Ueberlauf. */
export function mulDiv(a: bigint, b: bigint, divisor: bigint, mode: Rounding): bigint {
  return divRound(a * b, divisor, mode);
}

/** Anteil in Basispunkten, z. B. `applyBps(10_000n, 25)` = 25 Cent von 100 $. */
export function applyBps(value: bigint, bps: number | bigint, mode: Rounding = 'half_up'): bigint {
  return divRound(value * BigInt(bps), BPS, mode);
}

/**
 * Ordervolumen in Cent.
 *
 * Standardrundung ist `half_up`; wer den Spieler bewusst schlechter stellen
 * will (Gebuehren!), uebergibt `ceil`.
 */
export function notionalCents(price: Price, qty: Qty, mode: Rounding = 'half_up'): Cents {
  return divRound(price * qty, NOTIONAL_DIVISOR, mode);
}

/** Wie viele Stueck bekomme ich fuer einen Geldbetrag? (Immer abgerundet.) */
export function qtyFromNotional(cents: Cents, price: Price, mode: Rounding = 'floor'): Qty {
  if (price <= 0n) throw new RangeError('qtyFromNotional: Preis muss positiv sein');
  return divRound(cents * NOTIONAL_DIVISOR, price, mode);
}

/** Welcher Preis steckt hinter einem Geldbetrag fuer eine bestimmte Menge? */
export function priceFromNotional(cents: Cents, qty: Qty, mode: Rounding = 'half_up'): Price {
  if (qty <= 0n) throw new RangeError('priceFromNotional: Menge muss positiv sein');
  return divRound(cents * NOTIONAL_DIVISOR, qty, mode);
}

/** Absolutbetrag fuer bigint. */
export function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Vorzeichen als -1n | 0n | 1n. */
export function sign(v: bigint): bigint {
  if (v > 0n) return 1n;
  if (v < 0n) return -1n;
  return 0n;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Ganzzahlige Quadratwurzel (Newton-Verfahren).
 * Wird fuer das Slippage-Modell gebraucht - auch dort wollen wir kein `Math.sqrt`,
 * damit dasselbe Ergebnis auf jedem Rechner exakt gleich herauskommt.
 */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError('isqrt: negativer Wert');
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * Dezimalstring in eine skalierte bigint umwandeln.
 * `parseDecimal('43218.505', PRICE_SCALE)` -> 4321850500000n
 *
 * Ueberzaehlige Nachkommastellen werden abgeschnitten, nicht gerundet:
 * Eingaben sollen nie heimlich groesser werden, als der Nutzer getippt hat.
 */
export function parseDecimal(input: string | number, scale: bigint): bigint {
  const raw = typeof input === 'number' ? numberToPlainString(input) : input.trim();
  if (raw === '') throw new SyntaxError('parseDecimal: leere Eingabe');

  const normalised = raw.replace(/\s/g, '').replace(',', '.');
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(normalised);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new SyntaxError(`parseDecimal: '${raw}' ist keine Zahl`);
  }

  const negative = match[1] === '-';
  const whole = match[2] === '' ? '0' : (match[2] as string);
  const decimals = scaleDecimals(scale);
  const fractionRaw = match[3] ?? '';
  const fraction = fractionRaw.slice(0, decimals).padEnd(decimals, '0');

  const value = BigInt(whole) * scale + (decimals > 0 ? BigInt(fraction) : 0n);
  return negative ? -value : value;
}

/** Skalierte bigint als Dezimalstring, ohne Tausendertrennzeichen. */
export function formatScaled(value: bigint, scale: bigint, decimals?: number): string {
  const scaleDigits = scaleDecimals(scale);
  const wanted = decimals ?? scaleDigits;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(scaleDigits, '0');

  let out = whole.toString();
  if (wanted > 0) {
    const cut = fraction.slice(0, wanted).padEnd(wanted, '0');
    out += `.${cut}`;
  }
  return negative && magnitude !== 0n ? `-${out}` : out;
}

export const parsePrice = (input: string | number): Price => parseDecimal(input, PRICE_SCALE);
export const parseQty = (input: string | number): Qty => parseDecimal(input, QTY_SCALE);
export const parseUsd = (input: string | number): Cents => parseDecimal(input, CENTS_PER_USD);

export const formatPrice = (price: Price, decimals = 2): string =>
  formatScaled(price, PRICE_SCALE, decimals);
export const formatQty = (qty: Qty, decimals = 8): string => formatScaled(qty, QTY_SCALE, decimals);
export const formatUsd = (cents: Cents, decimals = 2): string =>
  formatScaled(cents, CENTS_PER_USD, decimals);

/** Auf ein Vielfaches von `step` abrunden (Lot-Groesse der Boerse). */
export function roundToStep(value: bigint, step: bigint, mode: Rounding = 'floor'): bigint {
  if (step <= 0n) return value;
  return divRound(value, step, mode) * step;
}

function scaleDecimals(scale: bigint): number {
  let decimals = 0;
  let rest = scale;
  while (rest > 1n) {
    if (rest % 10n !== 0n) throw new RangeError(`Skala ${scale} ist keine Zehnerpotenz`);
    rest /= 10n;
    decimals += 1;
  }
  return decimals;
}

/** Verhindert, dass aus 1e-7 der String '1e-7' wird. */
function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) throw new SyntaxError(`parseDecimal: ${value} ist keine Zahl`);
  if (!/e/i.test(String(value))) return String(value);
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}
