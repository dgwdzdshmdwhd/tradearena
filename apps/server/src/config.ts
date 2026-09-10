import { randomBytes } from 'node:crypto';

/**
 * Konfiguration aus Umgebungsvariablen.
 *
 * Absichtlich so gebaut, dass die App OHNE jede Konfiguration startet:
 * kein DATABASE_URL -> SQLite-Datei daneben, kein SESSION_SECRET -> eins
 * wird erzeugt. Man soll `npm run dev` tippen koennen und sofort spielen.
 * Fuer den Betrieb im Netz setzt man beides bewusst.
 */

function env(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

const generatedSecret = randomBytes(32).toString('hex');

export const config = {
  port: Number(env('PORT') ?? 8080),
  host: env('HOST') ?? '0.0.0.0',

  /** Postgres-Verbindung. Fehlt sie, laeuft alles auf SQLite. */
  databaseUrl: env('DATABASE_URL') ?? null,

  /** Pfad der SQLite-Datei, wenn kein Postgres konfiguriert ist. */
  sqlitePath: env('SQLITE_PATH') ?? 'tradearena.db',

  /**
   * Schluessel fuer die Sitzungs-Cookies. Ohne gesetzten Wert wird bei jedem
   * Start ein neuer erzeugt - dann muessen sich alle neu anmelden. Fuer den
   * Betrieb also unbedingt setzen.
   */
  sessionSecret: env('SESSION_SECRET') ?? generatedSecret,
  sessionSecretIsGenerated: env('SESSION_SECRET') === undefined,

  /** Cookie nur ueber HTTPS ausliefern. */
  secureCookies: (env('SECURE_COOKIES') ?? 'auto') !== 'false',

  /** Krypto-Universum, das der Preis-Feed abonniert. */
  symbols: (
    env('BINANCE_SYMBOLS') ??
    'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,PEPEUSDT,BNBUSDT'
  )
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean),

  /** Wie oft die Engine offene Orders prueft. */
  tickMs: Number(env('TICK_MS') ?? 250),

  /** Wie oft Kurse an die Browser verteilt werden. */
  broadcastMs: Number(env('BROADCAST_MS') ?? 250),

  /** Wie oft ein Equity-Punkt fuer die Kurve gespeichert wird. */
  snapshotMs: Number(env('SNAPSHOT_MS') ?? 60_000),

  /** Nur zum Testen: verhindert die Verbindung zu Binance. */
  offline: env('OFFLINE') === 'true',

  /** Verzeichnis mit dem gebauten Frontend. */
  webRoot: env('WEB_ROOT') ?? null,
} as const;

export const isProduction = (env('NODE_ENV') ?? 'development') === 'production';
