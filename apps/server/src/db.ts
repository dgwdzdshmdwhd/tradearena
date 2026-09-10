/**
 * Datenbank-Schicht.
 *
 * Zwei Treiber, eine SQL-Syntax:
 *   - SQLite (in Node eingebaut) fuer lokal, ohne jeden Account
 *   - Postgres (via DATABASE_URL) fuer den Betrieb im Netz
 *
 * Damit dasselbe SQL auf beiden laeuft, halten wir uns an den gemeinsamen
 * Nenner: TEXT, INTEGER, keine Dialekt-Spezialitaeten. Platzhalter schreiben
 * wir immer als `?`, fuer Postgres werden sie in $1, $2, ... umgeschrieben.
 *
 * WICHTIG - alle Geldbetraege, Preise und Mengen stehen als TEXT in der
 * Datenbank. Grund: JSON und JavaScript-Zahlen verlieren oberhalb von 2^53
 * an Genauigkeit, und eine Coin-Menge wie 100.000.000.00000000 liegt
 * darueber. Als Zeichenkette gespeichert und mit BigInt gelesen, stimmt
 * jeder Cent - ohne Ausnahme.
 */

import { config } from './config.js';

export type Row = Record<string, unknown>;

export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /**
   * Fuehrt mehrere Schreibvorgaenge als eine Einheit aus. Entweder alles
   * oder nichts - das ist die Absicherung gegen halb gebuchte Trades.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `?` in `$1, $2, ...` umschreiben - der einzige Dialekt-Unterschied. */
function toPostgres(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

/**
 * SQLite wird erst hier geladen, nicht oben im Modul. Sonst wuerde eine
 * Postgres-Installation auf einer aelteren Node-Version daran scheitern,
 * dass `node:sqlite` dort noch ein Flag braucht - obwohl sie SQLite gar
 * nicht benutzt.
 */
async function createSqlite(path: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  let depth = 0;

  return {
    dialect: 'sqlite',
    async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
      const row = db.prepare(sql).get(...(params as never[]));
      return (row as T | undefined) ?? null;
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      db.prepare(sql).run(...(params as never[]));
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      // Verschachtelte Transaktionen einfach durchreichen.
      if (depth > 0) return fn();

      depth += 1;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        depth -= 1;
      }
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

async function createPostgres(url: string): Promise<Db> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: url,
    max: 8,
    ssl: url.includes('localhost') || url.includes('sslmode=disable')
      ? undefined
      : { rejectUnauthorized: false },
  });

  // Postgres liefert BIGINT und NUMERIC als String - genau so wollen wir es.
  let txClient: import('pg').PoolClient | null = null;

  const query = async (sql: string, params: unknown[]): Promise<Row[]> => {
    const text = toPostgres(sql);
    if (txClient) {
      const result = await txClient.query(text, params);
      return result.rows as Row[];
    }
    const result = await pool.query(text, params);
    return result.rows as Row[];
  };

  return {
    dialect: 'postgres',
    async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await query(sql, params)) as T[];
    },
    async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
      const rows = await query(sql, params);
      return (rows[0] as T | undefined) ?? null;
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      await query(sql, params);
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      if (txClient) return fn();

      const client = await pool.connect();
      txClient = client;
      try {
        await client.query('BEGIN');
        const result = await fn();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        txClient = null;
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export async function openDatabase(): Promise<Db> {
  if (config.databaseUrl) {
    const db = await createPostgres(config.databaseUrl);
    await migrate(db);
    return db;
  }

  const db = await createSqlite(config.sqlitePath);
  await migrate(db);
  return db;
}

/**
 * Schema. Bewusst ohne Fremdschluessel-Kaskaden und ohne Dialekt-Extras -
 * es muss auf SQLite und Postgres identisch durchlaufen.
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '🙂',
    prestige INTEGER NOT NULL DEFAULT 0,
    lifetime_prestige INTEGER NOT NULL DEFAULT 0,
    sound_enabled INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS user_upgrades (
    user_id TEXT NOT NULL,
    upgrade_key TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, upgrade_key)
  )`,

  `CREATE TABLE IF NOT EXISTS user_achievements (
    user_id TEXT NOT NULL,
    achievement_key TEXT NOT NULL,
    league_id TEXT,
    unlocked_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, achievement_key)
  )`,

  `CREATE TABLE IF NOT EXISTS leagues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'classic',
    status TEXT NOT NULL DEFAULT 'running',
    starting_cash TEXT NOT NULL,
    taker_bps INTEGER NOT NULL DEFAULT 10,
    maker_bps INTEGER NOT NULL DEFAULT 4,
    fixed_fee TEXT NOT NULL DEFAULT '0',
    slippage_factor_bps INTEGER NOT NULL DEFAULT 8,
    ref_depth TEXT NOT NULL DEFAULT '500000000',
    short_borrow_bps INTEGER NOT NULL DEFAULT 8,
    max_leverage INTEGER NOT NULL DEFAULT 1,
    maintenance_bps INTEGER NOT NULL DEFAULT 5000,
    feed_visibility TEXT NOT NULL DEFAULT 'instant',
    portfolio_visibility TEXT NOT NULL DEFAULT 'open',
    rugpull_mode TEXT NOT NULL DEFAULT 'locked',
    bots_allowed INTEGER NOT NULL DEFAULT 1,
    coins_allowed INTEGER NOT NULL DEFAULT 1,
    upgrades_allowed INTEGER NOT NULL DEFAULT 0,
    survival_drawdown_bps INTEGER NOT NULL DEFAULT 3000,
    symbols TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL,
    starts_at BIGINT NOT NULL,
    ends_at BIGINT,
    scenario_key TEXT,
    replay_from BIGINT,
    replay_to BIGINT,
    replay_cursor BIGINT,
    replay_speed INTEGER NOT NULL DEFAULT 60,
    finished_at BIGINT
  )`,

  `CREATE TABLE IF NOT EXISTS league_members (
    league_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at BIGINT NOT NULL,
    eliminated_at BIGINT,
    PRIMARY KEY (league_id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    is_bot INTEGER NOT NULL DEFAULT 0,
    parent_account_id TEXT,
    cash TEXT NOT NULL,
    start_cash TEXT NOT NULL,
    realized TEXT NOT NULL DEFAULT '0',
    fees_paid TEXT NOT NULL DEFAULT '0',
    equity TEXT NOT NULL,
    peak_equity TEXT NOT NULL,
    trough_equity TEXT NOT NULL,
    trades_count INTEGER NOT NULL DEFAULT 0,
    trades_today INTEGER NOT NULL DEFAULT 0,
    trades_today_date TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS instruments (
    id TEXT PRIMARY KEY,
    league_id TEXT,
    symbol TEXT NOT NULL,
    display TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'crypto',
    price_source TEXT NOT NULL DEFAULT 'external',
    qty_step TEXT NOT NULL,
    price_step TEXT NOT NULL,
    min_notional TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS coins (
    instrument_id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    creator_account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ticker TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🪙',
    color TEXT NOT NULL DEFAULT '#f7c948',
    description TEXT NOT NULL DEFAULT '',
    total_supply TEXT NOT NULL,
    reserve_usd TEXT NOT NULL,
    reserve_tokens TEXT NOT NULL,
    fee_bps INTEGER NOT NULL DEFAULT 100,
    lp_shares TEXT NOT NULL,
    lp_lock_until BIGINT,
    status TEXT NOT NULL DEFAULT 'live',
    created_at BIGINT NOT NULL,
    rugged_at BIGINT,
    rugged_amount TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS lp_shares (
    coin_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    shares TEXT NOT NULL,
    PRIMARY KEY (coin_id, account_id)
  )`,

  `CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    qty TEXT NOT NULL DEFAULT '0',
    avg_entry TEXT NOT NULL DEFAULT '0',
    realized TEXT NOT NULL DEFAULT '0',
    opened_at BIGINT,
    last_borrow_at BIGINT,
    worst_bps INTEGER NOT NULL DEFAULT 0,
    best_bps INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS positions_account_instrument
     ON positions (account_id, instrument_id)`,

  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    league_id TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    side TEXT NOT NULL,
    type TEXT NOT NULL,
    qty TEXT NOT NULL,
    filled_qty TEXT NOT NULL DEFAULT '0',
    limit_price TEXT,
    stop_price TEXT,
    trail_bps INTEGER,
    trail_anchor TEXT,
    tif TEXT NOT NULL DEFAULT 'gtc',
    status TEXT NOT NULL DEFAULT 'working',
    triggered INTEGER NOT NULL DEFAULT 0,
    reduce_only INTEGER NOT NULL DEFAULT 0,
    oco_group TEXT,
    avg_fill_price TEXT,
    reject_reason TEXT,
    source TEXT NOT NULL DEFAULT 'human',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    closed_at BIGINT
  )`,

  `CREATE INDEX IF NOT EXISTS orders_open ON orders (status, league_id)`,

  `CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    league_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    side TEXT NOT NULL,
    qty TEXT NOT NULL,
    price TEXT NOT NULL,
    gross TEXT NOT NULL,
    fee TEXT NOT NULL,
    slippage TEXT NOT NULL DEFAULT '0',
    realized TEXT NOT NULL DEFAULT '0',
    source TEXT NOT NULL DEFAULT 'human',
    executed_at BIGINT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS trades_account ON trades (account_id, executed_at)`,

  `CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount TEXT NOT NULL,
    balance_after TEXT NOT NULL,
    ref TEXT,
    at BIGINT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS ledger_account ON ledger (account_id, at)`,

  `CREATE TABLE IF NOT EXISTS equity_snapshots (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    at BIGINT NOT NULL,
    equity TEXT NOT NULL,
    cash TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS equity_account ON equity_snapshots (account_id, at)`,

  `CREATE TABLE IF NOT EXISTS feed (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    account_id TEXT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    visible_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS feed_league ON feed (league_id, visible_at)`,

  `CREATE TABLE IF NOT EXISTS chat (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS chat_league ON chat (league_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS reactions_unique
     ON reactions (target_type, target_id, user_id, emoji)`,

  `CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    league_id TEXT NOT NULL,
    name TEXT NOT NULL,
    strategy TEXT NOT NULL,
    params TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    budget TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    error_rate_bps INTEGER NOT NULL DEFAULT 1800,
    status TEXT NOT NULL DEFAULT 'running',
    last_action_at BIGINT,
    created_at BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS bot_decisions (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    at BIGINT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    mistake TEXT,
    order_id TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS bot_decisions_bot ON bot_decisions (bot_id, at)`,

  `CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL,
    author_account_id TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    comparator TEXT NOT NULL,
    target_price TEXT NOT NULL,
    resolve_at BIGINT NOT NULL,
    stake TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    outcome TEXT,
    created_at BIGINT NOT NULL,
    text TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS bet_stakes (
    id TEXT PRIMARY KEY,
    bet_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    side TEXT NOT NULL,
    amount TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS bet_stakes_unique ON bet_stakes (bet_id, account_id)`,
];

async function migrate(db: Db): Promise<void> {
  for (const statement of SCHEMA) {
    await db.run(statement);
  }
}
