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
  MEME_DEFS,
  MEME_DEPTH_CENTS,
  SIM_ASSETS,
  SIM_ASSET_BY_SYMBOL,
  applyFactor,
  createRng,
  decayHype,
  eventHeadline,
  hypeDriftBps,
  hypeHeat,
  poolPrice,
  rollEvent,
  rollMemePlan,
  seedFrom,
  segmentAt,
  stepFactor,
  type Candle,
  type MemeDef,
  type MemePhase,
  type MemePlan,
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

/** Abstand zwischen zwei Memecoin-Starts. */
const MEME_SPAWN_MS = 6 * 60_000;
/** Wie viele Memecoins gleichzeitig leben duerfen. */
const MEME_MAX_ALIVE = 3;
/**
 * Ab wann ein toter Memecoin aus der Liste verschwindet.
 *
 * Nicht sofort: Wer gerade alles verloren hat, soll noch sehen koennen, was
 * passiert ist. Wer noch Bestaende haelt, behaelt seinen Coin ohnehin - siehe
 * `retireDeadMemes`.
 */
const MEME_GRAVE_MS = 12 * 60_000;

/**
 * Wie stark der Kaufdruck der Spieler den Kurs zusaetzlich schiebt.
 *
 * Bei Memecoins deutlich staerker: Dort ist der Ansturm die Geschichte. Bei
 * den Aktien bleibt es ein Beiklang, sonst waere ihr Charakter beliebig.
 */
const HYPE_MAX_BPS_MEME = 900;
const HYPE_MAX_BPS_AKTIE = 120;
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
  /** Gesetzt, wenn dieser Wert ein Memecoin ist - dann steuert der Lebenslauf. */
  meme: MemeState | null;
  /** Kaufdruck der Spieler, zerfaellt mit der Zeit. Netto = Richtung. */
  hypeNet: number;
  /** Umsatz in beide Richtungen, fuer die Hitzeanzeige. */
  hypeGross: number;
  /** Tiefe des Pools bei Geburt - Bezugsgroesse fuer den Kaufdruck. */
  depthCents: number;
}

export interface MemeState {
  bornAt: number;
  plan: MemePlan;
  /** Der Startkurs, um "steht bei x-fach" anzeigen zu koennen. */
  startPrice: number;
  /** Hoechster je erreichter Kurs. */
  peakPrice: number;
  retiredAt: number | null;
}

export class SimMarket {
  private readonly assets = new Map<string, SimAssetState>();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private lastPersist = 0;
  private lastCandleMinute = 0;
  private lastMemeCheck = 0;
  /** Zeitstempel der zuletzt gespeicherten Kerze, je Wert. */
  private readonly lastWritten = new Map<string, number>();

  /** Wird gesetzt, damit Ereignisse im Liga-Feed landen koennen. */
  onEvent: ((asset: SimAssetState, headline: string, up: boolean) => void) | null = null;
  /** Wird gesetzt, damit ein Memecoin-Start alle erreicht. */
  onMeme: ((asset: SimAssetState) => void) | null = null;

  /**
   * Nimmt einen Spielertrade zur Kenntnis.
   *
   * Der Pool hat den Kurs da schon bewegt. Was hier gezaehlt wird, ist die
   * Nachwirkung: Kaufdruck, der den Kurs noch eine Weile traegt.
   */
  noteTrade(instrumentId: string, notionalCents: bigint, side: 'buy' | 'sell'): void {
    const asset = this.assets.get(instrumentId);
    if (!asset) return;

    const betrag = Number(notionalCents);
    if (!Number.isFinite(betrag) || betrag <= 0) return;

    asset.hypeNet += side === 'buy' ? betrag : -betrag;
    asset.hypeGross += betrag;
  }

  /** Hitze von 0 bis 100 fuer die Anzeige. */
  heat(instrumentId: string): number {
    const asset = this.assets.get(instrumentId);
    return asset ? hypeHeat(asset.hypeGross, asset.depthCents) : 0;
  }

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

      const stored = candles.map((candle) => ({
        t: int(candle.t),
        o: Number(candle.o),
        h: Number(candle.h),
        l: Number(candle.l),
        c: Number(candle.c),
        v: Number(candle.v),
      }));

      // Fehlt Vorgeschichte, wird sie vor den vorhandenen Teil gesetzt. Das
      // gilt auch fuer Werte, die schon ein paar Minuten laufen - sonst haette
      // ein am ersten Abend gestarteter Server dieselbe leere Wand wie ein
      // ganz neuer.
      const fehlend = BACKFILL_MINUTES - stored.length;
      const history =
        fehlend > 0
          ? [
              ...(await this.backfill(
                instrument.id,
                def.symbol,
                def.params,
                stored[0]?.o ?? Number(poolPrice(pool)) / 1e8,
                stored[0]?.t ?? Math.floor(at / 60_000) * 60_000,
                fehlend,
              )),
              ...stored,
            ]
          : stored;

      // Was schon in der Datenbank steht, muss nicht noch einmal geschrieben
      // werden - sonst laeuft nach jedem Neustart die ganze Historie durch.
      this.lastWritten.set(instrument.id, history[history.length - 2]?.t ?? 0);

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
        meme: null,
        hypeNet: 0,
        hypeGross: 0,
        depthCents: Number(def.depthCents),
      });
    }

    await this.loadMemes(at);

    const memes = [...this.assets.values()].filter((asset) => asset.meme).length;
    console.log(`[arena] ${this.assets.size - memes} Werte, ${memes} Memecoins geladen`);
  }

  /**
   * Holt die noch lebenden Memecoins aus der Datenbank zurueck.
   *
   * Ihr Lebenslauf steht dort als JSON. Wichtig, dass er gespeichert wird und
   * nicht neu gewuerfelt: Ein Neustart des Servers darf aus einem Coin, der
   * gerade im Abverkauf ist, nicht wieder eine Rakete machen.
   */
  private async loadMemes(at: number): Promise<void> {
    const rows = await this.db.all<{
      instrument_id: string;
      symbol: string;
      name: string;
      blurb: string;
      color: string;
      reserve_usd: string;
      reserve_tokens: string;
      born_at: number | null;
      plan: string | null;
      retired_at: number | null;
    }>('SELECT * FROM sim_assets WHERE born_at IS NOT NULL AND retired_at IS NULL', []);

    for (const row of rows) {
      let plan: MemePlan;
      try {
        plan = JSON.parse(String(row.plan)) as MemePlan;
        if (!Array.isArray(plan.segments) || plan.segments.length === 0) continue;
      } catch {
        continue;
      }

      const pool: Pool = {
        reserveUsdCents: big(row.reserve_usd),
        reserveTokens: big(row.reserve_tokens),
        feeBps: 0,
        lpShares: 0n,
      };

      const candles = await this.db.all<{ t: number; o: number; h: number; l: number; c: number; v: number }>(
        'SELECT t, o, h, l, c, v FROM sim_candles WHERE instrument_id = ? ORDER BY t ASC',
        [row.instrument_id],
      );

      const history = candles.map((candle) => ({
        t: int(candle.t),
        o: Number(candle.o),
        h: Number(candle.h),
        l: Number(candle.l),
        c: Number(candle.c),
        v: Number(candle.v),
      }));

      this.lastWritten.set(row.instrument_id, history[history.length - 2]?.t ?? 0);

      this.assets.set(row.instrument_id, {
        instrumentId: row.instrument_id,
        symbol: row.symbol,
        name: row.name,
        blurb: row.blurb,
        color: row.color,
        pool,
        params: segmentAt(plan, at - int(row.born_at)).params,
        event: null,
        candles: history,
        openOfDay: 0,
        meme: {
          bornAt: int(row.born_at),
          plan,
          startPrice: history[0]?.o ?? Number(poolPrice(pool)) / 1e8,
          peakPrice: history.reduce((max, candle) => Math.max(max, candle.h), 0),
          retiredAt: null,
        },
        hypeNet: 0,
        hypeGross: 0,
        depthCents: Number(MEME_DEPTH_CENTS),
      });
    }
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
      // Ein kaputter Pool wird sofort repariert, nicht erst beim naechsten
      // Neustart - sonst steht der Markt den ganzen Abend still.
      if (await this.healIfBroken(asset, at)) continue;

      // Der Seed haengt an Wert und Sekunde: reproduzierbar, aber fuer jeden
      // Wert eine eigene Bewegung.
      const rng = createRng(seedFrom(asset.symbol, Math.floor(at / 1_000)));

      // Der Kaufdruck der Spieler verblasst mit der Zeit von selbst.
      asset.hypeNet = decayHype(asset.hypeNet, elapsed);
      asset.hypeGross = decayHype(asset.hypeGross, elapsed);

      // Beim Memecoin bestimmt der Lebenslauf den Grundtrend, nicht ein
      // fester Charakter. Deshalb wird er bei jedem Takt neu abgelesen.
      if (asset.meme) {
        asset.params = segmentAt(asset.meme.plan, at - asset.meme.bornAt).params;
      }

      const params = this.withHype(asset);
      const factor = stepFactor(rng, params, elapsed, asset.event, at);
      asset.pool = {
        ...asset.pool,
        reserveUsdCents: applyFactor(asset.pool.reserveUsdCents, factor),
      };

      // Nachrichten gibt es nur fuer Aktien. Ein Memecoin hat keine
      // Geschaeftszahlen, er hat eine Stimmung.
      if (!asset.meme && (!asset.event || asset.event.until <= at)) {
        asset.event = null;
        const template = rollEvent(rng, elapsed, EVENT_CHANCE_PER_MINUTE);
        if (template) this.startEvent(asset, template, at);
      }

      this.updateCandle(asset, at);

      if (asset.meme) {
        const price = Number(poolPrice(asset.pool)) / 1e8;
        if (price > asset.meme.peakPrice) asset.meme.peakPrice = price;
      }
    }

    this.hub.broadcastPrices(this.quotes());

    // Die Memecoins haengen am selben Takt wie der ganze Markt. Ein Fehler
    // beim Starten oder Abraeumen darf nicht die Kurse aller anderen Werte
    // mit anhalten.
    try {
      await this.tickMemes(at);
    } catch (error) {
      console.error('[meme] Takt fehlgeschlagen:', (error as Error).message);
    }

    if (at - this.lastPersist >= PERSIST_MS) {
      this.lastPersist = at;
      await this.persist(at);
    }
  }

  /**
   * Setzt einen zerstoerten Pool wieder instand.
   *
   * Eine Aktie mit 12 bis 85 Basispunkten Schwankung je Minute erreicht auf
   * natuerlichem Weg nie ein Prozent ihres Startkurses - wer das sieht, sieht
   * einen Schaden. Am 11.09. war es ein Leerverkauf gegen die Kurve, der
   * GRAIN in einer Minute von 55 $ auf 0,0000009 $ gedrueckt hat (die Luecke
   * ist in `trading.ts` geschlossen). Ohne diese Reparatur bliebe der Markt
   * danach fuer immer tot: Bei einem Kurs von faktisch null kauft niemand
   * mehr genug Token zurueck, um ihn anzuheben.
   *
   * Bestaende bleiben unberuehrt. Wer Stueck haelt, hat sie hinterher noch -
   * sie sind nur wieder etwas wert.
   */
  private async healIfBroken(asset: SimAssetState, at: number): Promise<boolean> {
    if (asset.meme) return false;

    const def = SIM_ASSET_BY_SYMBOL.get(asset.symbol);
    if (!def) return false;

    const price = Number(poolPrice(asset.pool)) / 1e8;
    const start = Number(def.startPriceCents) / 100;
    if (Number.isFinite(price) && price > start * 0.01) return false;

    const priceScaled = def.startPriceCents * 1_000_000n;
    const tokens = (def.depthCents * 100_000_000_000_000n) / priceScaled;

    asset.pool = {
      ...asset.pool,
      reserveUsdCents: def.depthCents,
      reserveTokens: tokens,
    };

    await this.db.run(
      'UPDATE sim_assets SET reserve_usd = ?, reserve_tokens = ?, updated_at = ? WHERE instrument_id = ?',
      [def.depthCents.toString(), tokens.toString(), at, asset.instrumentId],
    );

    console.log(`[arena] ${asset.symbol} war bei ${price} - Pool wiederhergestellt`);
    this.onEvent?.(asset, `Handel in ${asset.name} wurde neu eroeffnet`, true);
    return true;
  }

  /**
   * Rechnet den Kaufdruck der Spieler in den Trend ein.
   *
   * Das ist die zweite Haelfte des Versprechens "du hast Einfluss": Die erste
   * wirkt sofort ueber den Pool, diese hier laesst den Kurs danach noch eine
   * Weile weiterlaufen. Wer mit Freunden gemeinsam kauft, sieht das im Chart.
   */
  private withHype(asset: SimAssetState): SimParams {
    const max = asset.meme ? HYPE_MAX_BPS_MEME : HYPE_MAX_BPS_AKTIE;
    const extra = hypeDriftBps(asset.hypeNet, asset.depthCents, max);
    if (extra === 0) return asset.params;

    return { ...asset.params, driftBpsPerMin: asset.params.driftBpsPerMin + extra };
  }

  // --------------------------------------------------------- Memecoins

  /**
   * Startet neue Memecoins und raeumt tote weg.
   *
   * Der Takt ist so gewaehlt, dass an einem Abend staendig irgendwo etwas
   * laeuft, ohne dass man den Ueberblick verliert: alle paar Minuten einer,
   * hoechstens drei gleichzeitig.
   */
  private async tickMemes(at: number): Promise<void> {
    if (at - this.lastMemeCheck < 5_000) return;
    this.lastMemeCheck = at;

    await this.retireDeadMemes(at);

    const lebend = [...this.assets.values()].filter(
      (asset) => asset.meme && !this.isBuriedAsset(asset, at),
    );
    if (lebend.length >= MEME_MAX_ALIVE) return;

    const juengster = lebend.reduce((max, asset) => Math.max(max, asset.meme!.bornAt), 0);
    if (at - juengster < MEME_SPAWN_MS) return;

    await this.spawnMeme(at);
  }

  private isBuriedAsset(asset: SimAssetState, at: number): boolean {
    if (!asset.meme) return false;
    const phase = segmentAt(asset.meme.plan, at - asset.meme.bornAt).phase;
    return phase === 'grab' || phase === 'ruhe';
  }

  /** Bringt einen neuen Memecoin an den Markt. */
  private async spawnMeme(at: number): Promise<void> {
    // Namen, die gerade in Benutzung sind, fallen weg - zwei PUMPFISCH
    // gleichzeitig waeren nur verwirrend.
    const belegt = new Set([...this.assets.values()].map((asset) => asset.symbol));
    const frei = MEME_DEFS.filter((def) => !belegt.has(def.symbol));
    if (frei.length === 0) return;

    const rng = createRng(seedFrom('meme', at));
    const def: MemeDef = rng.pick(frei);
    const plan = rollMemePlan(rng);

    // Startkurs zwischen 0,01 $ und 0,40 $ - tief genug, dass ein
    // Zehnfacher noch nach Groschen aussieht.
    const startPriceCents = BigInt(1 + Math.floor(rng.next() * 40));
    const tokens = (MEME_DEPTH_CENTS * 100_000_000_000_000n) / (startPriceCents * 1_000_000n);

    const id = newId();
    await this.db.run(
      `INSERT INTO instruments (id, league_id, symbol, display, kind, price_source,
                                qty_step, price_step, min_notional, active, created_at)
       VALUES (?, NULL, ?, ?, 'sim', 'sim', '10000', '1', '100', 1, ?)`,
      [id, def.symbol, def.symbol, at],
    );

    await this.db.run(
      `INSERT INTO sim_assets (instrument_id, symbol, name, blurb, color, reserve_usd,
                               reserve_tokens, drift_bps, vol_bps, born_at, plan, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      [
        id,
        def.symbol,
        def.name,
        def.blurb,
        def.color,
        MEME_DEPTH_CENTS.toString(),
        tokens.toString(),
        at,
        JSON.stringify(plan),
        at,
      ],
    );

    const pool: Pool = {
      reserveUsdCents: MEME_DEPTH_CENTS,
      reserveTokens: tokens,
      feeBps: 0,
      lpShares: 0n,
    };
    const startPrice = Number(poolPrice(pool)) / 1e8;

    this.assets.set(id, {
      instrumentId: id,
      symbol: def.symbol,
      name: def.name,
      blurb: def.blurb,
      color: def.color,
      pool,
      params: segmentAt(plan, 0).params,
      event: null,
      // Memecoins bekommen bewusst keine Vorgeschichte. Sie sind gerade erst
      // entstanden; ein Chart, der drei Stunden zurueckreicht, waere gelogen.
      candles: [],
      openOfDay: startPrice,
      meme: { bornAt: at, plan, startPrice, peakPrice: startPrice, retiredAt: null },
      hypeNet: 0,
      hypeGross: 0,
      depthCents: Number(MEME_DEPTH_CENTS),
    });

    console.log(`[meme] ${def.symbol} gestartet (${plan.archetype})`);
    this.onMeme?.(this.assets.get(id)!);
  }

  /**
   * Nimmt tote Memecoins aus dem Markt - aber nur die, die niemand mehr haelt.
   *
   * Ein Wert, auf den noch eine Position laeuft, muss handelbar und bewertbar
   * bleiben. Sonst haette jemand eine Leiche im Depot, die er nicht loswird.
   */
  private async retireDeadMemes(at: number): Promise<void> {
    for (const asset of this.assets.values()) {
      if (!asset.meme || asset.meme.retiredAt) continue;

      const alter = at - asset.meme.bornAt;
      const phase = segmentAt(asset.meme.plan, alter).phase;
      if (phase !== 'grab') continue;

      const seitBeerdigung = alter - this.graveStart(asset);
      if (seitBeerdigung < MEME_GRAVE_MS) continue;

      const gehalten = await this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM positions WHERE instrument_id = ? AND qty <> '0'`,
        [asset.instrumentId],
      );
      if (int(gehalten?.n) > 0) continue;

      await this.db.run('UPDATE instruments SET active = 0 WHERE id = ?', [asset.instrumentId]);
      await this.db.run('UPDATE sim_assets SET retired_at = ? WHERE instrument_id = ?', [
        at,
        asset.instrumentId,
      ]);
      await this.db.run('DELETE FROM sim_candles WHERE instrument_id = ?', [asset.instrumentId]);

      asset.meme.retiredAt = at;
      this.assets.delete(asset.instrumentId);
      console.log(`[meme] ${asset.symbol} abgeraeumt`);
    }
  }

  /** Ab wann der Coin im Grab liegt, in Millisekunden seit Geburt. */
  private graveStart(asset: SimAssetState): number {
    const segments = asset.meme?.plan.segments ?? [];
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]!.phase === 'grab') return i === 0 ? 0 : segments[i - 1]!.endsAt;
    }
    return Number.MAX_SAFE_INTEGER;
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
   * Rechnet einem Wert die fehlende Vergangenheit vor - rueckwaerts vom
   * Ankerpunkt, damit die erzeugte Reihe genau dort ansetzt, wo die echte
   * anfaengt. Keine Stufe, keine Luecke.
   */
  private async backfill(
    instrumentId: string,
    symbol: string,
    params: SimParams,
    anchorPrice: number,
    anchorMinute: number,
    count: number,
  ): Promise<Candle[]> {
    if (!Number.isFinite(anchorPrice) || anchorPrice <= 0 || count <= 0) return [];

    const rng = createRng(seedFrom(`${symbol}:historie`));
    const scale = Number(FACTOR_SCALE);
    const minute = Math.floor(anchorMinute / 60_000) * 60_000;

    const closes = [anchorPrice];
    for (let step = 0; step < count; step += 1) {
      const factor = Number(stepFactor(rng, params, 60_000)) / scale;
      const previous = closes[closes.length - 1]! / (factor > 0 ? factor : 1);
      closes.push(Number.isFinite(previous) && previous > 0 ? previous : anchorPrice);
    }
    closes.reverse();

    // Der Ankerpunkt selbst gehoert nicht dazu - er existiert schon.
    const candles: Candle[] = closes.slice(0, -1).map((close, index) => {
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

    for (const candle of candles) {
      await this.db.run(
        `INSERT INTO sim_candles (instrument_id, t, o, h, l, c, v)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (instrument_id, t) DO NOTHING`,
        [instrumentId, candle.t, candle.o, candle.h, candle.l, candle.c, candle.v],
      );
    }

    return candles;
  }

  /**
   * Kerzenbreite.
   *
   * Eine Aktie begleitet einen ueber Stunden, da ist die Minute richtig. Ein
   * Memecoin lebt zwanzig Minuten - mit Minutenkerzen waere sein ganzes Leben
   * ein Chart aus zwanzig Balken, und in den ersten zwei Minuten, in denen
   * man einsteigen will, stuenden dort zwei. Deshalb fuenf Sekunden.
   */
  private bucketMs(asset: SimAssetState): number {
    return asset.meme ? 5_000 : 60_000;
  }

  private updateCandle(asset: SimAssetState, at: number): void {
    const price = Number(poolPrice(asset.pool)) / 1e8;
    if (!Number.isFinite(price) || price <= 0) return;

    const bucket = this.bucketMs(asset);
    const slot = Math.floor(at / bucket) * bucket;
    const current = asset.candles[asset.candles.length - 1];

    if (current && current.t === slot) {
      current.c = price;
      current.h = Math.max(current.h, price);
      current.l = Math.min(current.l, price);
      return;
    }

    asset.candles.push({ t: slot, o: price, h: price, l: price, c: price, v: 0 });
    if (asset.candles.length > MAX_CANDLES) asset.candles.shift();
    this.lastCandleMinute = slot;
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

      // Alle abgeschlossenen Kerzen seit dem letzten Mal - bei Memecoins
      // sind das mehrere je Durchgang, weil ihre Kerzen fuenf Sekunden
      // breit sind. Die laufende bleibt aussen vor, die schreibt der
      // naechste Durchgang.
      const bucket = this.bucketMs(asset);
      const seit = this.lastWritten.get(asset.instrumentId) ?? 0;
      const fertige = asset.candles.slice(0, -1).filter((candle) => candle.t > seit);

      for (const fertig of fertige) {
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
      }

      const letzte = fertige[fertige.length - 1];
      if (letzte) {
        this.lastWritten.set(asset.instrumentId, letzte.t);
        await this.db.run('DELETE FROM sim_candles WHERE instrument_id = ? AND t < ?', [
          asset.instrumentId,
          at - MAX_CANDLES * bucket,
        ]);
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

  /**
   * Was der Client ueber einen Memecoin wissen darf.
   *
   * Die Phase steht ausdruecklich drin, der Lebenslauf nicht. Man soll sehen
   * koennen, dass ein Coin "ueberhitzt" ist - aber nicht, wann genau der
   * Absturz kommt. Sonst waere die Entscheidung keine mehr.
   */
  memeInfo(
    instrumentId: string,
    at = Date.now(),
  ): { phase: MemePhase; ageMs: number; multiple: number; fromPeakBps: number } | null {
    const asset = this.assets.get(instrumentId);
    if (!asset?.meme) return null;

    const ageMs = at - asset.meme.bornAt;
    const price = Number(poolPrice(asset.pool)) / 1e8;
    const start = asset.meme.startPrice > 0 ? asset.meme.startPrice : price;
    const peak = asset.meme.peakPrice > 0 ? asset.meme.peakPrice : price;

    return {
      phase: segmentAt(asset.meme.plan, ageMs).phase,
      ageMs,
      multiple: start > 0 ? price / start : 1,
      fromPeakBps: peak > 0 ? Math.round(((price - peak) / peak) * 10_000) : 0,
    };
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
