/**
 * TradeArena - Serverstart.
 *
 * Ein einziger Prozess macht alles: HTTP-API, WebSocket-Verteilung, Preis-Feed
 * und die Engine-Schleife. Genau deshalb laesst sich das Ganze kostenlos auf
 * einem einzigen kleinen Dienst betreiben - und lokal mit einem Befehl starten.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import { config } from './config.js';
import type { Context } from './context.js';
import { openDatabase } from './db.js';
import { Engine } from './engine.js';
import { Hub } from './hub.js';
import { MarketFeed } from './market.js';
import { ReplayStore } from './replay.js';
import { SimMarket } from './simmarket.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLeagueRoutes } from './routes/leagues.js';
import { registerHostRoutes } from './routes/host.js';
import { registerTradeRoutes } from './routes/trade.js';
import { Trading } from './trading.js';
import { HttpError, Mutex, newId, now } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const db = await openDatabase();
  console.log(`[db] ${db.dialect === 'sqlite' ? `SQLite (${config.sqlitePath})` : 'Postgres'}`);

  const feed = new MarketFeed(config.symbols);
  const replay = new ReplayStore(feed);
  const hub = new Hub();
  const lock = new Mutex();
  const sim = new SimMarket(db, hub);
  const trading = new Trading(db, feed, replay, hub, lock, sim);
  const engine = new Engine(db, trading, feed, replay, hub, sim);

  await sim.load();

  /**
   * Marktereignisse landen im Feed jeder laufenden Arena-Liga - und als
   * Vollbild-Meldung bei allen, die gerade zuschauen. Ohne die Ankuendigung
   * waere ein Ereignis nur ein Kurssprung, den man verpasst hat.
   */
  sim.onEvent = (asset, headline, up) => {
    void (async () => {
      const leagues = await db.all<{ id: string }>(
        "SELECT id FROM leagues WHERE status = 'running' AND market <> 'crypto'",
      );

      for (const league of leagues) {
        hub.broadcastLeague(league.id, 'market_event', {
          symbol: asset.symbol,
          name: asset.name,
          headline,
          up,
        });
      }
    })();
  };

  // Ein neuer Memecoin geht alle an - deshalb Vollbild statt Feedzeile.
  sim.onMeme = (asset) => {
    void (async () => {
      const leagues = await db.all<{ id: string }>(
        "SELECT id FROM leagues WHERE status = 'running' AND market <> 'crypto'",
      );

      for (const league of leagues) {
        hub.broadcastLeague(league.id, 'meme_launch', {
          symbol: asset.symbol,
          name: asset.name,
          blurb: asset.blurb,
          color: asset.color,
          instrumentId: asset.instrumentId,
        });
      }
    })();
  };

  hub.memberCheck = (userId, leagueId) => trading.isMember(userId, leagueId);

  const ctx: Context = { db, trading, engine, feed, replay, hub, sim };

  await seedInstruments(ctx);

  const app = Fastify({
    logger: false,
    // Reicht fuer alles im Spiel - nur hochgeladene Clips des Spielleiters
    // sind groesser. Die Grenze liegt knapp ueber den 25 MB aus host.ts, damit
    // dort die verstaendliche Fehlermeldung greift und nicht hier der harte
    // Abbruch ohne Erklaerung.
    bodyLimit: 26 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(fastifyCookie);

  /**
   * Rohe Dateien annehmen.
   *
   * Fastify versteht von Haus aus nur JSON. Hochgeladene Bilder und Clips
   * kommen als reiner Bytestrom - ohne diesen Parser antwortet der Server mit
   * "Unsupported Media Type". Base64 in JSON waere die Alternative gewesen,
   * blaeht aber um ein Drittel auf und muss komplett durch den JSON-Parser.
   */
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg'],
    { parseAs: 'buffer' },
    (_request, payload, done) => done(null, payload),
  );

  /**
   * Sicherheitsnetz: `JSON.stringify` kann mit bigint nicht umgehen und wirft
   * eine Ausnahme. Da im ganzen Projekt Geld als bigint gerechnet wird,
   * wandeln wir vor dem Serialisieren stumpf alles um, was durchgerutscht ist.
   */
  app.addHook('preSerialization', async (_request, _reply, payload) => stringifyBigInts(payload));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    console.error('[http]', error);
    void reply.status(500).send({ error: 'Da ist auf dem Server etwas schiefgelaufen.' });
  });

  app.get('/healthz', async () => ({
    ok: true,
    feed: feed.status,
    // 'rest' = Kurshistorie kommt von der Boerse, 'ticks-only' = die Boerse
    // sperrt hier die REST-Schnittstelle, der Chart waechst aus Live-Ticks.
    history: feed.historyStatus,
    connections: hub.connections,
    at: now(),
  }));

  registerAuthRoutes(app, ctx);
  registerLeagueRoutes(app, ctx);
  registerTradeRoutes(app, ctx);
  registerHostRoutes(app, ctx);

  // Gebautes Frontend ausliefern, wenn vorhanden. Im Entwicklungsmodus
  // uebernimmt das Vite auf Port 5173.
  const webRoot = config.webRoot ?? resolve(here, '../../web/dist');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      // Kein `wildcard: false`: damit liest @fastify/static das Verzeichnis
      // EINMAL beim Start und legt pro Datei eine Route an. Alles, was danach
      // gebaut wird, existiert fuer den laufenden Prozess nicht mehr - die
      // Datei liegt auf der Platte, der Server antwortet trotzdem mit 404.
      // Ohne das setzt @fastify/static seinen eigenen Cache-Header und
      // ueberschreibt damit alles, was `setHeaders` gerade gesetzt hat.
      cacheControl: false,
      /**
       * Cache-Strategie, ohne die nach jedem Deploy eine weisse Seite steht:
       *
       * Die Dateien unter /assets/ tragen einen Hash im Namen und aendern
       * sich nie - die darf der Browser ewig behalten. Die index.html
       * dagegen zeigt auf genau diese Namen. Wird sie gecacht, fragt ein
       * Browser nach dem naechsten Deploy eine JavaScript-Datei an, die es
       * nicht mehr gibt, und zeigt gar nichts an. Also: immer neu pruefen.
       */
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('.html')) {
          response.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes('assets')) {
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // Alles, was keine API-Route und keine Datei ist, bekommt die
    // Single-Page-App.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        void reply.status(404).send({ error: 'Unbekannter Endpunkt.' });
        return;
      }

      // Fehlende Dateien bleiben 404. Sonst bekaeme ein Browser, der nach
      // einem Deploy noch die alte JavaScript-Datei anfragt, HTML zurueck -
      // und zeigt dann eine weisse Seite statt sich neu zu laden.
      if (/\.[a-z0-9]{2,5}$/i.test(request.url.split('?')[0] ?? '')) {
        void reply.status(404).send({ error: 'Datei nicht gefunden.' });
        return;
      }

      void reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
    console.log(`[web] liefere ${webRoot}`);
  } else {
    console.log('[web] kein Build gefunden - im Entwicklungsmodus laeuft Vite auf Port 5173');
  }

  await app.listen({ port: config.port, host: config.host });
  console.log(`[http] laeuft auf http://localhost:${config.port}`);

  // WebSocket-Upgrades an den Hub weiterreichen.
  app.server.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/ws')) {
      hub.handleUpgrade(request, socket, head);
    } else {
      socket.destroy();
    }
  });

  feed.start();
  sim.start();
  engine.start();

  if (config.sessionSecretIsGenerated) {
    console.warn(
      '[auth] SESSION_SECRET ist nicht gesetzt - nach einem Neustart muessen sich alle neu anmelden.',
    );
  }

  const shutdown = async (): Promise<void> => {
    console.log('\n[server] fahre herunter ...');
    engine.stop();
    sim.stop();
    feed.stop();
    await app.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/**
 * Die handelbaren Krypto-Instrumente anlegen. Laeuft bei jedem Start und
 * ergaenzt nur, was noch fehlt.
 */
async function seedInstruments(ctx: Context): Promise<void> {
  const at = now();

  for (const symbol of config.symbols) {
    const existing = await ctx.db.get('SELECT id FROM instruments WHERE symbol = ? AND league_id IS NULL', [
      symbol,
    ]);
    if (existing) continue;

    const base = symbol.replace(/USDT$/, '');
    await ctx.db.run(
      `INSERT INTO instruments (id, league_id, symbol, display, kind, price_source,
                                qty_step, price_step, min_notional, active, created_at)
       VALUES (?, NULL, ?, ?, 'crypto', 'external', ?, '1000000', '100', 1, ?)`,
      [newId(), symbol, `${base}/USD`, stepFor(symbol), at],
    );
  }
}

function stringifyBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigInts);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stringifyBigInts(entry);
    }
    return out;
  }
  return value;
}

/** Sinnvolle Lot-Groessen: bei BTC feiner als bei DOGE. */
function stepFor(symbol: string): string {
  if (symbol.startsWith('BTC')) return '1000'; // 0,00001
  if (symbol.startsWith('ETH') || symbol.startsWith('BNB')) return '10000';
  if (symbol.startsWith('PEPE') || symbol.startsWith('DOGE')) return '10000000'; // 0,1
  return '100000'; // 0,001
}

main().catch((error: unknown) => {
  console.error('[server] Start fehlgeschlagen:', error);
  process.exit(1);
});
