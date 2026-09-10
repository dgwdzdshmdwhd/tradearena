/**
 * Der Markt fuer selbst gestartete Coins.
 *
 * Es gibt kein Orderbuch und keine Gegenpartei - der Preis entsteht aus einem
 * Liquiditaetspool nach der Konstantproduktformel `x * y = k`, genau wie bei
 * Uniswap oder pump.fun:
 *
 *   Preis = USD-Reserve / Token-Reserve
 *
 * Wer kauft, gibt USD in den Pool und nimmt Token heraus. Dadurch steigt die
 * USD-Reserve, die Token-Reserve sinkt, der Preis steigt. Drei Dinge ergeben
 * sich daraus von selbst, ohne dass wir irgendetwas simulieren muessen:
 *
 *   - Slippage: wer einen grossen Teil des Pools kauft, zahlt brutal drauf
 *   - Kleine Pools sind extrem volatil, grosse traege
 *   - Ein Rugpull ist nichts Magisches, sondern das Abziehen der Reserve
 *
 * WICHTIG - die Invariante: `k` darf durch keinen Trade kleiner werden.
 * Alle Rundungen gehen deshalb zugunsten des Pools. Sonst koennte jemand
 * durch tausende Mikro-Trades Geld aus dem Nichts erzeugen, und das ist
 * genau die Sorte Bug, die eine ganze Liga ruiniert.
 */

import {
  BPS,
  abs,
  divRound,
  isqrt,
  min,
  notionalCents,
  priceFromNotional,
  type Cents,
  type Price,
  type Qty,
} from './money.js';

export interface Pool {
  reserveUsdCents: Cents;
  reserveTokens: Qty;
  /** Handelsgebuehr, die im Pool bleibt und damit den Liquiditaetsgebern gehoert. */
  feeBps: number;
  /** Summe aller ausgegebenen LP-Anteile. */
  lpShares: bigint;
}

export interface TradeResult {
  pool: Pool;
  feeCents: Cents;
  /** Durchschnittlich gezahlter/erhaltener Preis je Token. */
  avgPrice: Price;
  /** Wie weit der Trade den Kurs bewegt hat, in Basispunkten. */
  priceImpactBps: bigint;
}

export interface BuyResult extends TradeResult {
  tokensOut: Qty;
  spentCents: Cents;
}

export interface SellResult extends TradeResult {
  tokensIn: Qty;
  proceedsCents: Cents;
}

/** Aktueller Kurs des Coins. */
export function poolPrice(pool: Pool): Price {
  if (pool.reserveTokens <= 0n) return 0n;
  return priceFromNotional(pool.reserveUsdCents, pool.reserveTokens, 'half_up');
}

/** Die Invariante k. Muss nach jedem Trade groesser oder gleich dem Vorwert sein. */
export function poolK(pool: Pool): bigint {
  return pool.reserveUsdCents * pool.reserveTokens;
}

/** Marktkapitalisierung auf Basis des aktuellen Kurses. */
export function marketCapCents(pool: Pool, totalSupply: Qty): Cents {
  return notionalCents(poolPrice(pool), totalSupply, 'half_up');
}

export function createPool(args: {
  usdCents: Cents;
  tokens: Qty;
  feeBps: number;
}): { pool: Pool; lpShares: bigint } {
  if (args.usdCents <= 0n) throw new RangeError('createPool: Startliquiditaet muss positiv sein');
  if (args.tokens <= 0n) throw new RangeError('createPool: Token-Menge muss positiv sein');

  // Erste LP-Anteile: geometrisches Mittel beider Reserven. So haengt die
  // Anzahl der Anteile nicht davon ab, in welcher Einheit man rechnet.
  const lpShares = isqrt(args.usdCents * args.tokens);

  return {
    pool: {
      reserveUsdCents: args.usdCents,
      reserveTokens: args.tokens,
      feeBps: args.feeBps,
      lpShares,
    },
    lpShares,
  };
}

/** Kauf: USD rein, Token raus. */
export function ammBuy(pool: Pool, spendCents: Cents): BuyResult {
  if (spendCents <= 0n) throw new RangeError('ammBuy: Betrag muss positiv sein');
  assertLiquid(pool);

  const spotBefore = poolPrice(pool);
  const feeCents = divRound(spendCents * BigInt(pool.feeBps), BPS, 'ceil');
  const netCents = spendCents - feeCents;
  if (netCents <= 0n) throw new RangeError('ammBuy: Betrag zu klein, alles waere Gebuehr');

  const k = poolK(pool);
  const usdAfterSwap = pool.reserveUsdCents + netCents;
  // Aufrunden: der Pool behaelt lieber einen Token zu viel als zu wenig.
  const tokensAfter = divRound(k, usdAfterSwap, 'ceil');
  const tokensOut = pool.reserveTokens - tokensAfter;

  if (tokensOut <= 0n) {
    throw new RangeError('ammBuy: Betrag zu klein fuer diesen Pool');
  }

  // Die Gebuehr bleibt im Pool und gehoert damit den Liquiditaetsgebern.
  const next: Pool = {
    ...pool,
    reserveUsdCents: pool.reserveUsdCents + spendCents,
    reserveTokens: tokensAfter,
  };

  const avgPrice = priceFromNotional(netCents, tokensOut, 'half_up');

  return {
    pool: next,
    tokensOut,
    spentCents: spendCents,
    feeCents,
    avgPrice,
    priceImpactBps: impactBps(spotBefore, avgPrice),
  };
}

/** Verkauf: Token rein, USD raus. */
export function ammSell(pool: Pool, tokensIn: Qty): SellResult {
  if (tokensIn <= 0n) throw new RangeError('ammSell: Menge muss positiv sein');
  assertLiquid(pool);

  const spotBefore = poolPrice(pool);
  const k = poolK(pool);
  const tokensAfter = pool.reserveTokens + tokensIn;
  // Aufrunden: der Pool gibt lieber einen Cent zu wenig heraus.
  const usdAfter = divRound(k, tokensAfter, 'ceil');
  const grossCents = pool.reserveUsdCents - usdAfter;

  if (grossCents <= 0n) {
    throw new RangeError('ammSell: Menge zu klein fuer diesen Pool');
  }

  const feeCents = divRound(grossCents * BigInt(pool.feeBps), BPS, 'ceil');
  const proceedsCents = grossCents - feeCents;

  const next: Pool = {
    ...pool,
    // Die Gebuehr bleibt im Pool.
    reserveUsdCents: usdAfter + feeCents,
    reserveTokens: tokensAfter,
  };

  const avgPrice = priceFromNotional(proceedsCents, tokensIn, 'half_up');

  return {
    pool: next,
    tokensIn,
    proceedsCents,
    feeCents,
    avgPrice,
    priceImpactBps: impactBps(spotBefore, avgPrice),
  };
}

/**
 * Wie viel USD brauche ich, um eine bestimmte Menge Token zu bekommen?
 * (Fuer das Orderticket: "ich will genau 1.000.000 $MOONBOY".)
 */
export function ammQuoteBuyExactTokens(pool: Pool, tokensWanted: Qty): Cents {
  assertLiquid(pool);
  if (tokensWanted <= 0n) throw new RangeError('ammQuoteBuyExactTokens: Menge muss positiv sein');
  if (tokensWanted >= pool.reserveTokens) {
    throw new RangeError('ammQuoteBuyExactTokens: mehr Token als im Pool vorhanden');
  }

  const k = poolK(pool);
  const tokensAfter = pool.reserveTokens - tokensWanted;
  const usdAfter = divRound(k, tokensAfter, 'ceil');
  const netNeeded = usdAfter - pool.reserveUsdCents;

  // Gebuehr aufschlagen: netNeeded = spend * (1 - fee) -> spend = net / (1 - fee)
  const denominator = BPS - BigInt(pool.feeBps);
  return divRound(netNeeded * BPS, denominator, 'ceil');
}

export interface LiquidityChange {
  pool: Pool;
  shares: bigint;
  usdCents: Cents;
  tokens: Qty;
}

/** Liquiditaet hinzufuegen - immer im aktuellen Verhaeltnis des Pools. */
export function ammAddLiquidity(pool: Pool, usdCents: Cents): LiquidityChange {
  assertLiquid(pool);
  if (usdCents <= 0n) throw new RangeError('ammAddLiquidity: Betrag muss positiv sein');

  const tokens = divRound(usdCents * pool.reserveTokens, pool.reserveUsdCents, 'ceil');
  const shares = min(
    divRound(usdCents * pool.lpShares, pool.reserveUsdCents, 'floor'),
    divRound(tokens * pool.lpShares, pool.reserveTokens, 'floor'),
  );

  return {
    pool: {
      ...pool,
      reserveUsdCents: pool.reserveUsdCents + usdCents,
      reserveTokens: pool.reserveTokens + tokens,
      lpShares: pool.lpShares + shares,
    },
    shares,
    usdCents,
    tokens,
  };
}

/**
 * Liquiditaet abziehen.
 *
 * Das ist der Rugpull. Es passiert nichts Magisches: der Liquiditaetsgeber
 * nimmt seinen Anteil an beiden Reserven mit. Weil die USD-Reserve schrumpft,
 * faellt der Kurs fuer alle anderen ins Bodenlose. Das Geld ist dabei exakt
 * das Geld, das die Kaeufer vorher hineingesteckt haben - nichts entsteht,
 * nichts verschwindet, es wird nur umverteilt.
 */
export function ammRemoveLiquidity(pool: Pool, shares: bigint): LiquidityChange {
  assertLiquid(pool);
  if (shares <= 0n) throw new RangeError('ammRemoveLiquidity: Anteile muessen positiv sein');
  if (shares > pool.lpShares) {
    throw new RangeError('ammRemoveLiquidity: mehr Anteile als ausgegeben');
  }

  const usdOut = divRound(shares * pool.reserveUsdCents, pool.lpShares, 'floor');
  const tokensOut = divRound(shares * pool.reserveTokens, pool.lpShares, 'floor');

  return {
    pool: {
      ...pool,
      reserveUsdCents: pool.reserveUsdCents - usdOut,
      reserveTokens: pool.reserveTokens - tokensOut,
      lpShares: pool.lpShares - shares,
    },
    shares,
    usdCents: usdOut,
    tokens: tokensOut,
  };
}

/**
 * Wie gefaehrlich ist dieser Coin? Wird im UI als Warnung angezeigt, damit
 * niemand behaupten kann, er haette es nicht sehen koennen.
 */
export function rugRisk(args: {
  pool: Pool;
  creatorShares: bigint;
  lpLockUntil: number | null;
  now: number;
}): { score: number; locked: boolean; creatorSharePct: number } {
  const locked = args.lpLockUntil !== null && args.lpLockUntil > args.now;
  const creatorSharePct =
    args.pool.lpShares > 0n ? Number((args.creatorShares * 10_000n) / args.pool.lpShares) / 100 : 0;

  // 0 = harmlos, 100 = der Ersteller kann dich jederzeit ausknipsen.
  const score = locked ? Math.round(creatorSharePct * 0.2) : Math.round(creatorSharePct);
  return { score, locked, creatorSharePct };
}

function impactBps(spotBefore: Price, avgPrice: Price): bigint {
  if (spotBefore <= 0n) return 0n;
  return (abs(avgPrice - spotBefore) * BPS) / spotBefore;
}

function assertLiquid(pool: Pool): void {
  if (pool.reserveUsdCents <= 0n || pool.reserveTokens <= 0n) {
    throw new RangeError('Pool hat keine Liquiditaet mehr - der Coin ist tot.');
  }
}
