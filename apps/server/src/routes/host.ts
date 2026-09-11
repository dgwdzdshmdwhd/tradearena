import type { FastifyInstance } from 'fastify';

import { requireUser, type Context } from '../context.js';
import type { League } from '../rows.js';
import { badRequest, big, clamp, forbidden, int, newId, notFound, now, trimText } from '../util.js';

/**
 * Spielleiter-Werkzeuge.
 *
 * Wer eine Liga aufmacht, ist ihr Gastgeber - und ein Abend unter Freunden
 * lebt davon, dass der Gastgeber eingreifen darf: Geld nachwerfen, den Markt
 * anschubsen, jemandem etwas auf den Bildschirm werfen. Das ist keine
 * Sicherheitsluecke, das ist der Spielleiter im Brettspiel.
 *
 * Zwei Regeln halten es sauber:
 *
 *   1. Nur der Eigentuemer der Liga, und nur in seiner eigenen Liga. Es gibt
 *      keinen globalen Administrator, der in fremde Runden greift.
 *   2. Alles ist sichtbar. Jeder Eingriff landet im Feed und im Kontobuch -
 *      wer Geld bekommt, sieht warum, und die anderen sehen es auch. Heimlich
 *      schummeln waere kein Spass, sondern Betrug.
 */

/** Stellt sicher, dass der Aufrufer die Liga aufgemacht hat. */
async function requireHost(ctx: Context, userId: string, leagueId: string): Promise<League> {
  const league = await ctx.trading.league(leagueId);
  if (league.ownerId !== userId) {
    throw forbidden('Nur der Gastgeber dieser Liga darf das.');
  }
  return league;
}

/** Grenzen fuer hochgeladene Dateien. */
const MEDIA_MAX_BYTES = 6 * 1024 * 1024;
const MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
];

export function registerHostRoutes(app: FastifyInstance, ctx: Context): void {
  /** Wer ist in der Liga, wie steht er da - die Liste zum Anklicken. */
  app.get('/api/leagues/:id/host/players', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const league = await requireHost(ctx, userId, id);

    const rows = await ctx.db.all<{
      user_id: string;
      username: string;
      account_id: string;
      cash: string;
    }>(
      `SELECT m.user_id, u.username, a.id AS account_id, a.cash
       FROM league_members m
       JOIN users u ON u.id = m.user_id
       JOIN accounts a ON a.user_id = m.user_id AND a.league_id = m.league_id AND a.is_bot = 0
       WHERE m.league_id = ?
       ORDER BY u.username ASC`,
      [id],
    );

    const players = [];
    for (const row of rows) {
      const account = await ctx.trading.accountById(row.account_id);
      const { equity } = await ctx.trading.valuate(account, league);
      players.push({
        userId: row.user_id,
        username: row.username,
        cashCents: row.cash,
        equityCents: equity.toString(),
      });
    }

    return { players };
  });

  /**
   * Geld geben oder nehmen.
   *
   * Laeuft ueber dasselbe Kontobuch wie jeder Trade. Ein Betrag, der aus dem
   * Nichts auf dem Konto erscheint und nirgends steht, waere ein Loch in der
   * Buchhaltung - und die stimmt hier auf den Cent.
   */
  app.post('/api/leagues/:id/host/cash', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as { userId?: string; amountCents?: string; reason?: string };
    const league = await requireHost(ctx, userId, id);

    const ziel = String(body.userId ?? '');
    const betrag = big(String(body.amountCents ?? '0'));
    if (betrag === 0n) throw badRequest('Betrag fehlt.');
    if (betrag > 100_000_000_00n || betrag < -100_000_000_00n) {
      throw badRequest('Das ist selbst fuer einen Gastgeber zu viel.');
    }

    const account = await ctx.db.get<{ id: string; cash: string }>(
      "SELECT id, cash FROM accounts WHERE user_id = ? AND league_id = ? AND is_bot = 0",
      [ziel, id],
    );
    if (!account) throw notFound('Spieler nicht in dieser Liga.');

    const at = now();
    // Niemand soll ins Minus geschoben werden - ein negativer Kontostand
    // bricht die Margin-Rechnung und macht das Spiel unlesbar.
    const vorher = big(account.cash);
    const nachher = vorher + betrag > 0n ? vorher + betrag : 0n;
    const wirklich = nachher - vorher;

    await ctx.db.run('UPDATE accounts SET cash = ?, updated_at = ? WHERE id = ?', [
      nachher.toString(),
      at,
      account.id,
    ]);
    await ctx.db.run(
      `INSERT INTO ledger (id, account_id, kind, amount, balance_after, ref, at)
       VALUES (?, ?, 'host', ?, ?, ?, ?)`,
      [newId(), account.id, wirklich.toString(), nachher.toString(), 'Spielleiter', at],
    );

    const empfaenger = await ctx.db.get<{ username: string }>(
      'SELECT username FROM users WHERE id = ?',
      [ziel],
    );

    await ctx.trading.pushFeed(league, account.id, 'host_cash', {
      name: empfaenger?.username ?? 'Jemand',
      amountCents: wirklich.toString(),
      reason: trimText(body.reason, 80),
    });

    ctx.hub.broadcastLeague(id, 'trade', {});
    return { balanceCents: nachher.toString() };
  });

  /**
   * Den Markt anschubsen.
   *
   * Benutzt dieselbe Ereignis-Mechanik, die der Markt von sich aus verwendet -
   * also kein Sonderweg, der andere Kurse anders rechnet. Der Gastgeber setzt
   * nur die Richtung und die Dauer.
   */
  app.post('/api/leagues/:id/host/market', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      instrumentId?: string;
      direction?: 'up' | 'down';
      strength?: number;
      minutes?: number;
      headline?: string;
    };
    await requireHost(ctx, userId, id);

    const asset = ctx.sim.asset(String(body.instrumentId ?? ''));
    if (!asset) throw notFound('Diesen Wert gibt es im Arena-Markt nicht.');

    const staerke = clamp(int(body.strength, 2), 1, 3);
    const minuten = clamp(int(body.minutes, 3), 1, 15);
    const hoch = body.direction !== 'down';
    // 150 / 400 / 900 Basispunkte je Minute: spuerbar, deutlich, brutal.
    const drift = [150, 400, 900][staerke - 1]! * (hoch ? 1 : -1);

    const headline =
      trimText(body.headline, 90) ||
      (hoch ? `Grossauftrag fuer ${asset.name}` : `Abverkauf bei ${asset.name}`);

    ctx.sim.forceEvent(asset.instrumentId, headline, drift, minuten);
    return { ok: true, headline };
  });

  /** Sofort einen Memecoin an den Markt bringen. */
  app.post('/api/leagues/:id/host/meme', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    await requireHost(ctx, userId, id);

    const symbol = await ctx.sim.spawnMemeNow();
    if (!symbol) throw badRequest('Gerade ist kein Name frei - warte kurz.');
    return { symbol };
  });

  /**
   * Etwas auf die Bildschirme werfen.
   *
   * Geht an alle oder an einen einzelnen. Der Client zeigt es als Vollbild -
   * Text, Bild, Video, dazu ein paar Effekte. Reiner Unfug, und genau dafuer
   * ist es da.
   */
  app.post('/api/leagues/:id/host/takeover', async (request) => {
    const userId = requireUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as {
      targetUserId?: string | null;
      title?: string;
      body?: string;
      mediaUrl?: string;
      effect?: string;
      seconds?: number;
    };
    await requireHost(ctx, userId, id);

    const sekunden = clamp(int(body.seconds, 6), 2, 60);
    const nutzlast = {
      targetUserId: body.targetUserId ? String(body.targetUserId) : null,
      title: trimText(body.title, 60),
      text: trimText(body.body, 240),
      mediaUrl: trimText(body.mediaUrl, 500),
      effect: ['keiner', 'beben', 'kopfstand', 'regen', 'stroboskop'].includes(String(body.effect))
        ? String(body.effect)
        : 'keiner',
      ms: sekunden * 1_000,
    };

    if (!nutzlast.title && !nutzlast.text && !nutzlast.mediaUrl) {
      throw badRequest('Ohne Inhalt passiert nichts.');
    }

    ctx.hub.broadcastLeague(id, 'takeover', nutzlast);
    return { ok: true };
  });

  /**
   * Datei hochladen.
   *
   * Landet in der Datenbank, nicht auf der Platte: Das Dateisystem des
   * Servers wird bei jedem Deploy neu aufgesetzt, ein dort abgelegtes Video
   * waere am naechsten Abend weg. Sechs Megabyte reichen fuer einen kurzen
   * Clip und sprengen keine Gratis-Datenbank.
   */
  app.post('/api/media', async (request) => {
    const userId = requireUser(request);
    const body = request.body as { mime?: string; dataBase64?: string; name?: string };

    const mime = String(body.mime ?? '');
    if (!MEDIA_TYPES.includes(mime)) {
      throw badRequest('Nur Bilder, GIFs, MP4, WebM oder MP3.');
    }

    const base64 = String(body.dataBase64 ?? '');
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes <= 0) throw badRequest('Datei ist leer.');
    if (bytes > MEDIA_MAX_BYTES) {
      throw badRequest(`Zu gross: ${(bytes / 1024 / 1024).toFixed(1)} MB, erlaubt sind 6 MB.`);
    }

    const id = newId();
    await ctx.db.run(
      'INSERT INTO media (id, user_id, mime, name, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, mime, trimText(body.name, 80), bytes, base64, now()],
    );

    // Aelteres desselben Nutzers wegraeumen, damit die Datenbank nicht
    // langsam mit vergessenen Clips volllaeuft.
    await ctx.db.run(
      `DELETE FROM media WHERE user_id = ? AND id NOT IN (
         SELECT id FROM media WHERE user_id = ? ORDER BY created_at DESC LIMIT 12
       )`,
      [userId, userId],
    );

    return { id, url: `/api/media/${id}`, bytes };
  });

  /** Hochgeladene Datei ausliefern. */
  app.get('/api/media/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await ctx.db.get<{ mime: string; data: string }>(
      'SELECT mime, data FROM media WHERE id = ?',
      [id],
    );
    if (!row) throw notFound('Datei nicht gefunden.');

    reply.header('Content-Type', row.mime);
    reply.header('Cache-Control', 'public, max-age=86400, immutable');
    return reply.send(Buffer.from(row.data, 'base64'));
  });
}
