/**
 * Der Handelsdienst - alles, was Geld bewegt.
 *
 * Grundsatz: Der Browser schickt nur Absichten ("kaufe 0,5 BTC"). Preis,
 * Gebuehren, Slippage und Kaufkraft entstehen ausschliesslich hier, mit den
 * Kursen des Servers. Ein manipulierter Client kann daher hoechstens eine
 * Order stellen, die abgelehnt wird.
 *
 * Jeder schreibende Vorgang laeuft durch ein Schloss und in einer
 * Transaktion. Wer zwanzigmal auf "Kaufen" haemmert, bekommt zwanzig
 * sauber nacheinander gepruefte Orders - und keine doppelte Buchung.
 */

import {
  ACHIEVEMENT_BY_KEY,
  DEFAULT_BOT_PARAMS,
  FLAT_POSITION,
  abs,
  accountEquityCents,
  ammRemoveLiquidity,
  ammSell,
  applyFillToPosition,
  applyUpgradesToFees,
  computeFeeCents,
  computeMargin,
  createPool,
  divRound,
  evaluateEvent,
  evaluateTrade,
  executeAtPrice,
  executeMarket,
  exposureCents,
  notionalCents,
  poolK,
  poolPrice,
  positionValueCents,
  priceFromNotional,
  resolveEffects,
  roundToStep,
  unrealizedPnlCents,
  type AchievementEvent,
  type Cents,
  type Fill,
  type LeagueRules,
  type Pool,
  type PositionState,
  type Price,
  type Qty,
  type Quote,
  type Side,
} from '@tradearena/core';

import type { Db } from './db.js';
import type { Hub } from './hub.js';
import type { MarketFeed } from './market.js';
import type { ReplayStore } from './replay.js';
import type { SimMarket } from './simmarket.js';
import {
  toAccount,
  toInstrument,
  toLeague,
  type Account,
  type AccountRow,
  type CoinRow,
  type Instrument,
  type InstrumentRow,
  type League,
  type LeagueRow,
  type OrderRow,
  type PositionRow,
} from './rows.js';
import {
  HttpError,
  Mutex,
  badRequest,
  big,
  bigOrNull,
  bool,
  dayKey,
  flag,
  forbidden,
  int,
  jsonParse,
  newId,
  notFound,
  now,
  trimText,
} from './util.js';

export interface PlaceOrderInput {
  leagueId: string;
  instrumentId: string;
  side: Side;
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  /** Menge in Stueck. Alternativ `notionalCents` fuer "kaufe fuer 500 $". */
  qty?: string;
  notionalCents?: string;
  limitPrice?: string;
  stopPrice?: string;
  trailBps?: number;
  tif?: 'day' | 'gtc';
  reduceOnly?: boolean;
  /** Automatischer Stop-Loss/Take-Profit an der entstehenden Position. */
  attachStopBps?: number;
  attachTakeProfitBps?: number;
  source?: 'human' | 'bot' | 'liquidation' | 'system';
  accountId?: string;
}

export interface FillSummary {
  orderId: string;
  status: string;
  filledQty: string;
  price: string | null;
  feeCents: string;
  realizedCents: string;
  message: string;
  /** Prestige, das dieser Trade eingebracht hat. */
  prestigeGained: number;
}

/**
 * Prestige fuer einen Trade.
 *
 * Ohne das waere die Tycoon-Ebene tot: Prestige gaebe es nur am Ligaende,
 * und waehrend des Spielens wuerde sich stundenlang nichts bewegen.
 *
 * Die Deckelung je Trade ist wichtig. Ohne sie koennte man mit einer einzigen
 * riesigen Order den halben Upgrade-Baum kaufen. Mit ihr bleibt der Weg
 * dahin: viele Trades - und die kosten Gebuehren, sind also nicht gratis.
 */
export function prestigeForTrade(grossCents: Cents, realizedCents: Cents): number {
  const volume = Math.min(15, Number(grossCents / 200_000n)); // 1 je 2.000 $
  const bonus = realizedCents > 0n ? 5 : 0;
  return Math.max(0, volume) + bonus;
}

export class Trading {
  constructor(
    readonly db: Db,
    readonly feed: MarketFeed,
    readonly replay: ReplayStore,
    readonly hub: Hub,
    readonly lock: Mutex,
    readonly sim: SimMarket,
  ) {}

  // ---------------------------------------------------------------- Laden

  async league(leagueId: string): Promise<League> {
    const row = await this.db.get<LeagueRow>('SELECT * FROM leagues WHERE id = ?', [leagueId]);
    if (!row) throw notFound('Liga nicht gefunden.');
    return toLeague(row);
  }

  async instrument(instrumentId: string): Promise<Instrument> {
    const row = await this.db.get<InstrumentRow>('SELECT * FROM instruments WHERE id = ?', [
      instrumentId,
    ]);
    if (!row) throw notFound('Instrument nicht gefunden.');
    return toInstrument(row);
  }

  async accountFor(leagueId: string, userId: string): Promise<Account> {
    const row = await this.db.get<AccountRow>(
      'SELECT * FROM accounts WHERE league_id = ? AND user_id = ? AND is_bot = 0',
      [leagueId, userId],
    );
    if (!row) throw forbidden('Du bist in dieser Liga nicht dabei.');
    return toAccount(row);
  }

  async accountById(accountId: string): Promise<Account> {
    const row = await this.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId]);
    if (!row) throw notFound('Konto nicht gefunden.');
    return toAccount(row);
  }

  async isMember(userId: string, leagueId: string): Promise<boolean> {
    const row = await this.db.get('SELECT user_id FROM league_members WHERE league_id = ? AND user_id = ?', [
      leagueId,
      userId,
    ]);
    return row !== null;
  }

  async coin(instrumentId: string): Promise<CoinRow | null> {
    return this.db.get<CoinRow>('SELECT * FROM coins WHERE instrument_id = ?', [instrumentId]);
  }

  // -------------------------------------------------------------- Preise

  /**
   * Der aktuelle Kurs eines Instruments.
   *
   * Drei Quellen, eine Schnittstelle: der Live-Feed fuer Krypto, der
   * AMM-Pool fuer selbst gestartete Coins, die Zeitmaschine fuer
   * Replay-Ligen.
   */
  async quoteFor(instrument: Instrument, league: League): Promise<Quote | null> {
    // Der Arena-Markt liegt im Arbeitsspeicher und bewegt sich jede Sekunde.
    if (instrument.priceSource === 'sim') {
      return this.sim.quote(instrument.id);
    }

    if (instrument.priceSource === 'amm') {
      const coin = await this.coin(instrument.id);
      if (!coin || coin.status !== 'live') return null;
      return poolQuote(toPool(coin));
    }

    if (league.mode === 'timemachine') {
      const cursor = league.replayCursor ?? league.replayFrom ?? 0;
      return this.replay.quoteAt(league.id, instrument.symbol, cursor);
    }

    return this.feed.quote(instrument.symbol);
  }

  volatilityFor(instrument: Instrument, league: League): number {
    if (instrument.priceSource === 'sim') {
      const candles = this.sim.candles(instrument.id);
      return candles.length > 25 ? volFromCandles(candles) : 100;
    }
    if (instrument.priceSource === 'amm') return 100;
    if (league.mode === 'timemachine') {
      const cursor = league.replayCursor ?? 0;
      const candles = this.replay.candlesUpTo(league.id, instrument.symbol, cursor);
      return candles.length > 25 ? Math.min(5_000, Math.max(1, volFromCandles(candles))) : 100;
    }
    return this.feed.volatility(instrument.symbol);
  }

  /** Liga-Regeln inklusive Tycoon-Upgrades des Spielers. */
  async rulesFor(league: League, userId: string): Promise<LeagueRules> {
    if (!league.upgradesAllowed) return league.rules;

    const rows = await this.db.all<{ upgrade_key: string; level: number }>(
      'SELECT upgrade_key, level FROM user_upgrades WHERE user_id = ?',
      [userId],
    );
    const effects = resolveEffects(new Map(rows.map((row) => [row.upgrade_key, int(row.level)])));

    const reduction = Math.min(90, effects.slippageReductionPct);
    return {
      ...league.rules,
      fees: applyUpgradesToFees(league.rules.fees, effects, true),
      slippage: {
        ...league.rules.slippage,
        factorBps: Math.round((league.rules.slippage.factorBps * (100 - reduction)) / 100),
      },
    };
  }

  // ------------------------------------------------------------- Orders

  async placeOrder(userId: string, input: PlaceOrderInput): Promise<FillSummary> {
    return this.lock.run(() => this.placeOrderLocked(userId, input));
  }

  private async placeOrderLocked(userId: string, input: PlaceOrderInput): Promise<FillSummary> {
    const league = await this.league(input.leagueId);
    if (league.status !== 'running') throw badRequest('Diese Liga laeuft nicht mehr.');

    const account = input.accountId
      ? await this.accountById(input.accountId)
      : await this.accountFor(league.id, userId);

    if (account.leagueId !== league.id) throw forbidden('Konto gehoert nicht zu dieser Liga.');
    if (!input.accountId && account.userId !== userId) throw forbidden('Fremdes Konto.');

    const member = await this.db.get<{ eliminated_at: number | null }>(
      'SELECT eliminated_at FROM league_members WHERE league_id = ? AND user_id = ?',
      [league.id, account.userId],
    );
    if (member?.eliminated_at) throw badRequest('Du bist aus dieser Liga ausgeschieden.');

    const instrument = await this.instrument(input.instrumentId);
    if (!instrument.active) throw badRequest('Dieses Instrument wird nicht mehr gehandelt.');
    if (instrument.leagueId && instrument.leagueId !== league.id) {
      throw forbidden('Dieser Coin gehoert zu einer anderen Liga.');
    }

    const quote = await this.quoteFor(instrument, league);
    if (!quote) throw badRequest('Fuer dieses Instrument liegt gerade kein Kurs vor.');

    const rules = await this.rulesFor(league, account.userId);
    const side = input.side === 'sell' ? 'sell' : 'buy';

    // Menge bestimmen: entweder direkt, oder aus einem Geldbetrag.
    let qty: Qty;
    if (input.notionalCents) {
      const spend = big(input.notionalCents);
      if (spend <= 0n) throw badRequest('Betrag muss groesser als null sein.');
      const reference = side === 'buy' ? quote.ask : quote.bid;
      qty = roundToStep(
        divRound(spend * 100_000_000_000_000n, reference, 'floor'),
        instrument.qtyStep,
        'floor',
      );
    } else {
      qty = roundToStep(big(input.qty ?? '0'), instrument.qtyStep, 'floor');
    }

    if (qty <= 0n) throw badRequest('Menge ist zu klein.');

    const position = await this.positionFor(account.id, instrument.id);
    const reduceOnly = input.reduceOnly === true;

    if (reduceOnly) {
      const held = abs(position.qty);
      if (held <= 0n) throw badRequest('Keine Position zum Schliessen.');
      if (qty > held) qty = held;
      const closingSide: Side = position.qty > 0n ? 'sell' : 'buy';
      if (side !== closingSide) throw badRequest('Diese Order wuerde die Position vergroessern.');
    }

    const estimate = executeMarket({ side, qty, quote, rules, volBps: this.volatilityFor(instrument, league) });
    if (estimate.grossCents < instrument.minNotional) {
      throw badRequest('Ordervolumen liegt unter dem Mindestbetrag.');
    }

    await this.assertAffordable(account, league, instrument, side, qty, estimate, position);

    const timestamp = now();
    const orderId = newId();
    const ocoGroup =
      input.attachStopBps || input.attachTakeProfitBps ? newId() : null;

    await this.db.run(
      `INSERT INTO orders (id, account_id, league_id, instrument_id, side, type, qty, filled_qty,
                           limit_price, stop_price, trail_bps, trail_anchor, tif, status,
                           triggered, reduce_only, oco_group, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, NULL, ?, 'working', 0, ?, NULL, ?, ?, ?)`,
      [
        orderId,
        account.id,
        league.id,
        instrument.id,
        side,
        input.type,
        qty.toString(),
        input.limitPrice ? big(input.limitPrice).toString() : null,
        input.stopPrice ? big(input.stopPrice).toString() : null,
        input.trailBps ?? null,
        input.tif === 'day' ? 'day' : 'gtc',
        flag(reduceOnly),
        input.source ?? 'human',
        timestamp,
        timestamp,
      ],
    );

    // Market-Orders werden sofort ausgefuehrt. Alles andere legt sich hin und
    // wartet auf seinen Kurs - darum kuemmert sich die Engine-Schleife.
    if (input.type === 'market') {
      const result = await this.fillOrder(orderId, quote, timestamp, {
        attachStopBps: input.attachStopBps ?? null,
        attachTakeProfitBps: input.attachTakeProfitBps ?? null,
        ocoGroup,
      });
      return result;
    }

    this.hub.broadcastLeague(league.id, 'orders', { accountId: account.id });

    return {
      orderId,
      status: 'working',
      filledQty: '0',
      price: null,
      feeCents: '0',
      realizedCents: '0',
      message: 'Order liegt im Markt.',
      prestigeGained: 0,
    };
  }

  /**
   * Kaufkraftpruefung.
   *
   * Ohne Hebel gilt schlicht: was nicht auf dem Konto liegt, kann nicht
   * ausgegeben werden. Mit Hebel darf das Engagement das Eigenkapital um den
   * Hebelfaktor uebersteigen - aber keinen Cent mehr.
   */
  private async assertAffordable(
    account: Account,
    league: League,
    instrument: Instrument,
    side: Side,
    qty: Qty,
    estimate: Fill,
    position: PositionState,
  ): Promise<void> {
    const { equity, exposure } = await this.valuate(account, league);

    const signed = side === 'buy' ? qty : -qty;
    const nextQty = position.qty + signed;
    const wasExposure = exposureCents(position, estimate.price);
    const willExposure = exposureCents(
      { ...position, qty: nextQty },
      estimate.price,
    );
    const exposureAfter = exposure - wasExposure + willExposure;

    const leverage = Math.max(1, league.rules.maxLeverage);

    if (leverage === 1) {
      // Ohne Hebel: Bargeld muss reichen. Leerverkaeufe sind trotzdem
      // moeglich - dafuer haelt der Erloes als Sicherheit her.
      const cost = side === 'buy' ? estimate.grossCents + estimate.feeCents : estimate.feeCents;
      if (side === 'buy' && cost > account.cash) {
        throw badRequest(
          `Nicht genug Kaufkraft: ${fmt(cost)} $ noetig, ${fmt(account.cash)} $ verfuegbar.`,
        );
      }
      if (exposureAfter > equity) {
        throw badRequest('Ohne Hebel kannst du nicht mehr Position halten als Eigenkapital.');
      }
      return;
    }

    if (exposureAfter > equity * BigInt(leverage)) {
      const margin = computeMargin({
        equityCents: equity,
        exposureCents: exposure,
        maxLeverage: leverage,
        maintenanceMarginBps: league.rules.maintenanceMarginBps,
      });
      throw badRequest(
        `Ueber der Hebelgrenze. Frei: ${fmt(margin.buyingPowerCents)} $ Engagement.`,
      );
    }
  }

  /** Kontowert und Engagement ueber alle Positionen. */
  async valuate(account: Account, league: League): Promise<{ equity: Cents; exposure: Cents }> {
    const positions = await this.db.all<PositionRow>(
      'SELECT * FROM positions WHERE account_id = ? AND qty <> ?',
      [account.id, '0'],
    );

    let value = 0n;
    let exposure = 0n;

    for (const row of positions) {
      const state = toPosition(row);
      const instrument = await this.instrument(row.instrument_id);
      const quote = await this.quoteFor(instrument, league);
      const mark = markFor(instrument, quote, state.avgEntry);

      value += positionValueCents(state, mark);
      exposure += exposureCents(state, mark);
    }

    return { equity: account.cash + value, exposure };
  }

  async positionFor(accountId: string, instrumentId: string): Promise<PositionState> {
    const row = await this.db.get<PositionRow>(
      'SELECT * FROM positions WHERE account_id = ? AND instrument_id = ?',
      [accountId, instrumentId],
    );
    return row ? toPosition(row) : { ...FLAT_POSITION };
  }

  // ------------------------------------------------------------ Ausfuehrung

  /**
   * Eine Order ausfuehren - der einzige Weg, auf dem Geld den Besitzer
   * wechselt. Alles in einer Transaktion: entweder die Position, das
   * Bargeld, das Kassenbuch und die Order stimmen alle, oder nichts davon
   * wird geschrieben.
   */
  async fillOrder(
    orderId: string,
    quote: Quote,
    at: number,
    options: {
      priceOverride?: Price;
      liquidity?: 'taker' | 'maker';
      attachStopBps?: number | null;
      attachTakeProfitBps?: number | null;
      ocoGroup?: string | null;
      qtyOverride?: Qty;
    } = {},
  ): Promise<FillSummary> {
    return this.db.tx(async () => {
      const orderRow = await this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId]);
      if (!orderRow) throw notFound('Order nicht gefunden.');
      if (orderRow.status !== 'working' && orderRow.status !== 'partially_filled') {
        throw badRequest('Diese Order ist nicht mehr offen.');
      }

      const league = await this.league(orderRow.league_id);
      const account = await this.accountById(orderRow.account_id);
      const instrument = await this.instrument(orderRow.instrument_id);
      const rules = await this.rulesFor(league, account.userId);

      const side = orderRow.side as Side;
      const rest = big(orderRow.qty) - big(orderRow.filled_qty);
      const qty = options.qtyOverride ?? rest;
      if (qty <= 0n) throw badRequest('Nichts mehr auszufuehren.');

      // Alles mit Liquiditaetspool - eigene Coins wie Arena-Werte - laeuft
      // ueber die Kurve. Nur dort bewegt eine Order den Kurs, und genau das
      // ist der Einfluss, den ein Spieler haben soll.
      const executed =
        instrument.priceSource === 'amm' || instrument.priceSource === 'sim'
          ? await this.fillOnPool(instrument, side, qty, rules)
          : {
              fill: options.priceOverride
                ? executeAtPrice(side, qty, options.priceOverride, rules, options.liquidity ?? 'maker')
                : executeMarket({
                    side,
                    qty,
                    quote,
                    rules,
                    volBps: this.volatilityFor(instrument, league),
                    liquidity: options.liquidity ?? 'taker',
                  }),
            };

      const fill = executed.fill;

      // 1. Position fortschreiben
      const before = await this.positionFor(account.id, instrument.id);
      const applied = applyFillToPosition(before, side, fill.qty, fill.price);

      // 2. Bargeld und Kennzahlen
      const cashAfter = account.cash + fill.cashDeltaCents;
      const today = dayKey(at);
      const tradesToday = account.tradesTodayDate === today ? account.tradesToday + 1 : 1;

      await this.db.run(
        `UPDATE accounts SET cash = ?, realized = ?, fees_paid = ?, trades_count = ?,
                             trades_today = ?, trades_today_date = ?, updated_at = ?
         WHERE id = ?`,
        [
          cashAfter.toString(),
          (account.realized + applied.realizedCents - fill.feeCents).toString(),
          (account.feesPaid + fill.feeCents).toString(),
          account.tradesCount + 1,
          tradesToday,
          today,
          at,
          account.id,
        ],
      );

      // 3. Position speichern
      await this.writePosition(account.id, instrument.id, before, applied.position, at);

      // 4. Kassenbuch - die Summe aller Eintraege muss immer den Kontostand ergeben
      await this.db.run(
        `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
         VALUES (?, ?, 'trade', ?, ?, ?, ?)`,
        [newId(), account.id, fill.cashDeltaCents.toString(), cashAfter.toString(), orderId, at],
      );

      // 5. Trade protokollieren
      const tradeId = newId();
      await this.db.run(
        `INSERT INTO trades (id, account_id, league_id, order_id, instrument_id, side, qty, price,
                             gross, fee, slippage, realized, source, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tradeId,
          account.id,
          league.id,
          orderId,
          instrument.id,
          side,
          fill.qty.toString(),
          fill.price.toString(),
          fill.grossCents.toString(),
          fill.feeCents.toString(),
          fill.slippageCents.toString(),
          applied.realizedCents.toString(),
          orderRow.source,
          at,
        ],
      );

      // 6. Order fortschreiben
      const filledTotal = big(orderRow.filled_qty) + fill.qty;
      const complete = filledTotal >= big(orderRow.qty);
      const previousAvg = bigOrNull(orderRow.avg_fill_price);
      const avgFill =
        previousAvg === null
          ? fill.price
          : divRound(
              previousAvg * big(orderRow.filled_qty) + fill.price * fill.qty,
              filledTotal,
              'half_up',
            );

      await this.db.run(
        `UPDATE orders SET filled_qty = ?, status = ?, avg_fill_price = ?, updated_at = ?,
                           closed_at = ?
         WHERE id = ?`,
        [
          filledTotal.toString(),
          complete ? 'filled' : 'partially_filled',
          avgFill.toString(),
          at,
          complete ? at : null,
          orderId,
        ],
      );

      // 7. OCO: die Geschwister dieser Order sind damit erledigt
      if (complete && orderRow.oco_group) {
        await this.db.run(
          `UPDATE orders SET status = 'cancelled', closed_at = ?, reject_reason = 'OCO'
           WHERE oco_group = ? AND id <> ? AND status IN ('working', 'partially_filled')`,
          [at, orderRow.oco_group, orderId],
        );
      }

      // 8. Schutzorders an eine neu eroeffnete Position haengen
      if (complete && (options.attachStopBps || options.attachTakeProfitBps)) {
        await this.attachBrackets(
          account.id,
          league,
          instrument,
          applied.position,
          fill.price,
          options.attachStopBps ?? null,
          options.attachTakeProfitBps ?? null,
          options.ocoGroup ?? newId(),
          at,
        );
      }

      // 9. Feed, Achievements, Benachrichtigungen
      const prestigeGained = await this.afterFill({
        league,
        account,
        instrument,
        side,
        fill,
        realized: applied.realizedCents,
        closedQty: applied.closedQty,
        positionBefore: before,
        positionAfter: applied.position,
        orderType: orderRow.type,
        source: orderRow.source,
        tradesToday,
        at,
      });

      return {
        orderId,
        status: complete ? 'filled' : 'partially_filled',
        filledQty: fill.qty.toString(),
        price: fill.price.toString(),
        feeCents: fill.feeCents.toString(),
        realizedCents: applied.realizedCents.toString(),
        message: `${side === 'buy' ? 'Gekauft' : 'Verkauft'} zu ${fmtPrice(fill.price)} $`,
        prestigeGained,
      };
    });
  }

  /**
   * Ausfuehrung gegen einen Liquiditaetspool.
   *
   * Zwei Faelle teilen sich diesen Weg: die selbst gestarteten Coins und die
   * Werte des Arena-Marktes. Beide haben kein Orderbuch - der Preis ergibt
   * sich aus der Kurve. Wer viel kauft, treibt den Kurs selbst nach oben und
   * zahlt genau dafuer. Genau das ist der Einfluss, den man haben soll.
   */
  private async fillOnPool(
    instrument: Instrument,
    side: Side,
    qty: Qty,
    rules: LeagueRules,
  ): Promise<{ fill: Fill }> {
    const isArena = instrument.priceSource === 'sim';
    let pool: Pool;

    if (isArena) {
      const current = this.sim.pool(instrument.id);
      if (!current) throw badRequest('Dieser Wert wird gerade nicht gehandelt.');
      pool = current;
    } else {
      const coin = await this.coin(instrument.id);
      if (!coin || coin.status !== 'live') {
        throw badRequest('Dieser Coin wird nicht mehr gehandelt.');
      }
      pool = toPool(coin);
    }

    /** Den veraenderten Pool zurueckschreiben - je nach Herkunft woanders hin. */
    const writeBack = async (reserveUsd: bigint, reserveTokens: bigint): Promise<void> => {
      if (isArena) {
        // Der Arbeitsspeicher ist im Betrieb die Wahrheit, die Datenbank
        // bekommt es sofort mit: hier wechselt Geld den Besitzer.
        this.sim.applyPool(instrument.id, { ...pool, reserveUsdCents: reserveUsd, reserveTokens });
        await this.db.run(
          'UPDATE sim_assets SET reserve_usd = ?, reserve_tokens = ?, updated_at = ? WHERE instrument_id = ?',
          [reserveUsd.toString(), reserveTokens.toString(), now(), instrument.id],
        );
        return;
      }

      await this.db.run(
        'UPDATE coins SET reserve_usd = ?, reserve_tokens = ? WHERE instrument_id = ?',
        [reserveUsd.toString(), reserveTokens.toString(), instrument.id],
      );
    };

    if (side === 'buy') {
      if (qty >= pool.reserveTokens) throw badRequest('So viele Token hat der Pool nicht.');

      // Exakte Token-Menge kaufen: erst ausrechnen, was in den Pool muss.
      const k = poolK(pool);
      const tokensAfter = pool.reserveTokens - qty;
      const usdAfter = divRound(k, tokensAfter, 'ceil');
      const net = usdAfter - pool.reserveUsdCents;
      if (net <= 0n) throw badRequest('Menge zu klein fuer diesen Pool.');

      const fee = divRound(net * BigInt(pool.feeBps), 10_000n - BigInt(pool.feeBps), 'ceil');
      const spend = net + fee;

      await writeBack(pool.reserveUsdCents + spend, tokensAfter);

      // Die Liga-Gebuehr kommt obendrauf. Ohne sie waere Handeln auf dem
      // Arena-Markt gratis - und damit waere haeufiges Hin und Her wieder
      // kostenlos, obwohl genau das teuer sein soll.
      const brokerFee = computeFeeCents(spend - fee, rules.fees, 'taker');
      const price = priceFromNotional(spend, qty, 'half_up');

      return {
        fill: {
          price,
          qty,
          grossCents: spend - fee,
          feeCents: fee + brokerFee,
          slippageCents: 0n,
          cashDeltaCents: -(spend + brokerFee),
          liquidity: 'taker',
        },
      };
    }

    const result = ammSell(pool, qty);
    await writeBack(result.pool.reserveUsdCents, result.pool.reserveTokens);

    const brokerFee = computeFeeCents(result.proceedsCents, rules.fees, 'taker');

    return {
      fill: {
        price: result.avgPrice,
        qty,
        grossCents: result.proceedsCents + result.feeCents,
        feeCents: result.feeCents + brokerFee,
        slippageCents: 0n,
        cashDeltaCents: result.proceedsCents - brokerFee,
        liquidity: 'taker',
      },
    };
  }

  private async writePosition(
    accountId: string,
    instrumentId: string,
    before: PositionState,
    after: PositionState,
    at: number,
  ): Promise<void> {
    const existing = await this.db.get<PositionRow>(
      'SELECT id FROM positions WHERE account_id = ? AND instrument_id = ?',
      [accountId, instrumentId],
    );

    const openedNow = before.qty === 0n && after.qty !== 0n;
    const closed = after.qty === 0n;

    if (!existing) {
      await this.db.run(
        `INSERT INTO positions (id, account_id, instrument_id, qty, avg_entry, realized,
                                opened_at, last_borrow_at, worst_bps, best_bps, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        [
          newId(),
          accountId,
          instrumentId,
          after.qty.toString(),
          after.avgEntry.toString(),
          after.realizedPnlCents.toString(),
          at,
          at,
          at,
        ],
      );
      return;
    }

    await this.db.run(
      `UPDATE positions SET qty = ?, avg_entry = ?, realized = ?, updated_at = ?,
                            opened_at = CASE WHEN ? = 1 THEN ? ELSE opened_at END,
                            last_borrow_at = CASE WHEN ? = 1 THEN ? ELSE last_borrow_at END,
                            worst_bps = CASE WHEN ? = 1 THEN 0 ELSE worst_bps END,
                            best_bps = CASE WHEN ? = 1 THEN 0 ELSE best_bps END
       WHERE account_id = ? AND instrument_id = ?`,
      [
        after.qty.toString(),
        after.avgEntry.toString(),
        after.realizedPnlCents.toString(),
        at,
        flag(openedNow),
        at,
        flag(openedNow),
        at,
        flag(openedNow || closed),
        flag(openedNow || closed),
        accountId,
        instrumentId,
      ],
    );
  }

  /** Stop-Loss und Take-Profit als OCO-Paar an eine Position haengen. */
  private async attachBrackets(
    accountId: string,
    league: League,
    instrument: Instrument,
    position: PositionState,
    entryPrice: Price,
    stopBps: number | null,
    takeProfitBps: number | null,
    ocoGroup: string,
    at: number,
  ): Promise<void> {
    if (position.qty === 0n) return;

    const isLong = position.qty > 0n;
    const closingSide: Side = isLong ? 'sell' : 'buy';
    const qty = abs(position.qty);

    if (stopBps && stopBps > 0) {
      const offset = (entryPrice * BigInt(stopBps)) / 10_000n;
      const stopPrice = isLong ? entryPrice - offset : entryPrice + offset;
      if (stopPrice > 0n) {
        await this.insertProtective(
          accountId,
          league.id,
          instrument.id,
          closingSide,
          'stop',
          qty,
          null,
          stopPrice,
          ocoGroup,
          at,
        );
      }
    }

    if (takeProfitBps && takeProfitBps > 0) {
      const offset = (entryPrice * BigInt(takeProfitBps)) / 10_000n;
      const limitPrice = isLong ? entryPrice + offset : entryPrice - offset;
      if (limitPrice > 0n) {
        await this.insertProtective(
          accountId,
          league.id,
          instrument.id,
          closingSide,
          'limit',
          qty,
          limitPrice,
          null,
          ocoGroup,
          at,
        );
      }
    }
  }

  private async insertProtective(
    accountId: string,
    leagueId: string,
    instrumentId: string,
    side: Side,
    type: 'stop' | 'limit',
    qty: Qty,
    limitPrice: Price | null,
    stopPrice: Price | null,
    ocoGroup: string,
    at: number,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO orders (id, account_id, league_id, instrument_id, side, type, qty, filled_qty,
                           limit_price, stop_price, trail_bps, trail_anchor, tif, status,
                           triggered, reduce_only, oco_group, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?, NULL, NULL, 'gtc', 'working', 0, 1, ?, 'system', ?, ?)`,
      [
        newId(),
        accountId,
        leagueId,
        instrumentId,
        side,
        type,
        qty.toString(),
        limitPrice ? limitPrice.toString() : null,
        stopPrice ? stopPrice.toString() : null,
        ocoGroup,
        at,
        at,
      ],
    );
  }

  // -------------------------------------------------- Nachbereitung eines Fills

  private async afterFill(ctx: {
    league: League;
    account: Account;
    instrument: Instrument;
    side: Side;
    fill: Fill;
    realized: Cents;
    closedQty: Qty;
    positionBefore: PositionState;
    positionAfter: PositionState;
    orderType: string;
    source: string;
    tradesToday: number;
    at: number;
  }): Promise<number> {
    const {
      league,
      account,
      instrument,
      side,
      fill,
      realized,
      closedQty,
      positionBefore,
      orderType,
      source,
      tradesToday,
      at,
    } = ctx;

    await this.pushFeed(league, account.id, 'trade', {
      side,
      qty: fill.qty.toString(),
      price: fill.price.toString(),
      grossCents: fill.grossCents.toString(),
      instrumentId: instrument.id,
      display: this.displayName(instrument, league),
      realizedCents: realized.toString(),
      source,
    });

    // Achievements und Prestige gibt es nur fuer echte Spieler. Sonst koennte
    // man einen Bot nachts durchlaufen lassen und morgens den Upgrade-Baum
    // fertig haben.
    if (source === 'bot') {
      this.hub.broadcastLeague(league.id, 'trade', { accountId: account.id });
      return 0;
    }

    const prestigeGained = prestigeForTrade(fill.grossCents, realized);
    if (prestigeGained > 0) {
      await this.db.run(
        'UPDATE users SET prestige = prestige + ?, lifetime_prestige = lifetime_prestige + ? WHERE id = ?',
        [prestigeGained, prestigeGained, account.userId],
      );
    }

    const keys: string[] = [];

    if (account.tradesCount === 0) keys.push('first_blood');

    if (closedQty > 0n) {
      const positionRow = await this.db.get<PositionRow>(
        'SELECT worst_bps, best_bps, opened_at FROM positions WHERE account_id = ? AND instrument_id = ?',
        [account.id, instrument.id],
      );

      const costBasis = notionalCents(positionBefore.avgEntry, closedQty, 'half_up');
      const holdMs = positionRow?.opened_at ? at - int(positionRow.opened_at) : 0;

      keys.push(
        ...evaluateTrade({
          realizedPnlCents: realized,
          costBasisCents: costBasis,
          holdMs,
          worstDrawdownBps: int(positionRow?.worst_bps),
          bestGainBps: int(positionRow?.best_bps),
          wasShort: positionBefore.qty < 0n,
          orderType: orderType as never,
          filledAtSessionLow: false,
          accountShareBps:
            account.equity > 0n ? Number((fill.grossCents * 10_000n) / account.equity) : 0,
          tradesToday,
          isFirstTrade: account.tradesCount === 0,
        }),
      );
    }

    for (const key of keys) {
      await this.unlockAchievement(account.userId, key, league.id, at);
    }

    this.hub.broadcastLeague(league.id, 'trade', { accountId: account.id });
    return prestigeGained;
  }

  displayName(instrument: Instrument, league: League): string {
    // In einer laufenden Zeitmaschine bleiben die Namen geheim.
    if (league.mode === 'timemachine' && league.status === 'running') {
      const index = league.symbols.indexOf(instrument.symbol);
      return index >= 0 ? `ASSET ${String.fromCharCode(65 + index)}` : 'ASSET ?';
    }
    return instrument.display;
  }

  // ---------------------------------------------------------- Achievements

  async unlockAchievement(
    userId: string,
    key: string,
    leagueId: string | null,
    at: number,
  ): Promise<boolean> {
    const definition = ACHIEVEMENT_BY_KEY.get(key);
    if (!definition) return false;

    const existing = await this.db.get(
      'SELECT user_id FROM user_achievements WHERE user_id = ? AND achievement_key = ?',
      [userId, key],
    );
    if (existing) return false;

    await this.db.run(
      `INSERT INTO user_achievements (user_id, achievement_key, league_id, unlocked_at)
       VALUES (?, ?, ?, ?)`,
      [userId, key, leagueId, at],
    );

    if (definition.prestige > 0) {
      await this.db.run(
        'UPDATE users SET prestige = prestige + ?, lifetime_prestige = lifetime_prestige + ? WHERE id = ?',
        [definition.prestige, definition.prestige, userId],
      );
    }

    if (leagueId) {
      const account = await this.db.get<{ id: string }>(
        'SELECT id FROM accounts WHERE league_id = ? AND user_id = ? AND is_bot = 0',
        [leagueId, userId],
      );
      const league = await this.league(leagueId);
      await this.pushFeed(league, account?.id ?? null, 'achievement', {
        key,
        name: definition.name,
        icon: definition.icon,
        tier: definition.tier,
      });
    }

    this.hub.sendToUser(userId, 'achievement', {
      key,
      name: definition.name,
      icon: definition.icon,
      description: definition.description,
      tier: definition.tier,
    });

    return true;
  }

  async unlockEvent(
    userId: string,
    event: AchievementEvent,
    leagueId: string | null,
    at: number,
  ): Promise<void> {
    for (const key of evaluateEvent(event)) {
      await this.unlockAchievement(userId, key, leagueId, at);
    }
  }

  // ----------------------------------------------------------------- Feed

  async pushFeed(
    league: League,
    accountId: string | null,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    const at = now();
    const visibleAt =
      league.feedVisibility === 'instant'
        ? at
        : league.feedVisibility === 'delayed'
          ? at + 15 * 60_000
          : (league.endsAt ?? at + 365 * 86_400_000);

    await this.db.run(
      `INSERT INTO feed (id, league_id, account_id, kind, payload, visible_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), league.id, accountId, kind, JSON.stringify(payload), visibleAt, at],
    );

    if (visibleAt <= at) {
      this.hub.broadcastLeague(league.id, 'feed', { kind, accountId, payload, at });
    }
  }

  // ---------------------------------------------------------------- Coins

  async createCoin(
    userId: string,
    input: {
      leagueId: string;
      name: string;
      ticker: string;
      emoji?: string;
      color?: string;
      description?: string;
      supply: string;
      liquidityCents: string;
      lockMinutes?: number;
      feeBps?: number;
    },
  ): Promise<{ instrumentId: string }> {
    return this.lock.run(() =>
      this.db.tx(async () => {
        const league = await this.league(input.leagueId);
        if (league.status !== 'running') throw badRequest('Diese Liga laeuft nicht mehr.');
        if (!league.coinsAllowed) throw badRequest('In dieser Liga sind eigene Coins abgeschaltet.');

        const account = await this.accountFor(league.id, userId);

        const existing = await this.db.all<{ instrument_id: string }>(
          "SELECT instrument_id FROM coins WHERE creator_account_id = ? AND status = 'live'",
          [account.id],
        );
        if (existing.length >= 2) {
          throw badRequest('Maximal zwei aktive Coins pro Spieler.');
        }

        const name = trimText(input.name, 24);
        const ticker = trimText(input.ticker, 10)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '');
        if (name.length < 2) throw badRequest('Der Name ist zu kurz.');
        if (ticker.length < 2) throw badRequest('Das Kuerzel ist zu kurz.');

        const clash = await this.db.get('SELECT id FROM instruments WHERE league_id = ? AND symbol = ?', [
          league.id,
          ticker,
        ]);
        if (clash) throw badRequest('Dieses Kuerzel gibt es in der Liga schon.');

        const liquidity = big(input.liquidityCents);
        const supply = big(input.supply);
        const minLiquidity = 100_000n; // 1.000 $
        if (liquidity < minLiquidity) throw badRequest('Mindestens 1.000 $ Startliquiditaet.');
        if (liquidity > account.cash) throw badRequest('So viel Bargeld hast du nicht.');
        if (supply <= 0n) throw badRequest('Die Menge muss groesser als null sein.');

        // Listing-Gebuehr: verschwindet aus der Liga und verhindert Coin-Spam.
        const listingFee = 50_000n; // 500 $
        if (account.cash < liquidity + listingFee) {
          throw badRequest('Startliquiditaet plus 500 $ Listing-Gebuehr uebersteigen dein Bargeld.');
        }

        const feeBps = Math.min(500, Math.max(0, input.feeBps ?? 100));
        const { pool, lpShares } = createPool({
          usdCents: liquidity,
          tokens: supply,
          feeBps,
        });

        const instrumentId = newId();
        const at = now();
        const lockMinutes = Math.max(0, Math.min(24 * 60, input.lockMinutes ?? 0));

        await this.db.run(
          `INSERT INTO instruments (id, league_id, symbol, display, kind, price_source,
                                    qty_step, price_step, min_notional, active, created_at)
           VALUES (?, ?, ?, ?, 'coin', 'amm', '1', '1', '100', 1, ?)`,
          [instrumentId, league.id, ticker, `$${ticker}`, at],
        );

        await this.db.run(
          `INSERT INTO coins (instrument_id, league_id, creator_account_id, name, ticker, emoji,
                              color, description, total_supply, reserve_usd, reserve_tokens,
                              fee_bps, lp_shares, lp_lock_until, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)`,
          [
            instrumentId,
            league.id,
            account.id,
            name,
            ticker,
            trimText(input.emoji, 4) || '🪙',
            trimText(input.color, 9) || '#f7c948',
            trimText(input.description, 140),
            supply.toString(),
            pool.reserveUsdCents.toString(),
            pool.reserveTokens.toString(),
            feeBps,
            lpShares.toString(),
            lockMinutes > 0 ? at + lockMinutes * 60_000 : null,
            at,
          ],
        );

        await this.db.run(
          'INSERT INTO lp_shares (coin_id, account_id, shares) VALUES (?, ?, ?)',
          [instrumentId, account.id, lpShares.toString()],
        );

        const cashAfter = account.cash - liquidity - listingFee;
        await this.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
          cashAfter.toString(),
          at,
          account.id,
        ]);
        await this.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, 'coin_launch', ?, ?, ?, ?)`,
          [
            newId(),
            account.id,
            (-(liquidity + listingFee)).toString(),
            cashAfter.toString(),
            instrumentId,
            at,
          ],
        );

        await this.unlockEvent(account.userId, { kind: 'coin_created' }, league.id, at);
        await this.pushFeed(league, account.id, 'coin_launch', {
          instrumentId,
          ticker,
          name,
          emoji: trimText(input.emoji, 4) || '🪙',
          liquidityCents: liquidity.toString(),
          lockUntil: lockMinutes > 0 ? at + lockMinutes * 60_000 : null,
        });

        return { instrumentId };
      }),
    );
  }

  /**
   * Liquiditaet abziehen - der Rugpull.
   *
   * Technisch passiert nichts Besonderes: der Liquiditaetsgeber nimmt seinen
   * Anteil an beiden Reserven mit. Weil die USD-Reserve schrumpft, faellt der
   * Kurs fuer alle anderen ins Bodenlose. Es entsteht kein Geld - es wird nur
   * umverteilt, und zwar von den Kaeufern zum Ersteller.
   */
  async removeLiquidity(
    userId: string,
    instrumentId: string,
    sharePct: number,
  ): Promise<{ usdCents: string; priceBefore: string; priceAfter: string; rugged: boolean }> {
    return this.lock.run(() =>
      this.db.tx(async () => {
        const coin = await this.coin(instrumentId);
        if (!coin) throw notFound('Coin nicht gefunden.');
        if (coin.status !== 'live') throw badRequest('Dieser Coin ist bereits tot.');

        const league = await this.league(coin.league_id);
        const account = await this.accountFor(league.id, userId);

        const holding = await this.db.get<{ shares: string }>(
          'SELECT shares FROM lp_shares WHERE coin_id = ? AND account_id = ?',
          [instrumentId, account.id],
        );
        if (!holding || big(holding.shares) <= 0n) {
          throw badRequest('Du haelst keine Liquiditaet in diesem Coin.');
        }

        const at = now();
        if (league.rugpullMode === 'off') {
          throw badRequest('In dieser Liga ist das Abziehen von Liquiditaet abgeschaltet.');
        }
        if (coin.lp_lock_until && int(coin.lp_lock_until) > at) {
          const minutes = Math.ceil((int(coin.lp_lock_until) - at) / 60_000);
          throw badRequest(`Die Liquiditaet ist noch ${minutes} Minuten gesperrt.`);
        }

        const pool = toPool(coin);
        const priceBefore = poolPrice(pool);

        const pct = Math.min(100, Math.max(1, Math.round(sharePct)));
        const shares = (big(holding.shares) * BigInt(pct)) / 100n;
        if (shares <= 0n) throw badRequest('Anteil zu klein.');

        const result = ammRemoveLiquidity(pool, shares);
        const priceAfter = result.pool.reserveTokens > 0n ? poolPrice(result.pool) : 0n;

        const dead = result.pool.lpShares <= 0n || result.pool.reserveUsdCents <= 0n;
        const isCreator = coin.creator_account_id === account.id;
        // Als Rugpull gilt: der Ersteller zieht so viel ab, dass der Kurs kollabiert.
        const isRug = isCreator && (dead || priceAfter * 2n < priceBefore);

        await this.db.run(
          `UPDATE coins SET reserve_usd = ?, reserve_tokens = ?, lp_shares = ?, status = ?,
                            rugged_at = ?, rugged_amount = ?
           WHERE instrument_id = ?`,
          [
            result.pool.reserveUsdCents.toString(),
            result.pool.reserveTokens.toString(),
            result.pool.lpShares.toString(),
            dead ? 'rugged' : coin.status,
            isRug ? at : coin.rugged_at,
            isRug ? result.usdCents.toString() : coin.rugged_amount,
            instrumentId,
          ],
        );

        const remaining = big(holding.shares) - shares;
        await this.db.run('UPDATE lp_shares SET shares = ? WHERE coin_id = ? AND account_id = ?', [
          remaining.toString(),
          instrumentId,
          account.id,
        ]);

        const cashAfter = account.cash + result.usdCents;
        await this.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
          cashAfter.toString(),
          at,
          account.id,
        ]);
        await this.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            newId(),
            account.id,
            isRug ? 'rugpull' : 'lp_withdraw',
            result.usdCents.toString(),
            cashAfter.toString(),
            instrumentId,
            at,
          ],
        );

        if (dead) {
          await this.db.run('UPDATE instruments SET active = 0 WHERE id = ?', [instrumentId]);
        }

        if (isRug) {
          const holders = await this.db.all<{ account_id: string; qty: string }>(
            'SELECT account_id, qty FROM positions WHERE instrument_id = ? AND qty <> ?',
            [instrumentId, '0'],
          );

          await this.pushFeed(league, account.id, 'rugpull', {
            instrumentId,
            ticker: coin.ticker,
            emoji: coin.emoji,
            amountCents: result.usdCents.toString(),
            priceBefore: priceBefore.toString(),
            priceAfter: priceAfter.toString(),
            holders: holders.length,
          });

          await this.unlockEvent(account.userId, { kind: 'rugged_someone' }, league.id, at);

          for (const holder of holders) {
            const victim = await this.accountById(holder.account_id);
            if (victim.userId === account.userId) continue;
            await this.unlockEvent(victim.userId, { kind: 'got_rugged' }, league.id, at);
          }
        }

        this.hub.broadcastLeague(league.id, 'coins', { instrumentId });

        return {
          usdCents: result.usdCents.toString(),
          priceBefore: priceBefore.toString(),
          priceAfter: priceAfter.toString(),
          rugged: isRug,
        };
      }),
    );
  }

  async addLiquidity(userId: string, instrumentId: string, amountCents: string): Promise<void> {
    await this.lock.run(() =>
      this.db.tx(async () => {
        const coin = await this.coin(instrumentId);
        if (!coin || coin.status !== 'live') throw badRequest('Coin nicht handelbar.');

        const league = await this.league(coin.league_id);
        const account = await this.accountFor(league.id, userId);
        const amount = big(amountCents);

        if (amount <= 0n) throw badRequest('Betrag muss positiv sein.');
        if (amount > account.cash) throw badRequest('So viel Bargeld hast du nicht.');

        const pool = toPool(coin);
        const shares = (amount * pool.lpShares) / pool.reserveUsdCents;
        if (shares <= 0n) throw badRequest('Betrag zu klein.');

        const tokens = divRound(amount * pool.reserveTokens, pool.reserveUsdCents, 'ceil');
        const at = now();

        await this.db.run(
          'UPDATE coins SET reserve_usd = ?, reserve_tokens = ?, lp_shares = ? WHERE instrument_id = ?',
          [
            (pool.reserveUsdCents + amount).toString(),
            (pool.reserveTokens + tokens).toString(),
            (pool.lpShares + shares).toString(),
            instrumentId,
          ],
        );

        const existing = await this.db.get<{ shares: string }>(
          'SELECT shares FROM lp_shares WHERE coin_id = ? AND account_id = ?',
          [instrumentId, account.id],
        );

        if (existing) {
          await this.db.run('UPDATE lp_shares SET shares = ? WHERE coin_id = ? AND account_id = ?', [
            (big(existing.shares) + shares).toString(),
            instrumentId,
            account.id,
          ]);
        } else {
          await this.db.run('INSERT INTO lp_shares (coin_id, account_id, shares) VALUES (?, ?, ?)', [
            instrumentId,
            account.id,
            shares.toString(),
          ]);
        }

        const cashAfter = account.cash - amount;
        await this.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
          cashAfter.toString(),
          at,
          account.id,
        ]);
        await this.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, 'lp_add', ?, ?, ?, ?)`,
          [newId(), account.id, (-amount).toString(), cashAfter.toString(), instrumentId, at],
        );
      }),
    );
  }

  // -------------------------------------------------------------- Orders

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    await this.lock.run(() =>
      this.db.tx(async () => {
        const order = await this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId]);
        if (!order) throw notFound('Order nicht gefunden.');

        const account = await this.accountById(order.account_id);
        if (account.userId !== userId) throw forbidden('Das ist nicht deine Order.');
        if (order.status !== 'working' && order.status !== 'partially_filled') {
          throw badRequest('Diese Order ist nicht mehr offen.');
        }

        await this.db.run(
          "UPDATE orders SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?",
          [now(), now(), orderId],
        );

        this.hub.broadcastLeague(order.league_id, 'orders', { accountId: order.account_id });
      }),
    );
  }

  async modifyOrder(
    userId: string,
    orderId: string,
    changes: { qty?: string; limitPrice?: string; stopPrice?: string; trailBps?: number },
  ): Promise<void> {
    await this.lock.run(() =>
      this.db.tx(async () => {
        const order = await this.db.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId]);
        if (!order) throw notFound('Order nicht gefunden.');

        const account = await this.accountById(order.account_id);
        if (account.userId !== userId) throw forbidden('Das ist nicht deine Order.');
        if (order.status !== 'working') throw badRequest('Nur offene Orders lassen sich aendern.');

        const qty = changes.qty ? big(changes.qty) : big(order.qty);
        if (qty <= big(order.filled_qty)) {
          throw badRequest('Die neue Menge liegt unter dem bereits Ausgefuehrten.');
        }

        await this.db.run(
          `UPDATE orders SET qty = ?, limit_price = ?, stop_price = ?, trail_bps = ?,
                             trail_anchor = NULL, updated_at = ?
           WHERE id = ?`,
          [
            qty.toString(),
            changes.limitPrice ? big(changes.limitPrice).toString() : order.limit_price,
            changes.stopPrice ? big(changes.stopPrice).toString() : order.stop_price,
            changes.trailBps ?? order.trail_bps,
            now(),
            orderId,
          ],
        );

        this.hub.broadcastLeague(order.league_id, 'orders', { accountId: order.account_id });
      }),
    );
  }

  // ------------------------------------------------------------- Bewertung

  /** Equity neu berechnen und Hoch-/Tiefstaende fortschreiben. */
  async refreshAccount(account: Account, league: League, at: number): Promise<Account> {
    const { equity } = await this.valuate(account, league);

    const peak = equity > account.peakEquity ? equity : account.peakEquity;
    const trough = equity < account.troughEquity ? equity : account.troughEquity;

    if (equity !== account.equity || peak !== account.peakEquity || trough !== account.troughEquity) {
      await this.db.run(
        'UPDATE accounts SET equity = ?, peak_equity = ?, trough_equity = ?, updated_at = ? WHERE id = ?',
        [equity.toString(), peak.toString(), trough.toString(), at, account.id],
      );
    }

    return { ...account, equity, peakEquity: peak, troughEquity: trough };
  }
}

// ------------------------------------------------------------------ Helfer

export function toPosition(row: PositionRow): PositionState {
  return {
    qty: big(row.qty),
    avgEntry: big(row.avg_entry),
    realizedPnlCents: big(row.realized),
  };
}

export function toPool(coin: CoinRow): Pool {
  return {
    reserveUsdCents: big(coin.reserve_usd),
    reserveTokens: big(coin.reserve_tokens),
    feeBps: int(coin.fee_bps, 100),
    lpShares: big(coin.lp_shares),
  };
}

/**
 * Bewertungskurs einer Position.
 *
 * Der wichtige Sonderfall: Ein gerugter Coin hat keinen Pool mehr und damit
 * keinen Kurs. Er ist dann NICHTS wert - nicht etwa noch den Einstandspreis.
 * Genau das ist ja der Schmerz beim Rugpull, und das Depot muss ihn zeigen.
 */
export function markFor(instrument: Instrument, quote: Quote | null, fallback: Price): Price {
  if (quote) return quote.last;
  return instrument.priceSource === 'amm' ? 0n : fallback;
}

/** Ein AMM-Pool hat keinen Spread - Kauf und Verkauf laufen ueber dieselbe Kurve. */
export function poolQuote(pool: Pool): Quote | null {
  if (pool.reserveTokens <= 0n || pool.reserveUsdCents <= 0n) return null;
  const price = poolPrice(pool);
  if (price <= 0n) return null;
  return { bid: price, ask: price, last: price, at: Date.now() };
}

function volFromCandles(candles: Array<{ h: number; l: number; c: number }>): number {
  const window = candles.slice(-20);
  if (window.length < 5) return 100;

  let sum = 0;
  for (const candle of window) sum += (candle.h - candle.l) / Math.max(1e-9, candle.c);
  return Math.round((sum / window.length) * 10_000);
}

const fmt = (cents: Cents): string => (Number(cents) / 100).toFixed(2);

/** Kleine Coin-Kurse brauchen mehr Nachkommastellen als BTC. */
const fmtPrice = (price: Price): string => {
  const value = Number(price) / 1e8;
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.0001) return value.toFixed(6);
  return value.toFixed(10);
};

export { fmt, fmtPrice, unrealizedPnlCents, accountEquityCents, computeFeeCents, bool, jsonParse, DEFAULT_BOT_PARAMS, HttpError };
