/**
 * Der Arena-Markt auf dem Server.
 *
 * Haelt die Kurse der erfundenen Werte, bewegt sie bei jedem Takt und
 * verteilt Ereignisse. Zwei Dinge sind wichtig:
 *
 *   1. Der Kurs steckt in einem Liquiditaetspool (`amm.ts`). Handelt jemand,
 *      bewegt sich der Kurs automatisch - das ist der Einfluss, den man als
 *      Spieler haben soll. An einer echten Boerse waere die eigene Order ein
 *      Staubkorn.
 *   2. Die Kurse sind global, nicht pro Liga. Alle sehen dasselbe, und wer
 *      in Liga A kauft, bewegt den Kurs auch fuer Liga B. Das ist Absicht:
 *      ein Markt, viele Tische.
 *
 * Im Arbeitsspeicher liegt die Wahrheit waehrend des Betriebs, die Datenbank
 * bekommt sie regelmaessig zu sehen. Trades schreiben sofort durch - dabei
 * wechselt Geld den Besitzer, das darf kein Neustart verschlucken.
 */

import {
  EVENTS,
  FACTOR_SCALE,
  SIM_ASSETS,
  applyFactor,
  createRng,
  eventHeadline,
  poolPrice,
  rollEvent,
  seedFrom,
  stepFactor,
  type Candle,
  type Pool,
  type Quote,
  type SimParams,
} from '@tradearena/core';

import type { Db } from './db.js';
import type { Hub } from './hub.js';
import { big, int, newId, now } from './util.js';

/** Wie oft die Kurse neu berechnet werden. */
const TICK_MS = 1_000;
/** Wie oft der Stand in die Datenbank geschrieben wird. */
const PERSIST_MS = 15_000;
/** Wie viele Minutenkerzen je Wert aufgehoben werden. */
const MAX_CANDLES = 600;
/** Wahrscheinlichkeit je Minute und Wert, dass ein Ereignis eintritt. */
const EVENT_CHANCE_PER_MINUTE = 0.035;
/**
 * Wie viele Minuten Vorgeschichte ein neuer Wert bekommt.
 *
 * Ein Chart, der bei der ersten Kerze anfaengt, sieht kaputt aus, und die
 * Bots ruehren sich erst ab dreissig Kerzen - ohne Vorgeschichte stuende ein
 * frisch gekaufter Bot eine halbe Stunde still. Erfunden ist diese
 * Vergangenheit nicht mehr als der Rest dieses Marktes: Sie entsteht aus
 * derselben Rechnung, wird einmal gespeichert und ist danach fuer alle
 * dieselbe. (Bei echten Boersenkursen waere das eine Faelschung - dort wird
 * nichts erfunden.)
 */
const BACKFILL_MINUTES = 180;

export interface SimAssetState {
  instrumentId: string;
  symbol: string;
  name: string;
  blurb: string;
  color: string;
  pool: Pool;
  params: SimParams;
  event: { key: string; headline: string; driftBpsPerMin: number; until: number } | null;
  candles: Candle[];
  /** Kurs vor 60 Minuten, fuer die Prozentanzeige. */
  openOfDay: number;
}

export class SimMarket {
  private readonly assets = new Map<string, SimAssetState>();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private lastPersist = 0;
  private lastCandleMinute = 0;

  /** Wird gesetzt, damit Ereignisse im Liga-Feed landen koennen. */
  onEvent: ((asset: SimAssetState, headline: string, up: boolean) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
  ) {}

  // ------------------------------------------------------------- Aufbau

  /**
   * Legt fehlende Werte an und laedt den gespeicherten Stand.
   * Laeuft bei jedem Start und ergaenzt nur, was fehlt.
   */
  async load(): Promise<void> {
    const at = now();

    for (const def of SIM_ASSETS) {
      let instrument = await this.db.get<{ id: string }>(
        "SELECT id FROM instruments WHERE symbol = ? AND kind = 'sim'",
        [def.symbol],
      );

      if (!instrument) {
        const id = newId();
        await this.db.run(
          `INSERT INTO instruments (id, league_id, symbol, display, kind, price_source,
                                    qty_step, price_step, min_notional, active, created_at)
           VALUES (?, NULL, ?, ?, 'sim', 'sim', '10000', '1', '100', 1, ?)`,
          [id, def.symbol, def.symbol, at],
        );
        instrument = { id };
      }

      const row = await this.db.get<{
        reserve_usd: string;
        reserve_tokens: string;
        event_key: string | null;
        event_drift_bps: number | null;
        event_until: number | null;
      }>('SELECT * FROM sim_assets WHERE instrument_id = ?', [instrument.id]);

      if (!row) {
        // Reserven so waehlen, dass der gewuenschte Startkurs herauskommt:
        // Kurs = USD * 1e14 / Token, also Token = USD * 1e14 / Kurs.
        const priceScaled = def.startPriceCents * 1_000_000n;
        const tokens = (def.depthCents * 100_000_000_000_000n) / priceScaled;

        await this.db.run(
          `INSERT INTO sim_assets (instrument_id, symbol, name, blurb, color, reserve_usd,
                                   reserve_tokens, drift_bps, vol_bps, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            instrument.id,
            def.symbol,
            def.name,
            def.blurb,
            def.color,
            def.depthCents.toString(),
            tokens.toString(),
            Math.round(def.params.driftBpsPerMin * 10),
            Math.round(def.params.volBpsPerMin * 10),
            at,
          ],
        );
      }

      const state = await this.db.get<{
        reserve_usd: string;
        reserve_tokens: string;
        event_key: string | null;
        event_drift_bps: number | null;
        event_until: number | null;
      }>('SELECT * FROM sim_assets WHERE instrument_id = ?', [instrument.id]);

      const pool: Pool = {
        reserveUsdCents: big(state?.reserve_usd ?? def.depthCents.toString()),
        reserveTokens: big(state?.reserve_tokens ?? '1'),
        feeBps: 0,
        lpShares: 0n,
      };

      const candles = await this.db.all<{ t: number; o: number; h: number; l: number; c: number; v: number }>(
        'SELECT t, o, h, l, c, v FROM sim_candles WHERE instrument_id = ? ORDER BY t ASC',
        [instrument.id],
      );

      const history =
        candles.length > 0
          ? candles.map((candle) => ({
              t: int(candle.t),
              o: Number(candle.o),
              h: Number(candle.h),
              l: Number(candle.l),
              c: Number(candle.c),
              v: Number(candle.v),
            }))
          : await this.backfill(instrument.id, def.symbol, pool, def.params, at);

      this.assets.set(instrument.id, {
        instrumentId: instrument.id,
        symbol: def.symbol,
        name: def.name,
        blurb: def.blurb,
        color: def.color,
        pool,
        params: def.params,
        event:
          state?.event_key && state.event_until && int(state.event_until) > at
            ? {
                key: state.event_key,
                headline: state.event_key,
                driftBpsPerMin: int(state.event_drift_bps) / 10,
                until: int(state.event_until),
              }
            : null,
        candles: history,
        openOfDay: 0,
      });
    }

    console.log(`[arena] ${this.assets.size} Werte geladen`);
  }

  start(): void {
    this.lastTick = Date.now();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // --------------------------------------------------------------- Takt

  private async tick(): Promise<void> {
    const at = Date.now();
    const elapsed = at - this.lastTick;
    this.lastTick = at;
    if (elapsed <= 0) return;

    for (const asset of this.assets.values()) {
      // Der Seed haengt an Wert und Sekunde: reproduzierbar, aber fuer jeden
      // Wert eine eigene Bewegung.
      const rng = createRng(seedFrom(asset.symbol, Math.floor(at / 1_000)));

      const factor = stepFactor(rng, asset.params, elapsed, asset.event, at);
      asset.pool = {
        ...asset.pool,
        reserveUsdCents: applyFactor(asset.pool.reserveUsdCents, factor),
      };

      if (!asset.event || asset.event.until <= at) {
        asset.event = null;
        const template = rollEvent(rng, elapsed, EVENT_CHANCE_PER_MINUTE);
        if (template) this.startEvent(asset, template, at);
      }

      this.updateCandle(asset, at);
    }

    this.hub.broadcastPrices(this.quotes());

    if (at - this.lastPersist >= PERSIST_MS) {
      this.lastPersist = at;
      await this.persist(at);
    }
  }

  private startEvent(
    asset: SimAssetState,
    template: (typeof EVENTS)[number],
    at: number,
  ): void {
    const headline = eventHeadline(template, asset.name);

    asset.event = {
      key: template.key,
      headline,
      driftBpsPerMin: template.driftBpsPerMin,
      until: at + template.minutes * 60_000,
    };

    this.onEvent?.(asset, headline, template.driftBpsPerMin > 0);
  }

  /**
   * Erfindet einem neuen Wert eine Vergangenheit - rueckwaerts gerechnet, damit
   * die letzte Kerze genau auf dem Kurs endet, den der Pool gerade hat.
   */
  private async backfill(
    instrumentId: string,
    symbol: string,
    pool: Pool,
    params: SimParams,
    at: number,
  ): Promise<Candle[]> {
    const current = Number(poolPrice(pool)) / 1e8;
    if (!Number.isFinite(current) || current <= 0) return [];

    const rng = createRng(seedFrom(`${symbol}:historie`));
    const scale = Number(FACTOR_SCALE);

    const closes = [current];
    for (let step = 0; step < BACKFILL_MINUTES; step += 1) {
      const factor = Number(stepFactor(rng, params, 60_000)) / scale;
      const previous = closes[closes.length - 1]! / (factor > 0 ? factor : 1);
      closes.push(Number.isFinite(previous) && previous > 0 ? previous : current);
    }
    closes.reverse();

    const minute = Math.floor(at / 60_000) * 60_000;
    const candles: Candle[] = closes.map((close, index) => {
      const open = index === 0 ? close : closes[index - 1]!;
      const docht = Math.abs(close - open) * 0.6 + close * 0.0008;

      return {
        t: minute - (closes.length - 1 - index) * 60_000,
        o: open,
        h: Math.max(open, close) + docht,
        l: Math.max(close * 0.5, Math.min(open, close) - docht),
        c: close,
        v: 0,
      };
    });

    // Die letzte Kerze laeuft noch - die schreibt der normale Takt.
    for (const candle of candles.slice(0, -1)) {
      await this.db.run(
        `INSERT INTO sim_candles (instrument_id, t, o, h, l, c, v)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (instrument_id, t) DO NOTHING`,
        [instrumentId, candle.t, candle.o, candle.h, candle.l, candle.c, candle.v],
      );
    }

    return candles;
  }

  private updateCandle(asset: SimAssetState, at: number): void {
    const price = Number(poolPrice(asset.pool)) / 1e8;
    if (!Number.isFinite(price) || price <= 0) return;

    const minute = Math.floor(at / 60_000) * 60_000;
    const current = asset.candles[asset.candles.length - 1];

    if (current && current.t === minute) {
      current.c = price;
      current.h = Math.max(current.h, price);
      current.l = Math.min(current.l, price);
      return;
    }

    asset.candles.push({ t: minute, o: price, h: price, l: price, c: price, v: 0 });
    if (asset.candles.length > MAX_CANDLES) asset.candles.shift();
    this.lastCandleMinute = minute;
  }

  private async persist(at: number): Promise<void> {
    for (const asset of this.assets.values()) {
      await this.db.run(
        `UPDATE sim_assets SET reserve_usd = ?, reserve_tokens = ?, event_key = ?,
                               event_drift_bps = ?, event_until = ?, updated_at = ?
         WHERE instrument_id = ?`,
        [
          asset.pool.reserveUsdCents.toString(),
          asset.pool.reserveTokens.toString(),
          asset.event?.key ?? null,
          asset.event ? Math.round(asset.event.driftBpsPerMin * 10) : null,
          asset.event?.until ?? null,
          at,
          asset.instrumentId,
        ],
      );

      // Nur die gerade abgeschlossene Minute schreiben - alles andere waere
      // eine Flut aus Schreibvorgaengen fuer nichts.
      const fertig = asset.candles[asset.candles.length - 2];
      if (fertig) {
        await this.db.run(
          `INSERT INTO sim_candles (instrument_id, t, o, h, l, c, v)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (instrument_id, t) DO UPDATE SET o = ?, h = ?, l = ?, c = ?, v = ?`,
          [
            asset.instrumentId,
            fertig.t,
            fertig.o,
            fertig.h,
            fertig.l,
            fertig.c,
            fertig.v,
            fertig.o,
            fertig.h,
            fertig.l,
            fertig.c,
            fertig.v,
          ],
        );

        await this.db.run(
          'DELETE FROM sim_candles WHERE instrument_id = ? AND t < ?',
          [asset.instrumentId, at - MAX_CANDLES * 60_000],
        );
      }
    }
  }

  // ------------------------------------------------------------- Zugriff

  has(instrumentId: string): boolean {
    return this.assets.has(instrumentId);
  }

  asset(instrumentId: string): SimAssetState | null {
    return this.assets.get(instrumentId) ?? null;
  }

  all(): SimAssetState[] {
    return [...this.assets.values()];
  }

  pool(instrumentId: string): Pool | null {
    return this.assets.get(instrumentId)?.pool ?? null;
  }

  /**
   * Kurs mit Spanne. Ein reiner Pool hat keinen Spread - fuer das
   * Spielgefuehl (und damit haeufiges Hin und Her etwas kostet) legen wir
   * eine schmale Spanne darum.
   */
  quote(instrumentId: string): Quote | null {
    const asset = this.assets.get(instrumentId);
    if (!asset) return null;

    const price = poolPrice(asset.pool);
    if (price <= 0n) return null;

    const half = price / 10_000n; // 1 Basispunkt je Seite
    return {
      bid: price - half > 0n ? price - half : price,
      ask: price + half,
      last: price,
      at: Date.now(),
    };
  }

  candles(instrumentId: string): Candle[] {
    return this.assets.get(instrumentId)?.candles ?? [];
  }

  /** Veraenderung der letzten Stunde in Basispunkten. */
  changeBps(instrumentId: string): number {
    const asset = this.assets.get(instrumentId);
    if (!asset || asset.candles.length < 2) return 0;

    const last = asset.candles[asset.candles.length - 1]!.c;
    const reference = asset.candles[Math.max(0, asset.candles.length - 60)]!.o;
    if (reference <= 0) return 0;

    return Math.round(((last - reference) / reference) * 10_000);
  }

  /**
   * Nach einem Trade: der Pool hat sich veraendert, der Kurs damit auch.
   * Wird aus der Handelstransaktion heraus aufgerufen.
   */
  applyPool(instrumentId: string, pool: Pool): void {
    const asset = this.assets.get(instrumentId);
    if (!asset) return;
    asset.pool = pool;
  }

  quotes(): Record<string, { bid: string; ask: string; last: string; at: number }> {
    const out: Record<string, { bid: string; ask: string; last: string; at: number }> = {};

    for (const asset of this.assets.values()) {
      const quote = this.quote(asset.instrumentId);
      if (!quote) continue;
      out[asset.symbol] = {
        bid: quote.bid.toString(),
        ask: quote.ask.toString(),
        last: quote.last.toString(),
        at: quote.at,
      };
    }

    return out;
  }
}
