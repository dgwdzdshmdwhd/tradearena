import {
  computeMargin,
  computeStats,
  exposureCents,
  parseUsd,
  unrealizedPnlCents,
} from '@tradearena/core';
import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { requireUser, type Context } from '../context.js';
import { buildResults } from '../results.js';
import { SCENARIOS, SCENARIO_BY_KEY } from '../replay.js';
import {
  toAccount,
  toInstrument,
  type AccountRow,
  type InstrumentRow,
  type League,
  type LeagueRow,
  type PositionRow,
} from '../rows.js';
import { markFor, toPosition } from '../trading.js';
import {
  badRequest,
  big,
  clamp,
  flag,
  forbidden,
  int,
  inviteCode,
  newId,
  notFound,
  now,
  trimText,
} from '../util.js';

const MODE_PRESETS = {
  classic: { durationMinutes: 7 * 24 * 60, leverage: 1, bots: true, coins: true },
  // Der Abend-Modus: lang genug fuer eine Geschichte, kurz genug fuer einen
  // Feierabend - und mit Phasen, die zum Schluss anziehen (siehe rounds.ts).
  feierabend: { durationMinutes: 45, leverage: 3, bots: true, coins: true },
  blitz: { durationMinutes: 15, leverage: 10, bots: false, coins: false },
  survival: { durationMinutes: 24 * 60, leverage: 2, bots: true, coins: true },
  timemachine: { durationMinutes: 15, leverage: 2, bots: false, coins: false },
} as const;

export function registerLeagueRoutes(app: FastifyInstance, ctx: Context): void {
  app.get('/api/scenarios', async () => ({ scenarios: SCENARIOS }));

  app.get('/api/leagues', async (request) => {
    const userId = requireUser(request);

    const rows = await ctx.db.all<
      LeagueRow & { equity: string; start_cash: string; eliminated_at: number | null; members: number }
    >(
      `SELECT l.*, a.equity, a.start_cash, m.eliminated_at,
              (SELECT COUNT(*) FROM league_members x WHERE x.league_id = l.id) AS members
       FROM leagues l
       JOIN league_members m ON m.league_id = l.id AND m.user_id = ?
       JOIN accounts a ON a.league_id = l.id AND a.user_id = ? AND a.is_bot = 0
       ORDER BY l.status ASC, l.created_at DESC`,
      [userId, userId],
    );

    return {
      leagues: rows.map((row) => ({
        id: row.id,
        name: row.name,
        mode: row.mode,
        status: row.status,
        inviteCode: row.invite_code,
        members: int(row.members),
        endsAt: row.ends_at === null ? null : int(row.ends_at),
        equityCents: row.equity,
        startCents: row.start_cash,
        eliminated: row.eliminated_at !== null,
        isOwner: row.owner_id === userId,
      })),
    };
  });

  app.post('/api/leagues', async (request) => {
    const userId = requireUser(request);
    const body = request.body as Record<string, unknown>;

    const name = trimText(body.name, 40) || 'Namenlose Liga';
    const mode = (['classic', 'feierabend', 'blitz', 'survival', 'timemachine'] as const).includes(
      body.mode as never,
    )
      ? (body.mode as keyof typeof MODE_PRESETS)
      : 'classic';

    const preset = MODE_PRESETS[mode];
    const at = now();

    const startingCash = body.startingCashCents
      ? big(String(body.startingCashCents))
      : parseUsd('100000');
    if (startingCash < parseUsd('100') || startingCash > parseUsd('100000000')) {
      throw badRequest('Startkapital muss zwischen 100 $ und 100.000.000 $ liegen.');
    }

    let symbols =
      Array.isArray(body.symbols) && body.symbols.length > 0
        ? (body.symbols as string[]).map((symbol) => String(symbol).toUpperCase())
        : [...config.symbols];

    let replayFrom: number | null = null;
    let replayTo: number | null = null;
    let scenarioKey: string | null = null;
    let durationMinutes = clamp(
      int(body.durationMinutes, preset.durationMinutes),
      5,
      90 * 24 * 60,
    );

    if (mode === 'timemachine') {
      const scenario = SCENARIO_BY_KEY.get(String(body.scenarioKey ?? ''));
      if (!scenario) throw badRequest('Unbekanntes Szenario.');
      scenarioKey = scenario.key;
      symbols = [...scenario.symbols];
      replayFrom = scenario.from;
      replayTo = scenario.to;
      durationMinutes = clamp(int(body.durationMinutes, scenario.minutes), 5, 120);
    }

    // Wie schnell die virtuelle Uhr laeuft, damit der Zeitraum in die
    // gewuenschte Spieldauer passt.
    const replaySpeed =
      replayFrom !== null && replayTo !== null
        ? Math.max(1, Math.round((replayTo - replayFrom) / (durationMinutes * 60_000)))
        : 60;

    const league: Record<string, unknown> = {
      id: newId(),
      name,
      owner_id: userId,
      invite_code: await uniqueCode(ctx),
      mode,
      status: 'running',
      starting_cash: startingCash.toString(),
      // Bewusst grosszuegiger als ein echter Broker: die Mechanik bleibt
      // dieselbe, sie tut nur weniger weh. Der Spread bleibt unangetastet -
      // ohne ihn waere es kein Markt mehr.
      taker_bps: clamp(int(body.takerBps, 5), 0, 500),
      maker_bps: clamp(int(body.makerBps, 2), 0, 500),
      fixed_fee: big(String(body.fixedFeeCents ?? '0')).toString(),
      slippage_factor_bps: clamp(int(body.slippageFactorBps, 4), 0, 200),
      ref_depth: '500000000',
      short_borrow_bps: clamp(int(body.shortBorrowBps, 8), 0, 500),
      max_leverage: clamp(int(body.maxLeverage, preset.leverage), 1, 25),
      maintenance_bps: clamp(int(body.maintenanceBps, 1_000), 100, 9_000),
      feed_visibility: ['instant', 'delayed', 'end_only'].includes(String(body.feedVisibility))
        ? String(body.feedVisibility)
        : 'instant',
      portfolio_visibility: ['open', 'delayed', 'hidden'].includes(String(body.portfolioVisibility))
        ? String(body.portfolioVisibility)
        : 'open',
      rugpull_mode: ['off', 'locked', 'free'].includes(String(body.rugpullMode))
        ? String(body.rugpullMode)
        : 'locked',
      bots_allowed: flag(body.botsAllowed === undefined ? preset.bots : Boolean(body.botsAllowed)),
      coins_allowed: flag(body.coinsAllowed === undefined ? preset.coins : Boolean(body.coinsAllowed)),
      // Standardmaessig AN: sonst ist der ganze Trading-Desk im Spiel
      // unsichtbar. Wer eine reine Wettkampfliga will, schaltet es beim
      // Anlegen aus.
      upgrades_allowed: flag(body.upgradesAllowed === undefined ? true : Boolean(body.upgradesAllowed)),
      survival_drawdown_bps: clamp(int(body.survivalDrawdownBps, 3_000), 500, 9_000),
      symbols: JSON.stringify(symbols),
      // Der Arena-Markt ist der Standard: erfundene Werte, fuer alle gleich,
      // und die eigenen Orders bewegen den Kurs. Die Zeitmaschine braucht
      // dagegen zwingend echte Kurshistorie.
      market: mode === 'timemachine' || body.market === 'crypto' ? 'crypto' : 'arena',
      created_at: at,
      starts_at: at,
      ends_at: mode === 'timemachine' ? null : at + durationMinutes * 60_000,
      scenario_key: scenarioKey,
      replay_from: replayFrom,
      replay_to: replayTo,
      replay_cursor: replayFrom,
      replay_speed: replaySpeed,
    };

    const columns = Object.keys(league);
    await ctx.db.run(
      `INSERT INTO leagues (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(league),
    );

    await joinLeague(ctx, String(league.id), userId, startingCash, at);

    // Die Zeitmaschine laedt ihre Kurse im Hintergrund vor.
    if (mode === 'timemachine' && replayFrom !== null && replayTo !== null) {
      void ctx.replay.ensureLoaded(String(league.id), symbols, replayFrom, replayTo);
    }

    return { leagueId: league.id, inviteCode: league.invite_code };
  });

  /**
   * Vorschau zu einem Einladungscode - bewusst OHNE Anmeldung erreichbar.
   *
   * Damit kann jemand, der den Link bekommt, schon vor dem Anlegen eines
   * Kontos sehen, wohin er eingeladen wurde. Herausgegeben wird nur, was auf
   * einer Einladung stehen darf: Name, Modus, Anzahl Mitspieler.
   */
  app.get('/api/leagues/preview/:code', async (request) => {
    const { code } = request.params as { code: string };
    const row = await ctx.db.get<{
      id: string;
      name: string;
      mode: string;
      status: string;
      starting_cash: string;
      owner_id: string;
    }>('SELECT id, name, mode, status, starting_cash, owner_id FROM leagues WHERE invite_code = ?', [
      trimText(code, 12).toUpperCase(),
    ]);

    if (!row) throw notFound('Diesen Einladungscode gibt es nicht.');

    const members = await ctx.db.get<{ anzahl: number }>(
      'SELECT COUNT(*) AS anzahl FROM league_members WHERE league_id = ?',
      [row.id],
    );
    const owner = await ctx.db.get<{ username: string }>(
      'SELECT username FROM users WHERE id = ?',
      [row.owner_id],
    );

    return {
      league: {
        name: row.name,
        mode: row.mode,
        status: row.status,
        members: int(members?.anzahl),
        startingCashCents: row.starting_cash,
        owner: owner?.username ?? null,
      },
    };
  });

  app.post('/api/leagues/join', async (request) => {
    const userId = requireUser(request);
    const body = request.body as { code?: string };
    const code = trimText(body.code, 12).toUpperCase();

    const row = await ctx.db.get<LeagueRow>('SELECT * FROM leagues WHERE invite_code = ?', [code]);
    if (!row) throw notFound('Diesen Einladungscode gibt es nicht.');
    if (row.status !== 'running') throw badRequest('Diese Liga ist schon vorbei.');

    const existing = await ctx.db.get(
      'SELECT user_id FROM league_members WHERE league_id = ? AND user_id = ?',
      [row.id, userId],
    );
    if (existing) return { leagueId: row.id, alreadyMember: true };

    await joinLeague(ctx, row.id, userId, big(row.starting_cash), now());

    const league = await ctx.trading.league(row.id);
    const user = await ctx.db.get<{ username: string; avatar: string }>(
      'SELECT username, avatar FROM users WHERE id = ?',
      [userId],
    );
    await ctx.trading.pushFeed(league, null, 'join', {
      username: user?.username ?? '?',
      avatar: user?.avatar ?? '🙂',
    });

    return { leagueId: row.id, alreadyMember: false };
  });

  /**
   * Die Auswertung am Rundenende.
   *
   * Auch abrufbar, waehrend die Liga noch laeuft - dann ist es ein
   * Zwischenstand. Nuetzlich, um mitten in der Runde zu sehen, wer gerade
   * Achterbahn faehrt.
   */
  app.get('/api/leagues/:id/results', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const league = await ctx.trading.league(id);
    const daten = await buildResults(ctx.db, id);

    return { ...daten, status: league.status, finishedAt: league.finishedAt };
  });

  app.get('/api/leagues/:id', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const league = await ctx.trading.league(id);
    const members = await ctx.db.all<{
      user_id: string;
      username: string;
      avatar: string;
      eliminated_at: number | null;
    }>(
      `SELECT m.user_id, u.username, u.avatar, m.eliminated_at
       FROM league_members m JOIN users u ON u.id = m.user_id
       WHERE m.league_id = ? ORDER BY m.joined_at ASC`,
      [id],
    );

    const scenario = league.scenarioKey ? SCENARIO_BY_KEY.get(league.scenarioKey) : undefined;

    return {
      league: {
        ...serialiseLeague(league),
        // Der Zeitraum wird erst nach dem Lauf verraten.
        reveal: league.status === 'finished' ? (scenario?.reveal ?? null) : null,
        scenarioName: scenario?.name ?? null,
        replayLoaded: league.mode === 'timemachine' ? ctx.replay.isLoaded(league.id) : true,
      },
      members,
      isOwner: league.ownerId === userId,
      feedStatus: ctx.feed.status,
    };
  });

  app.post('/api/leagues/:id/finish', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };

    const league = await ctx.trading.league(id);
    if (league.ownerId !== userId) throw forbidden('Nur der Liga-Gruender kann sie beenden.');
    if (league.status !== 'running') throw badRequest('Die Liga ist schon beendet.');

    await ctx.engine.finishLeague(league, now());
    return { ok: true };
  });

  app.get('/api/leagues/:id/leaderboard', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const rows = await ctx.db.all<
      AccountRow & { username: string; avatar: string; eliminated_at: number | null }
    >(
      `SELECT a.*, u.username, u.avatar, m.eliminated_at
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN league_members m ON m.league_id = a.league_id AND m.user_id = a.user_id
       WHERE a.league_id = ?
       ORDER BY CAST(a.equity AS BIGINT) DESC`,
      [id],
    );

    const entries = rows.map((row) => {
      const account = toAccount(row);
      const returnBps =
        account.startCash > 0n
          ? Number(((account.equity - account.startCash) * 10_000n) / account.startCash)
          : 0;

      return {
        accountId: account.id,
        userId: account.userId,
        username: row.username,
        avatar: row.avatar,
        isBot: account.isBot,
        label: account.label,
        equityCents: account.equity.toString(),
        startCents: account.startCash.toString(),
        cashCents: account.cash.toString(),
        returnBps,
        trades: account.tradesCount,
        eliminated: row.eliminated_at !== null,
        isMe: account.userId === userId,
      };
    });

    return {
      humans: entries.filter((entry) => !entry.isBot),
      bots: entries.filter((entry) => entry.isBot),
    };
  });

  app.get('/api/leagues/:id/portfolio', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const query = request.query as { userId?: string };
    await assertMember(ctx, userId, id);

    const league = await ctx.trading.league(id);
    const targetUserId = query.userId ?? userId;

    if (targetUserId !== userId) {
      if (league.portfolioVisibility === 'hidden' && league.status === 'running') {
        throw forbidden('In dieser Liga sind fremde Depots verborgen.');
      }
    }

    const accountRow = await ctx.db.get<AccountRow>(
      'SELECT * FROM accounts WHERE league_id = ? AND user_id = ? AND is_bot = 0',
      [id, targetUserId],
    );
    if (!accountRow) throw notFound('Konto nicht gefunden.');

    return buildPortfolio(ctx, league, toAccount(accountRow), targetUserId === userId);
  });

  app.get('/api/leagues/:id/account/:accountId', async (request) => {
    const userId = requireUser(request);
    const { id, accountId } = request.params as { id: string; accountId: string };
    await assertMember(ctx, userId, id);

    const league = await ctx.trading.league(id);
    const account = await ctx.trading.accountById(accountId);
    if (account.leagueId !== id) throw notFound('Konto gehoert nicht zu dieser Liga.');

    return buildPortfolio(ctx, league, account, account.userId === userId);
  });

  app.get('/api/leagues/:id/equity', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const query = request.query as { accountId?: string };
    await assertMember(ctx, userId, id);

    const accountId =
      query.accountId ??
      (
        await ctx.db.get<{ id: string }>(
          'SELECT id FROM accounts WHERE league_id = ? AND user_id = ? AND is_bot = 0',
          [id, userId],
        )
      )?.id;

    if (!accountId) throw notFound('Konto nicht gefunden.');

    const points = await ctx.db.all<{ at: number; equity: string; cash: string }>(
      'SELECT at, equity, cash FROM equity_snapshots WHERE account_id = ? ORDER BY at ASC LIMIT 2000',
      [accountId],
    );

    const trades = await ctx.db.all<{ realized: string; executed_at: number }>(
      'SELECT realized, executed_at FROM trades WHERE account_id = ? ORDER BY executed_at ASC',
      [accountId],
    );

    const curve = points.map((point) => ({ at: int(point.at), equityCents: big(point.equity) }));
    const closed = trades
      .filter((trade) => big(trade.realized) !== 0n)
      .map((trade) => ({
        pnlCents: big(trade.realized),
        openedAt: int(trade.executed_at),
        closedAt: int(trade.executed_at),
      }));

    const stats = computeStats(curve, closed);

    return {
      curve: points.map((point) => ({ at: int(point.at), equityCents: point.equity })),
      stats: {
        ...stats,
        startEquityCents: stats.startEquityCents.toString(),
        endEquityCents: stats.endEquityCents.toString(),
        totalPnlCents: stats.totalPnlCents.toString(),
        returnBps: stats.returnBps.toString(),
        maxDrawdownBps: stats.maxDrawdownBps.toString(),
        maxDrawdownCents: stats.maxDrawdownCents.toString(),
        winRateBps: stats.winRateBps.toString(),
        bestTradeCents: stats.bestTradeCents.toString(),
        worstTradeCents: stats.worstTradeCents.toString(),
      },
    };
  });

  app.get('/api/leagues/:id/trades', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const query = request.query as { accountId?: string; limit?: string };
    await assertMember(ctx, userId, id);

    const accountId =
      query.accountId ??
      (
        await ctx.db.get<{ id: string }>(
          'SELECT id FROM accounts WHERE league_id = ? AND user_id = ? AND is_bot = 0',
          [id, userId],
        )
      )?.id;

    const rows = await ctx.db.all<{
      id: string;
      instrument_id: string;
      side: string;
      qty: string;
      price: string;
      gross: string;
      fee: string;
      slippage: string;
      realized: string;
      source: string;
      executed_at: number;
      display: string;
      symbol: string;
    }>(
      `SELECT t.*, i.display, i.symbol FROM trades t
       JOIN instruments i ON i.id = t.instrument_id
       WHERE t.account_id = ? ORDER BY t.executed_at DESC LIMIT ?`,
      [accountId, clamp(int(query.limit, 200), 1, 1000)],
    );

    return { trades: rows.map((row) => ({ ...row, executed_at: int(row.executed_at) })) };
  });

  // --- Feed, Chat, Reaktionen --------------------------------------------

  app.get('/api/leagues/:id/feed', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const rows = await ctx.db.all<{
      id: string;
      account_id: string | null;
      kind: string;
      payload: string;
      created_at: number;
      username: string | null;
      avatar: string | null;
    }>(
      `SELECT f.id, f.account_id, f.kind, f.payload, f.created_at, u.username, u.avatar
       FROM feed f
       LEFT JOIN accounts a ON a.id = f.account_id
       LEFT JOIN users u ON u.id = a.user_id
       WHERE f.league_id = ? AND f.visible_at <= ?
       ORDER BY f.created_at DESC LIMIT 100`,
      [id, now()],
    );

    const reactions = await ctx.db.all<{ target_id: string; emoji: string; user_id: string }>(
      `SELECT target_id, emoji, user_id FROM reactions
       WHERE target_type = 'feed' AND target_id IN (SELECT id FROM feed WHERE league_id = ?)`,
      [id],
    );

    return {
      events: rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        kind: row.kind,
        payload: JSON.parse(row.payload) as unknown,
        createdAt: int(row.created_at),
        username: row.username,
        avatar: row.avatar,
        reactions: reactions
          .filter((reaction) => reaction.target_id === row.id)
          .map((reaction) => ({ emoji: reaction.emoji, userId: reaction.user_id })),
      })),
    };
  });

  app.get('/api/leagues/:id/chat', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const rows = await ctx.db.all<{
      id: string;
      user_id: string;
      body: string;
      created_at: number;
      username: string;
      avatar: string;
    }>(
      `SELECT c.id, c.user_id, c.body, c.created_at, u.username, u.avatar
       FROM chat c JOIN users u ON u.id = c.user_id
       WHERE c.league_id = ? ORDER BY c.created_at DESC LIMIT 100`,
      [id],
    );

    return { messages: rows.reverse().map((row) => ({ ...row, created_at: int(row.created_at) })) };
  });

  app.post('/api/leagues/:id/chat', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const body = trimText((request.body as { body?: string }).body, 500);
    if (body.length === 0) throw badRequest('Leere Nachricht.');

    const user = await ctx.db.get<{ username: string; avatar: string }>(
      'SELECT username, avatar FROM users WHERE id = ?',
      [userId],
    );

    const message = {
      id: newId(),
      user_id: userId,
      body,
      created_at: now(),
      username: user?.username ?? '?',
      avatar: user?.avatar ?? '🙂',
    };

    await ctx.db.run(
      'INSERT INTO chat (id, league_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      [message.id, id, userId, body, message.created_at],
    );

    ctx.hub.broadcastLeague(id, 'chat', message);
    return { message };
  });

  app.post('/api/reactions', async (request) => {
    const userId = requireUser(request);
    const body = request.body as { targetType?: string; targetId?: string; emoji?: string };

    const targetType = body.targetType === 'chat' ? 'chat' : 'feed';
    const targetId = trimText(body.targetId, 64);
    const emoji = trimText(body.emoji, 8);
    if (!targetId || !emoji) throw badRequest('Ziel oder Emoji fehlt.');

    const existing = await ctx.db.get<{ id: string }>(
      'SELECT id FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ? AND emoji = ?',
      [targetType, targetId, userId, emoji],
    );

    if (existing) {
      await ctx.db.run('DELETE FROM reactions WHERE id = ?', [existing.id]);
      return { removed: true };
    }

    await ctx.db.run(
      'INSERT INTO reactions (id, target_type, target_id, user_id, emoji) VALUES (?, ?, ?, ?, ?)',
      [newId(), targetType, targetId, userId, emoji],
    );

    return { removed: false };
  });

  // --- Wetten -------------------------------------------------------------

  app.get('/api/leagues/:id/bets', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const bets = await ctx.db.all<{
      id: string;
      author_account_id: string;
      instrument_id: string;
      comparator: string;
      target_price: string;
      resolve_at: number;
      stake: string;
      status: string;
      outcome: string | null;
      text: string;
      username: string;
      display: string;
    }>(
      `SELECT b.*, u.username, i.display FROM bets b
       JOIN accounts a ON a.id = b.author_account_id
       JOIN users u ON u.id = a.user_id
       JOIN instruments i ON i.id = b.instrument_id
       WHERE b.league_id = ? ORDER BY b.created_at DESC LIMIT 50`,
      [id],
    );

    const stakes = await ctx.db.all<{
      bet_id: string;
      account_id: string;
      side: string;
      amount: string;
      username: string;
    }>(
      `SELECT s.*, u.username FROM bet_stakes s
       JOIN accounts a ON a.id = s.account_id
       JOIN users u ON u.id = a.user_id
       WHERE s.bet_id IN (SELECT id FROM bets WHERE league_id = ?)`,
      [id],
    );

    return {
      bets: bets.map((bet) => ({
        ...bet,
        resolve_at: int(bet.resolve_at),
        stakes: stakes.filter((stake) => stake.bet_id === bet.id),
      })),
    };
  });

  app.post('/api/leagues/:id/bets', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await assertMember(ctx, userId, id);

    const body = request.body as Record<string, unknown>;
    const league = await ctx.trading.league(id);
    if (league.status !== 'running') throw badRequest('Diese Liga laeuft nicht mehr.');

    const account = await ctx.trading.accountFor(id, userId);
    const stake = big(String(body.stakeCents ?? '0'));
    if (stake <= 0n) throw badRequest('Einsatz muss groesser als null sein.');
    if (stake > account.cash) throw badRequest('So viel Bargeld hast du nicht.');

    const instrument = await ctx.trading.instrument(String(body.instrumentId));
    const comparator = body.comparator === 'below' ? 'below' : 'above';
    const targetPrice = big(String(body.targetPrice ?? '0'));
    if (targetPrice <= 0n) throw badRequest('Zielkurs fehlt.');

    const resolveAt = int(body.resolveAt, now() + 3_600_000);
    if (resolveAt <= now()) throw badRequest('Der Stichzeitpunkt muss in der Zukunft liegen.');

    const betId = newId();
    const at = now();
    const text =
      trimText(body.text, 120) ||
      `${instrument.display} steht ${comparator === 'below' ? 'unter' : 'ueber'} ${(
        Number(targetPrice) / 1e8
      ).toFixed(2)}`;

    await ctx.db.tx(async () => {
      await ctx.db.run(
        `INSERT INTO bets (id, league_id, author_account_id, instrument_id, comparator, target_price,
                           resolve_at, stake, status, created_at, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        [
          betId,
          id,
          account.id,
          instrument.id,
          comparator,
          targetPrice.toString(),
          resolveAt,
          stake.toString(),
          at,
          text,
        ],
      );

      await placeStake(ctx, betId, account.id, 'for', stake, at);
    });

    await ctx.trading.pushFeed(league, account.id, 'bet', { betId, text, stakeCents: stake.toString() });
    return { betId };
  });

  app.post('/api/bets/:betId/stake', async (request) => {
    const userId = requireUser(request);
    const { betId } = request.params as { betId: string };
    const body = request.body as { side?: string; amountCents?: string };

    const bet = await ctx.db.get<{ id: string; league_id: string; status: string }>(
      'SELECT id, league_id, status FROM bets WHERE id = ?',
      [betId],
    );
    if (!bet) throw notFound('Diese Wette gibt es nicht.');
    if (bet.status !== 'open') throw badRequest('Diese Wette ist schon ausgewertet.');

    await assertMember(ctx, userId, bet.league_id);
    const account = await ctx.trading.accountFor(bet.league_id, userId);

    const amount = big(String(body.amountCents ?? '0'));
    if (amount <= 0n) throw badRequest('Einsatz muss groesser als null sein.');
    if (amount > account.cash) throw badRequest('So viel Bargeld hast du nicht.');

    const existing = await ctx.db.get('SELECT id FROM bet_stakes WHERE bet_id = ? AND account_id = ?', [
      betId,
      account.id,
    ]);
    if (existing) throw badRequest('Du bist bei dieser Wette schon dabei.');

    await ctx.db.tx(() =>
      placeStake(ctx, betId, account.id, body.side === 'for' ? 'for' : 'against', amount, now()),
    );

    return { ok: true };
  });
}

// --------------------------------------------------------------- Helfer

async function placeStake(
  ctx: Context,
  betId: string,
  accountId: string,
  side: 'for' | 'against',
  amount: bigint,
  at: number,
): Promise<void> {
  const account = await ctx.trading.accountById(accountId);
  const cashAfter = account.cash - amount;
  if (cashAfter < 0n) throw badRequest('Nicht genug Bargeld.');

  await ctx.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
    cashAfter.toString(),
    at,
    accountId,
  ]);
  await ctx.db.run(
    `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
     VALUES (?, ?, 'bet_stake', ?, ?, ?, ?)`,
    [newId(), accountId, (-amount).toString(), cashAfter.toString(), betId, at],
  );
  await ctx.db.run(
    'INSERT INTO bet_stakes (id, bet_id, account_id, side, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), betId, accountId, side, amount.toString(), at],
  );
}

export async function assertMember(ctx: Context, userId: string, leagueId: string): Promise<void> {
  const row = await ctx.db.get(
    'SELECT user_id FROM league_members WHERE league_id = ? AND user_id = ?',
    [leagueId, userId],
  );
  if (!row) throw forbidden('Du bist in dieser Liga nicht dabei.');
}

async function uniqueCode(ctx: Context): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = inviteCode();
    const clash = await ctx.db.get('SELECT id FROM leagues WHERE invite_code = ?', [code]);
    if (!clash) return code;
  }
  return inviteCode(8);
}

export async function joinLeague(
  ctx: Context,
  leagueId: string,
  userId: string,
  startingCash: bigint,
  at: number,
): Promise<string> {
  const accountId = newId();

  await ctx.db.tx(async () => {
    await ctx.db.run(
      'INSERT INTO league_members (league_id, user_id, joined_at) VALUES (?, ?, ?)',
      [leagueId, userId, at],
    );

    await ctx.db.run(
      `INSERT INTO accounts (id, league_id, user_id, label, is_bot, parent_account_id, cash,
                             start_cash, equity, peak_equity, trough_equity, created_at, updated_at)
       VALUES (?, ?, ?, '', 0, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        leagueId,
        userId,
        startingCash.toString(),
        startingCash.toString(),
        startingCash.toString(),
        startingCash.toString(),
        startingCash.toString(),
        at,
        at,
      ],
    );

    await ctx.db.run(
      `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
       VALUES (?, ?, 'deposit', ?, ?, NULL, ?)`,
      [newId(), accountId, startingCash.toString(), startingCash.toString(), at],
    );

    await ctx.db.run(
      'INSERT INTO equity_snapshots (id, account_id, at, equity, cash) VALUES (?, ?, ?, ?, ?)',
      [newId(), accountId, at, startingCash.toString(), startingCash.toString()],
    );
  });

  return accountId;
}

export function serialiseLeague(league: League): Record<string, unknown> {
  return {
    id: league.id,
    name: league.name,
    mode: league.mode,
    status: league.status,
    inviteCode: league.inviteCode,
    startingCashCents: league.startingCash.toString(),
    // Achtung: fixedCents ist ein bigint - JSON.stringify wuerde daran
    // scheitern. Alles, was nach aussen geht, wird zu einer Zeichenkette.
    fees: {
      takerBps: league.rules.fees.takerBps,
      makerBps: league.rules.fees.makerBps,
      fixedCents: league.rules.fees.fixedCents.toString(),
    },
    slippageFactorBps: league.rules.slippage.factorBps,
    shortBorrowBpsDaily: league.rules.shortBorrowBpsDaily,
    maxLeverage: league.rules.maxLeverage,
    maintenanceMarginBps: league.rules.maintenanceMarginBps,
    feedVisibility: league.feedVisibility,
    portfolioVisibility: league.portfolioVisibility,
    rugpullMode: league.rugpullMode,
    botsAllowed: league.botsAllowed,
    coinsAllowed: league.coinsAllowed,
    upgradesAllowed: league.upgradesAllowed,
    survivalDrawdownBps: league.survivalDrawdownBps,
    symbols: league.symbols,
    market: league.market,
    startsAt: league.startsAt,
    endsAt: league.endsAt,
    finishedAt: league.finishedAt,
    replayCursor: league.replayCursor,
    replaySpeed: league.replaySpeed,
    ownerId: league.ownerId,
  };
}

async function buildPortfolio(
  ctx: Context,
  league: League,
  account: ReturnType<typeof toAccount>,
  isSelf: boolean,
): Promise<Record<string, unknown>> {
  const positionRows = await ctx.db.all<PositionRow>(
    'SELECT * FROM positions WHERE account_id = ? AND qty <> ?',
    [account.id, '0'],
  );

  const positions = [];
  let exposure = 0n;
  let value = 0n;

  for (const row of positionRows) {
    const instrumentRow = await ctx.db.get<InstrumentRow>('SELECT * FROM instruments WHERE id = ?', [
      row.instrument_id,
    ]);
    if (!instrumentRow) continue;

    const instrument = toInstrument(instrumentRow);
    const state = toPosition(row);
    const quote = await ctx.trading.quoteFor(instrument, league);
    const mark = markFor(instrument, quote, state.avgEntry);

    const unrealized = unrealizedPnlCents(state, mark);
    const positionExposure = exposureCents(state, mark);
    exposure += positionExposure;
    value += (state.qty * mark) / 100_000_000_000_000n;

    positions.push({
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      display: ctx.trading.displayName(instrument, league),
      kind: instrument.kind,
      qty: state.qty.toString(),
      avgEntry: state.avgEntry.toString(),
      mark: mark.toString(),
      unrealizedCents: unrealized.toString(),
      exposureCents: positionExposure.toString(),
      openedAt: row.opened_at === null ? null : int(row.opened_at),
    });
  }

  const equity = account.cash + value;
  const margin = computeMargin({
    equityCents: equity,
    exposureCents: exposure,
    maxLeverage: league.rules.maxLeverage,
    maintenanceMarginBps: league.rules.maintenanceMarginBps,
  });

  const orders = isSelf
    ? await ctx.db.all<Record<string, unknown>>(
        `SELECT o.*, i.display, i.symbol FROM orders o
         JOIN instruments i ON i.id = o.instrument_id
         WHERE o.account_id = ? AND o.status IN ('working','partially_filled')
         ORDER BY o.created_at DESC`,
        [account.id],
      )
    : [];

  return {
    account: {
      id: account.id,
      userId: account.userId,
      cashCents: account.cash.toString(),
      startCents: account.startCash.toString(),
      equityCents: equity.toString(),
      realizedCents: account.realized.toString(),
      feesPaidCents: account.feesPaid.toString(),
      peakEquityCents: account.peakEquity.toString(),
      troughEquityCents: account.troughEquity.toString(),
      trades: account.tradesCount,
      isBot: account.isBot,
    },
    positions,
    orders,
    margin: {
      exposureCents: exposure.toString(),
      usedMarginCents: margin.usedMarginCents.toString(),
      buyingPowerCents: margin.buyingPowerCents.toString(),
      marginLevelBps: margin.marginLevelBps.toString(),
      marginCall: margin.marginCall,
    },
  };
}
