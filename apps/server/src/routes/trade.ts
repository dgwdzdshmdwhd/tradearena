import {
  BOT_NAMES,
  DEFAULT_BOT_PARAMS,
  STRATEGY_LABELS,
  abs,
  errorRateForLevel,
  executeMarket,
  marketCapCents,
  poolPrice,
  resolveEffects,
  rugRisk,
  type BotStrategy,
} from '@tradearena/core';
import type { FastifyInstance } from 'fastify';

import { requireUser, type Context } from '../context.js';
import { toInstrument, type CoinRow, type InstrumentRow } from '../rows.js';
import { toPool } from '../trading.js';
import {
  badRequest,
  big,
  clamp,
  forbidden,
  int,
  newId,
  notFound,
  now,
  trimText,
} from '../util.js';
import { assertMember } from './leagues.js';

/**
 * Erst nach so vielen Trades bekommt man seinen ersten Bot.
 *
 * Bewusst niedrig: der Bot ist das spielerischste am ganzen Ding, und wer ihn
 * an einem Abend nie zu sehen bekommt, verpasst die Haelfte.
 */
const TRADES_FOR_FIRST_BOT = 5;

export function registerTradeRoutes(app: FastifyInstance, ctx: Context): void {
  // --- Marktdaten ---------------------------------------------------------

  app.get('/api/leagues/:id/instruments', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const league = await ctx.trading.league(id);
    const rows = await ctx.db.all<InstrumentRow>(
      'SELECT * FROM instruments WHERE active = 1 AND (league_id IS NULL OR league_id = ?)',
      [id],
    );

    const out = [];
    for (const row of rows) {
      const instrument = toInstrument(row);
      if (
        instrument.kind === 'crypto' &&
        league.symbols.length > 0 &&
        !league.symbols.includes(instrument.symbol)
      ) {
        continue;
      }

      const quote = await ctx.trading.quoteFor(instrument, league);
      out.push({
        id: instrument.id,
        symbol: instrument.symbol,
        display: ctx.trading.displayName(instrument, league),
        kind: instrument.kind,
        qtyStep: instrument.qtyStep.toString(),
        priceStep: instrument.priceStep.toString(),
        minNotionalCents: instrument.minNotional.toString(),
        bid: quote?.bid.toString() ?? null,
        ask: quote?.ask.toString() ?? null,
        last: quote?.last.toString() ?? null,
      });
    }

    return {
      instruments: out,
      feedStatus: ctx.feed.status,
      historyStatus: ctx.feed.historyStatus,
      mode: league.mode,
    };
  });

  app.get('/api/leagues/:id/candles', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const query = request.query as { instrumentId?: string; interval?: string };
    await assertMember(ctx, userId, id);

    const league = await ctx.trading.league(id);
    const instrument = await ctx.trading.instrument(String(query.instrumentId));
    const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(String(query.interval))
      ? String(query.interval)
      : '1m';

    if (instrument.priceSource === 'amm') {
      // Coins haben keine Boersenhistorie - wir bauen die Kurve aus den
      // tatsaechlichen Trades im Pool.
      const trades = await ctx.db.all<{ price: string; executed_at: number; qty: string }>(
        'SELECT price, executed_at, qty FROM trades WHERE instrument_id = ? ORDER BY executed_at ASC LIMIT 1000',
        [instrument.id],
      );

      const coin = await ctx.trading.coin(instrument.id);
      const current = coin ? Number(poolPrice(toPool(coin))) / 1e8 : 0;

      const candles = trades.map((trade) => {
        const price = Number(big(trade.price)) / 1e8;
        return {
          t: int(trade.executed_at),
          o: price,
          h: price,
          l: price,
          c: price,
          v: Number(big(trade.qty)) / 1e8,
        };
      });

      if (current > 0) {
        candles.push({ t: now(), o: current, h: current, l: current, c: current, v: 0 });
      }

      return { candles, interval };
    }

    if (league.mode === 'timemachine') {
      const cursor = league.replayCursor ?? 0;
      return {
        candles: ctx.replay.candlesUpTo(league.id, instrument.symbol, cursor),
        interval: '1m',
      };
    }

    const candles =
      interval === '1m'
        ? ctx.feed.candles(instrument.symbol)
        : await ctx.feed.fetchCandles(instrument.symbol, interval, 300);

    return { candles, interval };
  });

  // --- Orders -------------------------------------------------------------

  app.post('/api/orders', async (request) => {
    const userId = requireUser(request);
    const body = request.body as Record<string, unknown>;

    return ctx.trading.placeOrder(userId, {
      leagueId: String(body.leagueId),
      instrumentId: String(body.instrumentId),
      side: body.side === 'sell' ? 'sell' : 'buy',
      type: (['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'] as const).includes(
        body.type as never,
      )
        ? (body.type as never)
        : 'market',
      ...(body.qty ? { qty: String(body.qty) } : {}),
      ...(body.notionalCents ? { notionalCents: String(body.notionalCents) } : {}),
      ...(body.limitPrice ? { limitPrice: String(body.limitPrice) } : {}),
      ...(body.stopPrice ? { stopPrice: String(body.stopPrice) } : {}),
      ...(body.trailBps ? { trailBps: clamp(int(body.trailBps), 10, 5_000) } : {}),
      tif: body.tif === 'day' ? 'day' : 'gtc',
      reduceOnly: Boolean(body.reduceOnly),
      ...(body.attachStopBps ? { attachStopBps: clamp(int(body.attachStopBps), 10, 9_000) } : {}),
      ...(body.attachTakeProfitBps
        ? { attachTakeProfitBps: clamp(int(body.attachTakeProfitBps), 10, 100_000) }
        : {}),
    });
  });

  /**
   * Vorschau fuers Orderticket: was kostet die Order gerade?
   * Rein lesend - hier wird nichts gebucht.
   */
  app.post('/api/orders/preview', async (request) => {
    const userId = requireUser(request);
    const body = request.body as Record<string, unknown>;

    const league = await ctx.trading.league(String(body.leagueId));
    await assertMember(ctx, userId, league.id);

    const instrument = await ctx.trading.instrument(String(body.instrumentId));
    const quote = await ctx.trading.quoteFor(instrument, league);
    if (!quote) throw badRequest('Kein Kurs verfuegbar.');

    const rules = await ctx.trading.rulesFor(league, userId);
    const side = body.side === 'sell' ? 'sell' : 'buy';

    let qty = big(String(body.qty ?? '0'));
    if (body.notionalCents) {
      const reference = side === 'buy' ? quote.ask : quote.bid;
      qty = (big(String(body.notionalCents)) * 100_000_000_000_000n) / reference;
    }
    if (qty <= 0n) throw badRequest('Menge fehlt.');

    const fill = executeMarket({
      side,
      qty,
      quote,
      rules,
      volBps: ctx.trading.volatilityFor(instrument, league),
    });

    return {
      qty: qty.toString(),
      price: fill.price.toString(),
      referencePrice: (side === 'buy' ? quote.ask : quote.bid).toString(),
      grossCents: fill.grossCents.toString(),
      feeCents: fill.feeCents.toString(),
      slippageCents: fill.slippageCents.toString(),
      cashDeltaCents: fill.cashDeltaCents.toString(),
    };
  });

  app.post('/api/orders/:id/cancel', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await ctx.trading.cancelOrder(userId, id);
    return { ok: true };
  });

  app.patch('/api/orders/:id', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;

    await ctx.trading.modifyOrder(userId, id, {
      ...(body.qty ? { qty: String(body.qty) } : {}),
      ...(body.limitPrice ? { limitPrice: String(body.limitPrice) } : {}),
      ...(body.stopPrice ? { stopPrice: String(body.stopPrice) } : {}),
      ...(body.trailBps ? { trailBps: int(body.trailBps) } : {}),
    });

    return { ok: true };
  });

  app.get('/api/leagues/:id/orders', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const query = request.query as { history?: string };
    await assertMember(ctx, userId, id);

    const account = await ctx.trading.accountFor(id, userId);
    const filter =
      query.history === 'true'
        ? "o.status NOT IN ('working','partially_filled')"
        : "o.status IN ('working','partially_filled')";

    const orders = await ctx.db.all<Record<string, unknown>>(
      `SELECT o.*, i.display, i.symbol FROM orders o
       JOIN instruments i ON i.id = o.instrument_id
       WHERE o.account_id = ? AND ${filter}
       ORDER BY o.created_at DESC LIMIT 200`,
      [account.id],
    );

    return { orders };
  });

  // --- Coins --------------------------------------------------------------

  app.get('/api/leagues/:id/coins', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const account = await ctx.trading.accountFor(id, userId);
    const coins = await ctx.db.all<CoinRow & { username: string; creator_user_id: string }>(
      `SELECT c.*, u.username, a.user_id AS creator_user_id FROM coins c
       JOIN accounts a ON a.id = c.creator_account_id
       JOIN users u ON u.id = a.user_id
       WHERE c.league_id = ? ORDER BY c.created_at DESC`,
      [id],
    );

    const out = [];
    for (const coin of coins) {
      const pool = toPool(coin);
      const creatorShares = await ctx.db.get<{ shares: string }>(
        'SELECT shares FROM lp_shares WHERE coin_id = ? AND account_id = ?',
        [coin.instrument_id, coin.creator_account_id],
      );
      const myShares = await ctx.db.get<{ shares: string }>(
        'SELECT shares FROM lp_shares WHERE coin_id = ? AND account_id = ?',
        [coin.instrument_id, account.id],
      );
      const myPosition = await ctx.trading.positionFor(account.id, coin.instrument_id);

      const risk =
        pool.lpShares > 0n
          ? rugRisk({
              pool,
              creatorShares: big(creatorShares?.shares ?? '0'),
              lpLockUntil: coin.lp_lock_until === null ? null : int(coin.lp_lock_until),
              now: now(),
            })
          : { score: 100, locked: false, creatorSharePct: 0 };

      const holders = await ctx.db.all<{ account_id: string }>(
        'SELECT account_id FROM positions WHERE instrument_id = ? AND qty <> ?',
        [coin.instrument_id, '0'],
      );

      out.push({
        instrumentId: coin.instrument_id,
        name: coin.name,
        ticker: coin.ticker,
        emoji: coin.emoji,
        color: coin.color,
        description: coin.description,
        creatorUserId: coin.creator_user_id,
        creatorName: coin.username,
        status: coin.status,
        priceCents: poolPrice(pool).toString(),
        reserveUsdCents: pool.reserveUsdCents.toString(),
        reserveTokens: pool.reserveTokens.toString(),
        totalSupply: coin.total_supply,
        marketCapCents: marketCapCents(pool, big(coin.total_supply)).toString(),
        feeBps: pool.feeBps,
        lpLockUntil: coin.lp_lock_until === null ? null : int(coin.lp_lock_until),
        ruggedAt: coin.rugged_at === null ? null : int(coin.rugged_at),
        ruggedAmountCents: coin.rugged_amount,
        risk,
        holders: holders.length,
        myShares: myShares?.shares ?? '0',
        myQty: myPosition.qty.toString(),
        isMine: coin.creator_account_id === account.id,
        createdAt: int(coin.created_at),
      });
    }

    return { coins: out };
  });

  app.post('/api/leagues/:id/coins', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const body = request.body as Record<string, unknown>;
    const league = await ctx.trading.league(id);

    // Die Launchpad-Lizenz ist ein Tycoon-Upgrade - aber nur in Ligen,
    // in denen Upgrades ueberhaupt wirken.
    if (league.upgradesAllowed) {
      const rows = await ctx.db.all<{ upgrade_key: string; level: number }>(
        'SELECT upgrade_key, level FROM user_upgrades WHERE user_id = ?',
        [userId],
      );
      const effects = resolveEffects(new Map(rows.map((row) => [row.upgrade_key, int(row.level)])));
      if (!effects.features.has('create_coins')) {
        throw forbidden('Dafuer brauchst du die Launchpad-Lizenz aus dem Trading-Desk.');
      }
    }

    return ctx.trading.createCoin(userId, {
      leagueId: id,
      name: String(body.name ?? ''),
      ticker: String(body.ticker ?? ''),
      emoji: String(body.emoji ?? '🪙'),
      color: String(body.color ?? '#f7c948'),
      description: String(body.description ?? ''),
      supply: String(body.supply ?? '0'),
      liquidityCents: String(body.liquidityCents ?? '0'),
      lockMinutes: int(body.lockMinutes, league.rugpullMode === 'locked' ? 15 : 0),
      feeBps: clamp(int(body.feeBps, 100), 0, 500),
    });
  });

  app.post('/api/coins/:id/liquidity', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as { amountCents?: string };

    await ctx.trading.addLiquidity(userId, id, String(body.amountCents ?? '0'));
    return { ok: true };
  });

  app.post('/api/coins/:id/rug', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as { sharePct?: number };

    return ctx.trading.removeLiquidity(userId, id, int(body.sharePct, 100));
  });

  // --- Bots ---------------------------------------------------------------

  app.get('/api/leagues/:id/bots', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const league = await ctx.trading.league(id);
    const slots = await botSlots(ctx, userId);

    const bots = await ctx.db.all<Record<string, unknown>>(
      `SELECT b.*, a.cash, a.equity, a.start_cash, a.trades_count, i.display, i.symbol
       FROM bots b
       JOIN accounts a ON a.id = b.account_id
       JOIN instruments i ON i.id = b.instrument_id
       WHERE b.league_id = ? AND b.user_id = ?
       ORDER BY b.created_at ASC`,
      [id, userId],
    );

    const withDecisions = [];
    for (const bot of bots) {
      const decisions = await ctx.db.all<Record<string, unknown>>(
        'SELECT * FROM bot_decisions WHERE bot_id = ? ORDER BY at DESC LIMIT 12',
        [bot.id],
      );
      withDecisions.push({ ...bot, decisions });
    }

    return {
      bots: withDecisions,
      slots,
      botsAllowed: league.botsAllowed,
      strategies: Object.entries(STRATEGY_LABELS).map(([key, label]) => ({
        key,
        label,
        params: DEFAULT_BOT_PARAMS[key as BotStrategy],
      })),
    };
  });

  app.post('/api/leagues/:id/bots', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const body = request.body as Record<string, unknown>;
    const league = await ctx.trading.league(id);
    if (!league.botsAllowed) throw badRequest('In dieser Liga sind Bots abgeschaltet.');

    const slots = await botSlots(ctx, userId);
    if (!slots.unlocked) {
      throw forbidden(
        `Deinen ersten Bot bekommst du nach ${TRADES_FOR_FIRST_BOT} Trades. Noch ${slots.tradesNeeded} zu gehen.`,
      );
    }

    const existing = await ctx.db.all<{ id: string }>(
      'SELECT id FROM bots WHERE league_id = ? AND user_id = ?',
      [id, userId],
    );
    if (existing.length >= slots.slots) {
      throw forbidden('Alle Bot-Plaetze belegt. Neue Plaetze gibt es im Trading-Desk.');
    }

    const strategy = (Object.keys(DEFAULT_BOT_PARAMS) as BotStrategy[]).includes(
      body.strategy as BotStrategy,
    )
      ? (body.strategy as BotStrategy)
      : 'mean_reversion';

    const instrument = await ctx.trading.instrument(String(body.instrumentId));
    const budget = big(String(body.budgetCents ?? '0'));
    if (budget <= 0n) throw badRequest('Budget fehlt.');

    return ctx.trading.lock.run(() =>
      ctx.db.tx(async () => {
        const owner = await ctx.trading.accountFor(id, userId);
        if (budget > owner.cash) throw badRequest('So viel Bargeld hast du nicht.');

        const at = now();
        const botAccountId = newId();
        const botId = newId();
        const name =
          trimText(body.name, 20) ||
          (BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] as string);

        // Budget vom eigenen Konto auf das Bot-Konto umbuchen.
        const ownerCash = owner.cash - budget;
        await ctx.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
          ownerCash.toString(),
          at,
          owner.id,
        ]);
        await ctx.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, 'bot_funding', ?, ?, ?, ?)`,
          [newId(), owner.id, (-budget).toString(), ownerCash.toString(), botId, at],
        );

        await ctx.db.run(
          `INSERT INTO accounts (id, league_id, user_id, label, is_bot, parent_account_id, cash,
                                 start_cash, equity, peak_equity, trough_equity, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            botAccountId,
            id,
            userId,
            name,
            owner.id,
            budget.toString(),
            budget.toString(),
            budget.toString(),
            budget.toString(),
            budget.toString(),
            at,
            at,
          ],
        );
        await ctx.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, 'deposit', ?, ?, ?, ?)`,
          [newId(), botAccountId, budget.toString(), budget.toString(), botId, at],
        );

        await ctx.db.run(
          `INSERT INTO bots (id, account_id, user_id, league_id, name, strategy, params,
                             instrument_id, budget, level, xp, error_rate_bps, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 'running', ?)`,
          [
            botId,
            botAccountId,
            userId,
            id,
            name,
            strategy,
            JSON.stringify(DEFAULT_BOT_PARAMS[strategy]),
            instrument.id,
            budget.toString(),
            errorRateForLevel(1),
            at,
          ],
        );

        await ctx.trading.unlockEvent(userId, { kind: 'bot_created' }, id, at);
        await ctx.trading.pushFeed(league, botAccountId, 'bot_hired', {
          name,
          strategy,
          display: ctx.trading.displayName(instrument, league),
          budgetCents: budget.toString(),
        });

        return { botId, name };
      }),
    );
  });

  app.post('/api/bots/:id/:action', async (request) => {
    const userId = requireUser(request);
    const { id, action } = request.params as { id: string; action: string };

    const bot = await ctx.db.get<{
      id: string;
      user_id: string;
      account_id: string;
      league_id: string;
      instrument_id: string;
      name: string;
      status: string;
    }>('SELECT * FROM bots WHERE id = ?', [id]);

    if (!bot) throw notFound('Bot nicht gefunden.');
    if (bot.user_id !== userId) throw forbidden('Das ist nicht dein Bot.');

    if (action === 'stop' || action === 'start') {
      await ctx.db.run('UPDATE bots SET status = ? WHERE id = ?', [
        action === 'stop' ? 'stopped' : 'running',
        id,
      ]);
      return { ok: true, status: action === 'stop' ? 'stopped' : 'running' };
    }

    if (action === 'fire') {
      // Bot aufloesen: Position glattstellen, Restgeld zurueck an den Besitzer.
      const league = await ctx.trading.league(bot.league_id);
      const position = await ctx.trading.positionFor(bot.account_id, bot.instrument_id);

      if (position.qty !== 0n && league.status === 'running') {
        try {
          await ctx.trading.placeOrder(userId, {
            leagueId: bot.league_id,
            instrumentId: bot.instrument_id,
            side: position.qty > 0n ? 'sell' : 'buy',
            type: 'market',
            qty: abs(position.qty).toString(),
            accountId: bot.account_id,
            source: 'system',
            reduceOnly: true,
          });
        } catch {
          // Wenn der Markt gerade keinen Kurs liefert, bleibt die Position stehen.
        }
      }

      await ctx.trading.lock.run(() =>
        ctx.db.tx(async () => {
          const botAccount = await ctx.trading.accountById(bot.account_id);
          const owner = await ctx.trading.accountFor(bot.league_id, userId);
          const at = now();

          if (botAccount.cash > 0n) {
            const ownerCash = owner.cash + botAccount.cash;
            await ctx.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
              ownerCash.toString(),
              at,
              owner.id,
            ]);
            await ctx.db.run(
              `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
               VALUES (?, ?, 'bot_return', ?, ?, ?, ?)`,
              [newId(), owner.id, botAccount.cash.toString(), ownerCash.toString(), bot.id, at],
            );
            await ctx.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
              '0',
              at,
              botAccount.id,
            ]);
            await ctx.db.run(
              `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
               VALUES (?, ?, 'bot_return', ?, '0', ?, ?)`,
              [newId(), botAccount.id, (-botAccount.cash).toString(), bot.id, at],
            );
          }

          await ctx.db.run("UPDATE bots SET status = 'fired' WHERE id = ?", [bot.id]);
          await ctx.db.run(
            "UPDATE orders SET status = 'cancelled', closed_at = ? WHERE account_id = ? AND status IN ('working','partially_filled')",
            [at, bot.account_id],
          );
        }),
      );

      return { ok: true, status: 'fired' };
    }

    throw badRequest('Unbekannte Aktion.');
  });

  app.post('/api/bots/:id/budget', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as { amountCents?: string };

    const bot = await ctx.db.get<{ user_id: string; account_id: string; league_id: string; budget: string }>(
      'SELECT user_id, account_id, league_id, budget FROM bots WHERE id = ?',
      [id],
    );
    if (!bot) throw notFound('Bot nicht gefunden.');
    if (bot.user_id !== userId) throw forbidden('Das ist nicht dein Bot.');

    const amount = big(String(body.amountCents ?? '0'));
    if (amount <= 0n) throw badRequest('Betrag fehlt.');

    await ctx.trading.lock.run(() =>
      ctx.db.tx(async () => {
        const owner = await ctx.trading.accountFor(bot.league_id, userId);
        if (amount > owner.cash) throw badRequest('So viel Bargeld hast du nicht.');

        const botAccount = await ctx.trading.accountById(bot.account_id);
        const at = now();

        const ownerCash = owner.cash - amount;
        const botCash = botAccount.cash + amount;

        await ctx.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
          ownerCash.toString(),
          at,
          owner.id,
        ]);
        await ctx.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
          botCash.toString(),
          at,
          botAccount.id,
        ]);
        await ctx.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, 'bot_funding', ?, ?, ?, ?)`,
          [newId(), owner.id, (-amount).toString(), ownerCash.toString(), id, at],
        );
        await ctx.db.run(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
           VALUES (?, ?, 'bot_funding', ?, ?, ?, ?)`,
          [newId(), botAccount.id, amount.toString(), botCash.toString(), id, at],
        );
        await ctx.db.run('UPDATE bots SET budget = ? WHERE id = ?', [
          (big(bot.budget) + amount).toString(),
          id,
        ]);
      }),
    );

    return { ok: true };
  });
}

/** Wie viele Bots darf dieser Spieler beschaeftigen? */
async function botSlots(
  ctx: Context,
  userId: string,
): Promise<{ unlocked: boolean; slots: number; trades: number; tradesNeeded: number }> {
  const row = await ctx.db.get<{ trades: number }>(
    `SELECT COUNT(*) AS trades FROM trades t
     JOIN accounts a ON a.id = t.account_id
     WHERE a.user_id = ? AND a.is_bot = 0`,
    [userId],
  );

  const trades = int(row?.trades);
  const upgrades = await ctx.db.all<{ upgrade_key: string; level: number }>(
    'SELECT upgrade_key, level FROM user_upgrades WHERE user_id = ?',
    [userId],
  );
  const effects = resolveEffects(new Map(upgrades.map((entry) => [entry.upgrade_key, int(entry.level)])));

  return {
    unlocked: trades >= TRADES_FOR_FIRST_BOT,
    slots: effects.botSlots,
    trades,
    tradesNeeded: Math.max(0, TRADES_FOR_FIRST_BOT - trades),
  };
}
