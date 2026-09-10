import { computeFeeCents } from './fees.js';
import { abs, notionalCents, roundToStep, type Cents, type Price, type Qty } from './money.js';
import { referencePrice } from './quote.js';
import { BASE_VOL_BPS, applySlippageToPrice, slippageBps } from './slippage.js';
import type { Fill, Instrument, LeagueRules, Liquidity, Quote, Side } from './types.js';

export interface MarketExecutionInput {
  side: Side;
  qty: Qty;
  quote: Quote;
  rules: LeagueRules;
  /** Aktuelle Volatilitaet in Basispunkten. Fehlt sie, nehmen wir "normal" an. */
  volBps?: number | bigint;
  liquidity?: Liquidity;
}

/**
 * Fuehrt eine Market-Order aus.
 *
 * Reine Funktion: gleiche Eingabe, gleiches Ergebnis - kein Zufall, keine Uhr,
 * keine Datenbank. Genau deshalb koennen wir sie so hart testen, und genau
 * deshalb kann der Worker sie nach einem Neustart identisch wiederholen.
 */
export function executeMarket(input: MarketExecutionInput): Fill {
  const { side, qty, quote, rules } = input;
  if (qty <= 0n) throw new RangeError('executeMarket: Menge muss positiv sein');

  const liquidity: Liquidity = input.liquidity ?? 'taker';

  // 1. Referenzpreis: kaufen zum Ask, verkaufen zum Bid.
  const reference = referencePrice(quote, side);
  if (reference <= 0n) throw new RangeError('executeMarket: ungueltiger Kurs');

  const referenceGross = notionalCents(reference, qty, 'half_up');

  // 2. Slippage aus Ordergroesse und Volatilitaet.
  const bps = slippageBps(referenceGross, input.volBps ?? BASE_VOL_BPS, rules.slippage);
  const price = applySlippageToPrice(reference, side, bps);

  // 3. Volumen zum tatsaechlichen Preis, gerundet zu Lasten des Spielers.
  const grossCents = notionalCents(price, qty, side === 'buy' ? 'ceil' : 'floor');
  const slippageCents = abs(grossCents - referenceGross);

  // 4. Gebuehren.
  const feeCents = computeFeeCents(grossCents, rules.fees, liquidity);

  // 5. Kassenwirkung.
  const cashDeltaCents: Cents = side === 'buy' ? -(grossCents + feeCents) : grossCents - feeCents;

  return { price, qty, grossCents, feeCents, slippageCents, cashDeltaCents, liquidity };
}

/**
 * Ausfuehrung zu einem bereits feststehenden Preis (Limit-Order, die getroffen
 * wurde, Liquidation, Eroeffnungskurs nach einer Kursluecke).
 * Hier gibt es keine Slippage - der Preis ist ja bereits bekannt.
 */
export function executeAtPrice(
  side: Side,
  qty: Qty,
  price: Price,
  rules: LeagueRules,
  liquidity: Liquidity = 'maker',
): Fill {
  if (qty <= 0n) throw new RangeError('executeAtPrice: Menge muss positiv sein');
  if (price <= 0n) throw new RangeError('executeAtPrice: Preis muss positiv sein');

  const grossCents = notionalCents(price, qty, side === 'buy' ? 'ceil' : 'floor');
  const feeCents = computeFeeCents(grossCents, rules.fees, liquidity);
  const cashDeltaCents: Cents = side === 'buy' ? -(grossCents + feeCents) : grossCents - feeCents;

  return { price, qty, grossCents, feeCents, slippageCents: 0n, cashDeltaCents, liquidity };
}

export type OrderRejection =
  | { ok: true }
  | { ok: false; reason: string; code: 'qty' | 'min_notional' | 'funds' | 'price' };

/**
 * Pruefung VOR der Ausfuehrung. Laeuft serverseitig - der Client darf sich
 * dieselbe Pruefung gern anzeigen lassen, aber verlassen tun wir uns nur
 * auf diese hier.
 */
export function validateOrder(args: {
  instrument: Instrument;
  qty: Qty;
  quote: Quote;
  side: Side;
  availableCashCents: Cents;
  rules: LeagueRules;
}): OrderRejection {
  const { instrument, qty, quote, side, availableCashCents, rules } = args;

  if (qty <= 0n) {
    return { ok: false, code: 'qty', reason: 'Menge muss groesser als null sein.' };
  }

  const stepped = roundToStep(qty, instrument.qtyStep, 'floor');
  if (stepped !== qty) {
    return {
      ok: false,
      code: 'qty',
      reason: `Menge muss ein Vielfaches der Lot-Groesse sein.`,
    };
  }

  if (quote.bid <= 0n || quote.ask <= 0n) {
    return { ok: false, code: 'price', reason: 'Fuer dieses Instrument liegt kein Kurs vor.' };
  }

  const preview = executeMarket({ side, qty, quote, rules });

  if (preview.grossCents < instrument.minNotionalCents) {
    return {
      ok: false,
      code: 'min_notional',
      reason: 'Ordervolumen liegt unter dem Mindestbetrag.',
    };
  }

  if (side === 'buy' && -preview.cashDeltaCents > availableCashCents) {
    return {
      ok: false,
      code: 'funds',
      reason: 'Nicht genug Kaufkraft fuer diese Order.',
    };
  }

  return { ok: true };
}

/** Wie viel Bargeld eine Kauforder bindet (Volumen plus Gebuehr). */
export function cashRequiredForBuy(fill: Fill): Cents {
  return fill.grossCents + fill.feeCents;
}
