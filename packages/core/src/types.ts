import type { Cents, Price, Qty } from './money.js';

export type Side = 'buy' | 'sell';
export type PositionSide = 'long' | 'short';

export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';

/** Time in Force: Day-Order verfaellt zum Handelsschluss, GTC bleibt liegen. */
export type TimeInForce = 'day' | 'gtc';

export type OrderStatus =
  | 'pending'
  | 'working'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired';

/** Taker nimmt Liquiditaet (teurer), Maker stellt sie bereit (guenstiger). */
export type Liquidity = 'taker' | 'maker';

export type AssetClass = 'crypto' | 'stock';

/** Woher der Preis kommt: von der echten Boerse oder aus unserem eigenen AMM-Pool. */
export type PriceSource = 'external' | 'amm';

export interface Instrument {
  id: string;
  /** Symbol bei der Datenquelle, z. B. BTCUSDT. */
  symbol: string;
  /** Anzeigename, z. B. BTC/USD oder $MOONBOY. */
  display: string;
  assetClass: AssetClass;
  priceSource: PriceSource;
  /** Kleinste handelbare Menge. */
  qtyStep: Qty;
  /** Kleinster Preisschritt. */
  priceStep: Price;
  /** Mindest-Ordervolumen. */
  minNotionalCents: Cents;
}

/**
 * Ein Kurs-Schnappschuss. Fuer Krypto liefert Binance bid/ask direkt und echt,
 * fuer Quellen ohne Bid/Ask erzeugen wir sie in `quote.ts` synthetisch.
 */
export interface Quote {
  bid: Price;
  ask: Price;
  last: Price;
  /** Unix-Millisekunden. */
  at: number;
}

export interface FeeConfig {
  /** Gebuehr in Basispunkten, wenn man Liquiditaet nimmt (Market-Order). */
  takerBps: number;
  /** Gebuehr in Basispunkten fuer ruhende Limit-Orders, die getroffen werden. */
  makerBps: number;
  /** Fixbetrag pro Trade, z. B. 99 = 0,99 $. */
  fixedCents: Cents;
}

export interface SlippageConfig {
  /**
   * Staerke des Effekts in Basispunkten bei einer Order in Hoehe der
   * Referenztiefe und normaler Volatilitaet. 0 schaltet Slippage ab.
   */
  factorBps: number;
  /** Referenztiefe des Marktes in Cent. Grosse Maerkte = grosse Zahl. */
  refDepthCents: Cents;
}

export interface LeagueRules {
  fees: FeeConfig;
  slippage: SlippageConfig;
  /** Taegliche Leihgebuehr fuer Short-Positionen in Basispunkten. */
  shortBorrowBpsDaily: number;
  /** 1 = kein Hebel. 5 = bis zu fuenffache Position. */
  maxLeverage: number;
  /** Unter diesem Anteil der Positionsgroesse wird liquidiert. */
  maintenanceMarginBps: number;
}

/** Ein einzelner Ausfuehrungsvorgang - die kleinste Wahrheit der Engine. */
export interface Fill {
  /** Tatsaechlicher Ausfuehrungspreis inklusive Slippage. */
  price: Price;
  qty: Qty;
  /** Volumen zum Ausfuehrungspreis, immer positiv. */
  grossCents: Cents;
  feeCents: Cents;
  /** Was die Slippage gegenueber dem reinen Bid/Ask gekostet hat. */
  slippageCents: Cents;
  /** Veraenderung des Barbestands: negativ beim Kauf, positiv beim Verkauf. */
  cashDeltaCents: Cents;
  liquidity: Liquidity;
}

export interface PositionState {
  /** Positiv = long, negativ = short, 0 = flach. */
  qty: Qty;
  /** Durchschnittlicher Einstandskurs der offenen Menge. */
  avgEntry: Price;
  realizedPnlCents: Cents;
}

export const FLAT_POSITION: PositionState = {
  qty: 0n,
  avgEntry: 0n,
  realizedPnlCents: 0n,
};

/** Sinnvolle Standardwerte: nah an einem guenstigen Krypto-Broker. */
export const DEFAULT_RULES: LeagueRules = {
  fees: { takerBps: 10, makerBps: 4, fixedCents: 0n },
  slippage: { factorBps: 8, refDepthCents: 5_000_000_00n }, // 5 Mio USD
  shortBorrowBpsDaily: 8,
  maxLeverage: 1,
  maintenanceMarginBps: 5000,
};
