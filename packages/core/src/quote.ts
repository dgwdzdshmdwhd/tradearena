import { BPS, divRound, type Price } from './money.js';
import type { Quote, Side } from './types.js';

/**
 * Kurs-Schnappschuss aus einem einzelnen Preis erzeugen.
 *
 * Fuer Krypto brauchen wir das nicht - Binance liefert per `bookTicker`
 * echtes Bid und Ask. Aber viele Gratis-Aktienquellen liefern nur den letzten
 * Kurs. Dann bauen wir den Spread selbst, damit der Realismus erhalten bleibt:
 * kaufen zum Ask, verkaufen zum Bid, nie zum Mittelkurs.
 */
export function syntheticQuote(last: Price, spreadBps: number, at: number = Date.now()): Quote {
  // Halber Spread je Seite. Bewusst als Ganzzahl-Division durch 2 * BPS,
  // damit auch ein ungerader Spread wie 5 bps kein Fliesskomma braucht.
  const bps = BigInt(Math.max(0, Math.trunc(spreadBps)));
  const half = divRound(last * bps, BPS * 2n, 'ceil');
  const bid = last - half > 0n ? last - half : last;
  return { bid, ask: last + half, last, at };
}

/**
 * Der Preis, zu dem eine Market-Order ausgefuehrt wird, BEVOR Slippage
 * draufkommt. Kaufen zum Ask, verkaufen zum Bid - nie zum Mittelkurs.
 * Das allein macht ueber viele Trades einen sichtbaren Unterschied und ist
 * einer der Gruende, warum haeufiges Handeln in echt so teuer ist.
 */
export function referencePrice(quote: Quote, side: Side): Price {
  return side === 'buy' ? quote.ask : quote.bid;
}

/** Spread in Basispunkten, gemessen am Mittelkurs. */
export function spreadBps(quote: Quote): bigint {
  const mid = (quote.bid + quote.ask) / 2n;
  if (mid <= 0n) return 0n;
  return ((quote.ask - quote.bid) * 10_000n) / mid;
}

export function midPrice(quote: Quote): Price {
  return (quote.bid + quote.ask) / 2n;
}
