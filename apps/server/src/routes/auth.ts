import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE, createToken, loadUser, login, register } from '../auth.js';
import { config, isProduction } from '../config.js';
import { requireUser, type Context } from '../context.js';
import {
  ACHIEVEMENTS,
  RANKS,
  UPGRADES,
  UPGRADE_BY_KEY,
  nextRank,
  rankFor,
  resolveEffects,
  upgradeCost,
} from '@tradearena/core';
import { badRequest, int, notFound, now, trimText } from '../util.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 30 * 86_400,
  secure: isProduction && config.secureCookies,
};

export function registerAuthRoutes(app: FastifyInstance, ctx: Context): void {
  app.post('/api/auth/register', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const user = await register(ctx.db, body.username, body.password);

    void reply.setCookie(SESSION_COOKIE, createToken(user.id), COOKIE_OPTIONS);
    return { user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const user = await login(ctx.db, body.username, body.password);

    void reply.setCookie(SESSION_COOKIE, createToken(user.id), COOKIE_OPTIONS);
    return { user };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const userId = requireUser(request);
    const user = await loadUser(ctx.db, userId);
    if (!user) throw notFound('Benutzer nicht gefunden.');

    const row = await ctx.db.get<{ prestige: number; lifetime_prestige: number; sound_enabled: number }>(
      'SELECT prestige, lifetime_prestige, sound_enabled FROM users WHERE id = ?',
      [userId],
    );

    const upgrades = await ctx.db.all<{ upgrade_key: string; level: number }>(
      'SELECT upgrade_key, level FROM user_upgrades WHERE user_id = ?',
      [userId],
    );
    const levels = new Map(upgrades.map((entry) => [entry.upgrade_key, int(entry.level)]));
    const effects = resolveEffects(levels);
    const prestige = int(row?.prestige);

    return {
      user,
      prestige,
      lifetimePrestige: int(row?.lifetime_prestige),
      soundEnabled: int(row?.sound_enabled, 1) === 1,
      rank: rankFor(prestige),
      nextRank: nextRank(prestige),
      upgrades: Object.fromEntries(levels),
      effects: {
        feeDiscountBps: effects.feeDiscountBps,
        slippageReductionPct: effects.slippageReductionPct,
        botSlots: effects.botSlots,
        botXpPct: effects.botXpPct,
        cashInterestBps: effects.cashInterestBps,
        features: [...effects.features],
        cosmetics: [...effects.cosmetics],
      },
    };
  });

  app.patch('/api/me', async (request) => {
    const userId = requireUser(request);
    const body = request.body as { avatar?: string; soundEnabled?: boolean };

    if (typeof body.avatar === 'string') {
      await ctx.db.run('UPDATE users SET avatar = ? WHERE id = ?', [
        trimText(body.avatar, 4) || '🙂',
        userId,
      ]);
    }
    if (typeof body.soundEnabled === 'boolean') {
      await ctx.db.run('UPDATE users SET sound_enabled = ? WHERE id = ?', [
        body.soundEnabled ? 1 : 0,
        userId,
      ]);
    }

    return { ok: true };
  });

  // --- Fortschritt --------------------------------------------------------

  app.get('/api/achievements', async (request) => {
    const userId = requireUser(request);
    const unlocked = await ctx.db.all<{ achievement_key: string; unlocked_at: number }>(
      'SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id = ?',
      [userId],
    );
    const map = new Map(unlocked.map((entry) => [entry.achievement_key, int(entry.unlocked_at)]));

    return {
      achievements: ACHIEVEMENTS.map((achievement) => ({
        ...achievement,
        unlockedAt: map.get(achievement.key) ?? null,
      })),
    };
  });

  app.get('/api/upgrades', async (request) => {
    const userId = requireUser(request);
    const rows = await ctx.db.all<{ upgrade_key: string; level: number }>(
      'SELECT upgrade_key, level FROM user_upgrades WHERE user_id = ?',
      [userId],
    );
    const levels = new Map(rows.map((row) => [row.upgrade_key, int(row.level)]));
    const user = await ctx.db.get<{ prestige: number }>('SELECT prestige FROM users WHERE id = ?', [
      userId,
    ]);

    return {
      prestige: int(user?.prestige),
      ranks: RANKS,
      upgrades: UPGRADES.map((upgrade) => {
        const level = levels.get(upgrade.key) ?? 0;
        return {
          ...upgrade,
          level,
          maxLevel: upgrade.costs.length,
          nextCost: upgradeCost(upgrade, level),
        };
      }),
    };
  });

  app.post('/api/upgrades/:key/buy', async (request) => {
    const userId = requireUser(request);
    const { key } = request.params as { key: string };

    const definition = UPGRADE_BY_KEY.get(key);
    if (!definition) throw notFound('Dieses Upgrade gibt es nicht.');

    return ctx.trading.lock.run(() =>
      ctx.db.tx(async () => {
        const user = await ctx.db.get<{ prestige: number }>(
          'SELECT prestige FROM users WHERE id = ?',
          [userId],
        );
        const current = await ctx.db.get<{ level: number }>(
          'SELECT level FROM user_upgrades WHERE user_id = ? AND upgrade_key = ?',
          [userId, key],
        );

        const level = int(current?.level);
        const cost = upgradeCost(definition, level);
        if (cost === null) throw badRequest('Dieses Upgrade ist bereits voll ausgebaut.');

        const prestige = int(user?.prestige);
        if (prestige < cost) {
          throw badRequest(`Dafuer fehlen dir ${cost - prestige} Prestige.`);
        }

        await ctx.db.run('UPDATE users SET prestige = prestige - ? WHERE id = ?', [cost, userId]);

        if (current) {
          await ctx.db.run(
            'UPDATE user_upgrades SET level = ? WHERE user_id = ? AND upgrade_key = ?',
            [level + 1, userId, key],
          );
        } else {
          await ctx.db.run(
            'INSERT INTO user_upgrades (user_id, upgrade_key, level) VALUES (?, ?, 1)',
            [userId, key],
          );
        }

        return { ok: true, level: level + 1, prestigeLeft: prestige - cost };
      }),
    );
  });

  app.get('/api/profile/:userId', async (request) => {
    requireUser(request);
    const { userId } = request.params as { userId: string };

    const user = await ctx.db.get<{
      id: string;
      username: string;
      avatar: string;
      prestige: number;
      lifetime_prestige: number;
      created_at: number;
    }>('SELECT id, username, avatar, prestige, lifetime_prestige, created_at FROM users WHERE id = ?', [
      userId,
    ]);
    if (!user) throw notFound('Spieler nicht gefunden.');

    const achievements = await ctx.db.all<{ achievement_key: string; unlocked_at: number }>(
      'SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id = ? ORDER BY unlocked_at DESC',
      [userId],
    );

    const leagues = await ctx.db.all<{
      league_id: string;
      name: string;
      status: string;
      equity: string;
      start_cash: string;
    }>(
      `SELECT a.league_id, l.name, l.status, a.equity, a.start_cash
       FROM accounts a JOIN leagues l ON l.id = a.league_id
       WHERE a.user_id = ? AND a.is_bot = 0
       ORDER BY l.created_at DESC LIMIT 20`,
      [userId],
    );

    const stats = await ctx.db.get<{ trades: number; volume: string }>(
      `SELECT COUNT(*) AS trades, COALESCE(SUM(CAST(gross AS BIGINT)), 0) AS volume
       FROM trades t JOIN accounts a ON a.id = t.account_id
       WHERE a.user_id = ? AND a.is_bot = 0`,
      [userId],
    );

    return {
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        createdAt: int(user.created_at),
      },
      prestige: int(user.prestige),
      lifetimePrestige: int(user.lifetime_prestige),
      rank: rankFor(int(user.prestige)),
      achievements: achievements.map((entry) => ({
        key: entry.achievement_key,
        unlockedAt: int(entry.unlocked_at),
      })),
      leagues,
      totals: {
        trades: int(stats?.trades),
        volumeCents: String(stats?.volume ?? '0'),
      },
      generatedAt: now(),
    };
  });
}
