/**
 * Die Engine-Schleife.
 *
 * Das ist der Teil, der auch dann laeuft, wenn niemand online ist: liegende
 * Limit- und Stop-Orders pruefen, Leihgebuehren buchen, Konten bewerten,
 * liquidieren, Bots handeln lassen, Ligen beenden, Wetten aufloesen.
 *
 * Ein einziger Prozess macht das fuer alle Ligen. Nach einem Neustart liest
 * er einfach alles neu aus der Datenbank - es gibt keinen Zustand, der nur
 * im Arbeitsspeicher leben wuerde.
 */

import {
  abs,
  chooseLiquidation,
  computeMargin,
  cryptoSessionStart,
  decide,
  errorRateForLevel,
  evaluateOrder,
  exposureCents,
  borrowFeeCents,
  poolPrice,
  unrealizedPnlCents,
  xpForLevel,
  type BotStrategy,
  type Candle,
  type OpenOrder,
  type Price,
  type Quote,
} from '@tradearena/core';

import { config } from './config.js';
import type { Db } from './db.js';
import type { Hub } from './hub.js';
import type { MarketFeed } from './market.js';
import { SCENARIO_BY_KEY, type ReplayStore } from './replay.js';
import {
  toAccount,
  toInstrument,
  toLeague,
  type Account,
  type AccountRow,
  type BotRow,
  type CoinRow,
  type Instrument,
  type InstrumentRow,
  type League,
  type LeagueRow,
  type OrderRow,
  type PositionRow,
} from './rows.js';
import type { SimMarket } from './simmarket.js';
import { markFor, toPool, toPosition, type Trading } from './trading.js';
import { big, bigOrNull, int, jsonParse, newId, now } from './util.js';

export class Engine {
  private timer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;
  private lastTickAt = Date.now();
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly trading: Trading,
    private readonly feed: MarketFeed,
    private readonly replay: ReplayStore,
    private readonly hub: Hub,
    private readonly sim: SimMarket,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.safeTick(), config.tickMs);
    this.broadcastTimer = setInterval(() => {
      this.hub.broadcastPrices(this.feed.allQuotes());
    }, config.broadcastMs);
    console.log(`[engine] laeuft, Takt ${config.tickMs} ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
  }

  private async safeTick(): Promise<void> {
    if (this.running) return; // ein langsamer Takt darf sich nicht ueberholen
    this.running = true;
    try {
      await this.tick();
    } catch (error) {
      console.error('[engine] Fehler im Takt:', error);
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    const at = now();
    const elapsed = at - this.lastTickAt;
    this.lastTickAt = at;

    const rows = await this.db.all<LeagueRow>("SELECT * FROM leagues WHERE status = 'running'");

    for (const row of rows) {
      const league = toLeague(row);
      try {
        await this.tickLeague(league, at, elapsed);
      } catch (error) {
        console.error(`[engine] Liga ${league.name}:`, error);
      }
    }

    if (at - this.lastSnapshotAt >= config.snapshotMs) {
      this.lastSnapshotAt = at;
      await this.writeSnapshots(at);
    }
  }

  private async tickLeague(league: League, at: number, elapsed: number): Promise<void> {
    // Zeitmaschine: die virtuelle Uhr weiterdrehen.
    if (league.mode === 'timemachine') {
      const advanced = await this.advanceReplay(league, elapsed);
      if (!advanced) return;
      league = advanced;
    }

    const quotes = await this.quotesFor(league);
    if (quotes.size === 0) return;

    await this.processOrders(league, quotes, at);
    await this.processAccounts(league, quotes, at, elapsed);

    if (league.botsAllowed) {
      await this.processBots(league, quotes, at);
    }

    await this.processPulls(league, at);
    await this.resolveBets(league, quotes, at);
    await this.checkLeagueEnd(league, at);
  }

  // -------------------------------------------------------------- Kurse

  private async quotesFor(league: League): Promise<Map<string, { instrument: Instrument; quote: Quote }>> {
    const rows = await this.db.all<InstrumentRow>(
      'SELECT * FROM instruments WHERE active = 1 AND (league_id IS NULL OR league_id = ?)',
      [league.id],
    );

    const out = new Map<string, { instrument: Instrument; quote: Quote }>();

    for (const row of rows) {
      const instrument = toInstrument(row);

      // Jede Liga handelt entweder den Arena-Markt oder echte Krypto -
      // nie beides. Sonst waeren die Ranglisten nicht vergleichbar.
      if (instrument.kind === 'sim' && league.market !== 'arena') continue;
      if (instrument.kind === 'crypto' && league.market !== 'crypto') continue;

      if (
        instrument.kind === 'crypto' &&
        league.symbols.length > 0 &&
        !league.symbols.includes(instrument.symbol)
      ) {
        continue;
      }

      const quote = await this.trading.quoteFor(instrument, league);
      if (quote) out.set(instrument.id, { instrument, quote });
    }

    return out;
  }

  private async advanceReplay(league: League, elapsed: number): Promise<League | null> {
    const from = league.replayFrom;
    const to = league.replayTo;
    if (from === null || to === null) return league;

    if (!this.replay.isLoaded(league.id)) {
      await this.replay.ensureLoaded(league.id, league.symbols, from, to);
      return null; // beim naechsten Takt geht es los
    }

    const cursor = league.replayCursor ?? from;
    const next = Math.min(to, cursor + elapsed * Math.max(1, league.replaySpeed));

    await this.db.run('UPDATE leagues SET replay_cursor = ? WHERE id = ?', [next, league.id]);

    return { ...league, replayCursor: next };
  }

  // ------------------------------------------------------------- Orders

  private async processOrders(
    league: League,
    quotes: Map<string, { instrument: Instrument; quote: Quote }>,
    at: number,
  ): Promise<void> {
    const orders = await this.db.all<OrderRow>(
      `SELECT * FROM orders WHERE league_id = ? AND status IN ('working', 'partially_filled')
       ORDER BY created_at ASC`,
      [league.id],
    );

    for (const row of orders) {
      const entry = quotes.get(row.instrument_id);
      if (!entry) continue;

      const order = toOpenOrder(row);
      const decision = evaluateOrder(order, {
        quote: entry.quote,
        now: at,
        sessionStart: cryptoSessionStart(at),
      });

      if (decision.expire) {
        await this.db.run(
          "UPDATE orders SET status = 'expired', closed_at = ?, updated_at = ? WHERE id = ?",
          [at, at, row.id],
        );
        continue;
      }

      if (decision.trailAnchor !== undefined) {
        await this.db.run('UPDATE orders SET trail_anchor = ?, updated_at = ? WHERE id = ?', [
          decision.trailAnchor.toString(),
          at,
          row.id,
        ]);
      }

      if (decision.trigger) {
        await this.db.run('UPDATE orders SET triggered = 1, updated_at = ? WHERE id = ?', [at, row.id]);
      }

      if (!decision.fill) continue;

      // reduce_only-Orders duerfen nie mehr schliessen, als noch offen ist.
      let qty = decision.fill.qty;
      if (row.reduce_only === 1) {
        const position = await this.trading.positionFor(row.account_id, row.instrument_id);
        const held = abs(position.qty);
        if (held <= 0n) {
          await this.db.run(
            "UPDATE orders SET status = 'cancelled', closed_at = ?, reject_reason = 'Position bereits geschlossen' WHERE id = ?",
            [at, row.id],
          );
          continue;
        }
        if (qty > held) qty = held;
      }

      try {
        await this.trading.fillOrder(row.id, entry.quote, at, {
          // Limit-Orders werden zum Limit gefuellt, ausgeloeste Stops laufen
          // als Market-Order durch den Markt - inklusive Slippage.
          ...(decision.fill.liquidity === 'maker'
            ? { priceOverride: decision.fill.price, liquidity: 'maker' as const }
            : { liquidity: 'taker' as const }),
          qtyOverride: qty,
        });
      } catch (error) {
        await this.db.run(
          "UPDATE orders SET status = 'rejected', closed_at = ?, reject_reason = ?, updated_at = ? WHERE id = ?",
          [at, String((error as Error).message ?? 'Fehler').slice(0, 200), at, row.id],
        );
      }
    }
  }

  // ------------------------------------------------------------- Konten

  private async processAccounts(
    league: League,
    quotes: Map<string, { instrument: Instrument; quote: Quote }>,
    at: number,
    elapsed: number,
  ): Promise<void> {
    const rows = await this.db.all<AccountRow>('SELECT * FROM accounts WHERE league_id = ?', [
      league.id,
    ]);

    for (const row of rows) {
      let account = toAccount(row);

      const positions = await this.db.all<PositionRow>(
        'SELECT * FROM positions WHERE account_id = ? AND qty <> ?',
        [account.id, '0'],
      );

      let exposure = 0n;
      let value = 0n;

      for (const positionRow of positions) {
        const entry = quotes.get(positionRow.instrument_id);
        const state = toPosition(positionRow);
        // Ohne Kurs: ein toter Coin ist null wert, alles andere behaelt
        // vorlaeufig seinen Einstand.
        const mark: Price = entry
          ? entry.quote.last
          : markFor(await this.trading.instrument(positionRow.instrument_id), null, state.avgEntry);

        exposure += exposureCents(state, mark);
        value += (state.qty * mark) / 100_000_000_000_000n;

        // Buchgewinn im Verlauf mitschreiben - Grundlage fuer "Diamond Hands"
        // und "Round Trip".
        const cost = exposureCents({ ...state, qty: abs(state.qty) }, state.avgEntry);
        if (cost > 0n) {
          const pnl = unrealizedPnlCents(state, mark);
          const bps = Number((pnl * 10_000n) / cost);
          const worst = Math.min(int(positionRow.worst_bps), bps);
          const best = Math.max(int(positionRow.best_bps), bps);

          if (worst !== int(positionRow.worst_bps) || best !== int(positionRow.best_bps)) {
            await this.db.run('UPDATE positions SET worst_bps = ?, best_bps = ? WHERE id = ?', [
              worst,
              best,
              positionRow.id,
            ]);
          }
        }

        // Leihgebuehr fuer Short-Positionen, anteilig fuer die verstrichene Zeit.
        if (state.qty < 0n && league.rules.shortBorrowBpsDaily > 0) {
          const fee = borrowFeeCents(
            exposureCents(state, mark),
            league.rules.shortBorrowBpsDaily,
            elapsed,
          );
          if (fee > 0n) {
            const cashAfter = account.cash - fee;
            await this.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
              cashAfter.toString(),
              at,
              account.id,
            ]);
            await this.db.run(
              `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
               VALUES (?, ?, 'borrow', ?, ?, ?, ?)`,
              [newId(), account.id, (-fee).toString(), cashAfter.toString(), positionRow.id, at],
            );
            account = { ...account, cash: cashAfter };
          }
        }
      }

      const equity = account.cash + value;
      const peak = equity > account.peakEquity ? equity : account.peakEquity;
      const trough = equity < account.troughEquity ? equity : account.troughEquity;

      await this.db.run(
        'UPDATE accounts SET equity = ?, peak_equity = ?, trough_equity = ?, updated_at = ? WHERE id = ?',
        [equity.toString(), peak.toString(), trough.toString(), at, account.id],
      );
      account = { ...account, equity, peakEquity: peak, troughEquity: trough };

      await this.checkComeback(league, account, at);

      if (league.rules.maxLeverage > 1 && positions.length > 0) {
        await this.checkLiquidation(league, account, positions, quotes, at);
      }

      if (league.mode === 'survival' && !account.isBot) {
        await this.checkSurvival(league, account, at);
      }
    }
  }

  private async checkComeback(league: League, account: Account, at: number): Promise<void> {
    if (account.isBot) return;
    if (account.startCash <= 0n) return;

    const drawdownBps = Number(
      ((account.troughEquity - account.startCash) * 10_000n) / account.startCash,
    );
    if (drawdownBps <= -3_000 && account.equity > account.startCash) {
      await this.trading.unlockEvent(account.userId, { kind: 'comeback' }, league.id, at);
    }
  }

  /**
   * Margin Call und Zwangsliquidation.
   *
   * Wird bei jedem Takt geprueft - nicht nur, wenn jemand handelt. Sonst
   * koennte ein Konto ueber Nacht ins Minus laufen, ohne dass es jemand
   * merkt.
   */
  private async checkLiquidation(
    league: League,
    account: Account,
    positions: PositionRow[],
    quotes: Map<string, { instrument: Instrument; quote: Quote }>,
    at: number,
  ): Promise<void> {
    let exposure = 0n;
    const candidates = [];

    for (const row of positions) {
      const entry = quotes.get(row.instrument_id);
      if (!entry) continue;
      const state = toPosition(row);
      const value = exposureCents(state, entry.quote.last);
      exposure += value;
      candidates.push({
        instrumentId: row.instrument_id,
        exposureCents: value,
        unrealizedPnlCents: unrealizedPnlCents(state, entry.quote.last),
        qty: state.qty,
      });
    }

    const margin = computeMargin({
      equityCents: account.equity,
      exposureCents: exposure,
      maxLeverage: league.rules.maxLeverage,
      maintenanceMarginBps: league.rules.maintenanceMarginBps,
    });

    if (margin.marginCall && !margin.liquidate) {
      this.hub.sendToUser(account.userId, 'margin_call', {
        leagueId: league.id,
        levelBps: margin.marginLevelBps.toString(),
      });
      return;
    }

    if (!margin.liquidate) return;

    const victim = chooseLiquidation(candidates);
    if (!victim) return;

    const position = candidates.find((entry) => entry.instrumentId === victim.instrumentId);
    if (!position || position.qty === 0n) return;

    const entry = quotes.get(victim.instrumentId);
    if (!entry) return;

    // Zwangsverkauf als ganz normale Market-Order - gleiche Gebuehren,
    // gleiche Slippage. Die Liquidation ist kein Sonderfall, sie tut nur weh.
    const orderId = newId();
    await this.db.run(
      `INSERT INTO orders (id, account_id, league_id, instrument_id, side, type, qty, filled_qty,
                           limit_price, stop_price, trail_bps, trail_anchor, tif, status,
                           triggered, reduce_only, oco_group, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'market', ?, '0', NULL, NULL, NULL, NULL, 'gtc', 'working',
               0, 1, NULL, 'liquidation', ?, ?)`,
      [
        orderId,
        account.id,
        league.id,
        victim.instrumentId,
        position.qty > 0n ? 'sell' : 'buy',
        abs(position.qty).toString(),
        at,
        at,
      ],
    );

    try {
      await this.trading.fillOrder(orderId, entry.quote, at, { liquidity: 'taker' });

      await this.trading.pushFeed(league, account.id, 'liquidation', {
        instrumentId: victim.instrumentId,
        display: this.trading.displayName(entry.instrument, league),
        qty: abs(position.qty).toString(),
        equityCents: account.equity.toString(),
      });

      if (!account.isBot) {
        await this.trading.unlockEvent(account.userId, { kind: 'liquidated' }, league.id, at);
      }

      this.hub.sendToUser(account.userId, 'liquidated', {
        leagueId: league.id,
        instrumentId: victim.instrumentId,
      });
    } catch (error) {
      console.error('[engine] Liquidation fehlgeschlagen:', error);
    }
  }

  private async checkSurvival(league: League, account: Account, at: number): Promise<void> {
    const member = await this.db.get<{ eliminated_at: number | null }>(
      'SELECT eliminated_at FROM league_members WHERE league_id = ? AND user_id = ?',
      [league.id, account.userId],
    );
    if (!member || member.eliminated_at) return;

    const limit =
      account.startCash - (account.startCash * BigInt(league.survivalDrawdownBps)) / 10_000n;
    if (account.equity > limit) return;

    await this.db.run(
      'UPDATE league_members SET eliminated_at = ? WHERE league_id = ? AND user_id = ?',
      [at, league.id, account.userId],
    );

    // Alle offenen Orders des Ausgeschiedenen storniert es gleich mit.
    await this.db.run(
      "UPDATE orders SET status = 'cancelled', closed_at = ?, reject_reason = 'Ausgeschieden' WHERE account_id = ? AND status IN ('working','partially_filled')",
      [at, account.id],
    );

    await this.trading.pushFeed(league, account.id, 'eliminated', {
      equityCents: account.equity.toString(),
      startCents: account.startCash.toString(),
    });

    this.hub.broadcastLeague(league.id, 'eliminated', { accountId: account.id });
  }

  // --------------------------------------------------------------- Bots

  private async processBots(
    league: League,
    quotes: Map<string, { instrument: Instrument; quote: Quote }>,
    at: number,
  ): Promise<void> {
    const bots = await this.db.all<BotRow>(
      "SELECT * FROM bots WHERE league_id = ? AND status = 'running'",
      [league.id],
    );

    for (const bot of bots) {
      const entry = quotes.get(bot.instrument_id);
      if (!entry) continue;

      const account = await this.trading.accountById(bot.account_id);
      const position = await this.trading.positionFor(bot.account_id, bot.instrument_id);

      const candles = this.candlesFor(league, entry.instrument);
      if (candles.length < 30) continue;

      const intent = decide(
        {
          strategy: bot.strategy as BotStrategy,
          params: jsonParse(bot.params, {
            intervalMs: 120_000,
            tradeSizeBps: 2_000,
            stopLossBps: 300,
            takeProfitBps: 600,
          }),
          errorRateBps: int(bot.error_rate_bps, 1_800),
          level: int(bot.level, 1),
          seed: hashSeed(bot.id),
        },
        {
          now: at,
          candles,
          quote: entry.quote,
          position,
          budgetCents: big(bot.budget),
          availableCents: account.cash,
          lastActionAt: bot.last_action_at === null ? null : int(bot.last_action_at),
        },
      );

      if (intent.action === 'hold' || intent.qty <= 0n) continue;

      try {
        const result = await this.trading.placeOrder(bot.user_id, {
          leagueId: league.id,
          instrumentId: bot.instrument_id,
          side: intent.action,
          type: 'market',
          qty: intent.qty.toString(),
          accountId: bot.account_id,
          source: 'bot',
          reduceOnly: intent.action === 'sell' && position.qty > 0n,
          ...(intent.attachStopBps ? { attachStopBps: intent.attachStopBps } : {}),
          ...(intent.attachTakeProfitBps
            ? { attachTakeProfitBps: intent.attachTakeProfitBps }
            : {}),
        });

        await this.db.run(
          `INSERT INTO bot_decisions (id, bot_id, at, action, reason, mistake, order_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [newId(), bot.id, at, intent.action, intent.reason, intent.mistake, result.orderId],
        );

        await this.awardBotXp(bot, big(result.realizedCents), at);

        await this.trading.pushFeed(league, bot.account_id, 'bot', {
          botId: bot.id,
          name: bot.name,
          action: intent.action,
          reason: intent.reason,
          mistake: intent.mistake,
          qty: intent.qty.toString(),
          display: this.trading.displayName(entry.instrument, league),
        });
      } catch (error) {
        // Ein Bot, der sich verrechnet, blockiert nicht die ganze Liga.
        await this.db.run(
          `INSERT INTO bot_decisions (id, bot_id, at, action, reason, mistake, order_id)
           VALUES (?, ?, ?, 'blocked', ?, NULL, NULL)`,
          [newId(), bot.id, at, String((error as Error).message ?? 'Fehler').slice(0, 200)],
        );
        await this.db.run('UPDATE bots SET last_action_at = ? WHERE id = ?', [at, bot.id]);
      }
    }
  }

  private candlesFor(league: League, instrument: Instrument): Candle[] {
    if (league.mode === 'timemachine') {
      return this.replay.candlesUpTo(league.id, instrument.symbol, league.replayCursor ?? 0);
    }
    // Arena-Werte haben ihre eigene Historie. Frueher lief das hier auf den
    // Boersen-Feed, der ein Symbol wie ANKR gar nicht kennt - die Bots kamen
    // damit nie ueber die Mindestzahl an Kerzen und handelten nie.
    if (instrument.priceSource === 'sim') return this.sim.candles(instrument.id);
    return this.feed.candles(instrument.symbol);
  }

  private async awardBotXp(bot: BotRow, realized: bigint, at: number): Promise<void> {
    let xp = int(bot.xp) + 5 + (realized > 0n ? 15 : 0);
    let level = int(bot.level, 1);

    while (level < 10 && xp >= xpForLevel(level)) {
      xp -= xpForLevel(level);
      level += 1;
    }

    await this.db.run(
      'UPDATE bots SET xp = ?, level = ?, error_rate_bps = ?, last_action_at = ? WHERE id = ?',
      [xp, level, errorRateForLevel(level), at, bot.id],
    );
  }

  /**
   * Angekuendigte Liquiditaets-Abzuege ausfuehren, sobald der Countdown
   * abgelaufen ist. Was die Halter in den zehn Sekunden herausgeholt haben,
   * fehlt dem Abziehenden - deshalb laeuft es hier und nicht sofort beim
   * Knopfdruck.
   */
  private async processPulls(league: League, at: number): Promise<void> {
    const faellig = await this.db.all<{ instrument_id: string }>(
      `SELECT instrument_id FROM coins
       WHERE league_id = ? AND status = 'live' AND pull_at IS NOT NULL AND pull_at <= ?`,
      [league.id, at],
    );

    for (const coin of faellig) {
      try {
        await this.trading.executePull(coin.instrument_id);
      } catch (error) {
        console.error('[engine] Abzug fehlgeschlagen:', error);
        await this.db.run(
          'UPDATE coins SET pull_at = NULL, pull_account_id = NULL, pull_pct = NULL WHERE instrument_id = ?',
          [coin.instrument_id],
        );
      }
    }
  }

  // -------------------------------------------------------------- Wetten

  private async resolveBets(
    league: League,
    quotes: Map<string, { instrument: Instrument; quote: Quote }>,
    at: number,
  ): Promise<void> {
    const bets = await this.db.all<{
      id: string;
      author_account_id: string;
      instrument_id: string;
      comparator: string;
      target_price: string;
      stake: string;
      text: string;
    }>("SELECT * FROM bets WHERE league_id = ? AND status = 'open' AND resolve_at <= ?", [
      league.id,
      at,
    ]);

    for (const bet of bets) {
      const entry = quotes.get(bet.instrument_id);
      if (!entry) continue;

      const price = entry.quote.last;
      const target = big(bet.target_price);
      const authorWins = bet.comparator === 'below' ? price < target : price > target;

      const stakes = await this.db.all<{ account_id: string; side: string; amount: string }>(
        'SELECT account_id, side, amount FROM bet_stakes WHERE bet_id = ?',
        [bet.id],
      );

      const forPot = stakes
        .filter((stake) => stake.side === 'for')
        .reduce((sum, stake) => sum + big(stake.amount), 0n);
      const againstPot = stakes
        .filter((stake) => stake.side === 'against')
        .reduce((sum, stake) => sum + big(stake.amount), 0n);

      const winningSide = authorWins ? 'for' : 'against';
      const winnerPot = authorWins ? forPot : againstPot;
      const loserPot = authorWins ? againstPot : forPot;

      // Der Einsatz wurde beim Mitmachen gebucht. Jetzt bekommen die Gewinner
      // ihren Einsatz plus ihren Anteil am Topf der Verlierer zurueck.
      for (const stake of stakes) {
        if (stake.side !== winningSide) continue;

        const share = winnerPot > 0n ? (loserPot * big(stake.amount)) / winnerPot : 0n;
        const payout = big(stake.amount) + share;

        const account = await this.trading.accountById(stake.account_id);
        const cashAfter = account.cash + payout;

        await this.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
          cashAfter.toString(),
          at,
          account.id,
        ]);
        await this.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, 'bet', ?, ?, ?, ?)`,
          [newId(), account.id, payout.toString(), cashAfter.toString(), bet.id, at],
        );
      }

      await this.db.run("UPDATE bets SET status = 'resolved', outcome = ? WHERE id = ?", [
        winningSide,
        bet.id,
      ]);

      await this.trading.pushFeed(league, bet.author_account_id, 'bet_resolved', {
        betId: bet.id,
        text: bet.text,
        outcome: winningSide,
        priceAt: price.toString(),
        potCents: (forPot + againstPot).toString(),
      });
    }
  }

  // ----------------------------------------------------------- Ligaende

  private async checkLeagueEnd(league: League, at: number): Promise<void> {
    let finished = false;

    if (league.endsAt !== null && at >= league.endsAt) finished = true;

    if (league.mode === 'timemachine' && league.replayTo !== null) {
      if ((league.replayCursor ?? 0) >= league.replayTo) finished = true;
    }

    if (league.mode === 'survival') {
      const alive = await this.db.all<{ user_id: string }>(
        'SELECT user_id FROM league_members WHERE league_id = ? AND eliminated_at IS NULL',
        [league.id],
      );
      const total = await this.db.all<{ user_id: string }>(
        'SELECT user_id FROM league_members WHERE league_id = ?',
        [league.id],
      );
      if (total.length > 1 && alive.length <= 1) finished = true;
    }

    if (!finished) return;

    await this.finishLeague(league, at);
  }

  async finishLeague(league: League, at: number): Promise<void> {
    await this.db.run("UPDATE leagues SET status = 'finished', finished_at = ? WHERE id = ?", [
      at,
      league.id,
    ]);

    // Alle offenen Orders verfallen mit dem Ligaende.
    await this.db.run(
      "UPDATE orders SET status = 'cancelled', closed_at = ?, reject_reason = 'Liga beendet' WHERE league_id = ? AND status IN ('working','partially_filled')",
      [at, league.id],
    );

    const accounts = await this.db.all<AccountRow>(
      'SELECT * FROM accounts WHERE league_id = ? AND is_bot = 0',
      [league.id],
    );

    const ranked = accounts
      .map((row) => toAccount(row))
      .sort((a, b) => (b.equity > a.equity ? 1 : b.equity < a.equity ? -1 : 0));

    for (let index = 0; index < ranked.length; index += 1) {
      const account = ranked[index]!;

      // Prestige fuer die Tycoon-Ebene: Platzierung plus Rendite.
      const returnBps =
        account.startCash > 0n
          ? Number(((account.equity - account.startCash) * 10_000n) / account.startCash)
          : 0;
      const placementPoints = Math.max(0, (ranked.length - index) * 25);
      const performancePoints = Math.max(0, Math.round(returnBps / 20));
      const points = placementPoints + performancePoints;

      if (points > 0) {
        await this.db.run(
          'UPDATE users SET prestige = prestige + ?, lifetime_prestige = lifetime_prestige + ? WHERE id = ?',
          [points, points, account.userId],
        );
      }

      if (index === 0 && ranked.length > 1) {
        await this.trading.unlockEvent(account.userId, { kind: 'league_won' }, league.id, at);
      }

      if (league.mode === 'survival' && index === 0) {
        await this.trading.unlockEvent(account.userId, { kind: 'survived' }, league.id, at);
      }

      // Hat der Bot seinen Besitzer geschlagen?
      const bots = await this.db.all<AccountRow>(
        'SELECT * FROM accounts WHERE league_id = ? AND is_bot = 1 AND user_id = ?',
        [league.id, account.userId],
      );
      for (const botRow of bots) {
        const bot = toAccount(botRow);
        if (bot.startCash <= 0n || account.startCash <= 0n) continue;

        const botReturn = Number(((bot.equity - bot.startCash) * 10_000n) / bot.startCash);
        if (botReturn > returnBps) {
          await this.trading.unlockEvent(
            account.userId,
            { kind: 'bot_outperformed_owner' },
            league.id,
            at,
          );
        }
      }
    }

    const scenario = league.scenarioKey ? SCENARIO_BY_KEY.get(league.scenarioKey) : undefined;

    await this.trading.pushFeed({ ...league, feedVisibility: 'instant' }, null, 'league_end', {
      winner: ranked[0]?.userId ?? null,
      ranking: ranked.map((account) => ({
        userId: account.userId,
        equityCents: account.equity.toString(),
      })),
      reveal: scenario?.reveal ?? null,
    });

    this.hub.broadcastLeague(league.id, 'league_end', { leagueId: league.id });
    this.replay.forget(league.id);
  }

  // ---------------------------------------------------------- Snapshots

  private async writeSnapshots(at: number): Promise<void> {
    const accounts = await this.db.all<{ id: string; equity: string; cash: string }>(
      `SELECT a.id, a.equity, a.cash FROM accounts a
       JOIN leagues l ON l.id = a.league_id
       WHERE l.status = 'running'`,
    );

    for (const account of accounts) {
      await this.db.run(
        'INSERT INTO equity_snapshots (id, account_id, at, equity, cash) VALUES (?, ?, ?, ?, ?)',
        [newId(), account.id, at, account.equity, account.cash],
      );
    }
  }
}

function toOpenOrder(row: OrderRow): OpenOrder {
  return {
    id: row.id,
    side: row.side as 'buy' | 'sell',
    type: row.type as OpenOrder['type'],
    qty: big(row.qty),
    filledQty: big(row.filled_qty),
    limitPrice: bigOrNull(row.limit_price),
    stopPrice: bigOrNull(row.stop_price),
    trailBps: row.trail_bps === null ? null : int(row.trail_bps),
    trailAnchor: bigOrNull(row.trail_anchor),
    tif: row.tif as 'day' | 'gtc',
    triggered: row.triggered === 1,
    createdAt: int(row.created_at),
    ocoGroup: row.oco_group,
    reduceOnly: row.reduce_only === 1,
  };
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export { poolPrice, toPool, type CoinRow };
