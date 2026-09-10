/**
 * Anmeldung mit Benutzername und Passwort.
 *
 * Bewusst ohne E-Mail-Versand und ohne Google-Login: Fuer eine App unter
 * Freunden waere beides nur eine zusaetzliche Huerde (und ein weiterer
 * Dienst, bei dem man sich anmelden muss). Ein Einladungscode reicht.
 *
 * Passwoerter werden mit scrypt gehasht (in Node eingebaut, kein Paket
 * noetig), Sitzungen laufen ueber ein HMAC-signiertes Cookie. Es gibt keine
 * Sitzungstabelle - das Cookie traegt seine eigene Gueltigkeit.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { config } from './config.js';
import type { Db } from './db.js';
import { HttpError, newId, now, trimText } from './util.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'ta_session';

export interface SessionUser {
  id: string;
  username: string;
  avatar: string;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scryptAsync(password, salt, 64);
  return derived.toString('hex');
}

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function createToken(userId: string): string {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: expires })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readToken(token: string | undefined): string | null {
  if (!token) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload);
  // Zeitkonstanter Vergleich, damit man die Signatur nicht Byte fuer Byte erraten kann.
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      uid?: string;
      exp?: number;
    };
    if (!data.uid || !data.exp || data.exp < Date.now()) return null;
    return data.uid;
  } catch {
    return null;
  }
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;

export async function register(
  db: Db,
  usernameRaw: unknown,
  passwordRaw: unknown,
): Promise<SessionUser> {
  const username = trimText(usernameRaw, 20);
  const password = typeof passwordRaw === 'string' ? passwordRaw : '';

  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(
      400,
      'Benutzername: 3-20 Zeichen, nur Buchstaben, Zahlen, - und _',
    );
  }
  if (password.length < 6) {
    throw new HttpError(400, 'Das Passwort braucht mindestens 6 Zeichen.');
  }

  const lower = username.toLowerCase();
  const existing = await db.get('SELECT id FROM users WHERE username_lower = ?', [lower]);
  if (existing) {
    throw new HttpError(409, 'Diesen Benutzernamen gibt es schon.');
  }

  const salt = randomBytes(16).toString('hex');
  const passwordHash = await hashPassword(password, salt);
  const id = newId();
  const avatar = randomAvatar();

  await db.run(
    `INSERT INTO users (id, username, username_lower, password_hash, salt, avatar, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, username, lower, passwordHash, salt, avatar, now()],
  );

  return { id, username, avatar };
}

export async function login(
  db: Db,
  usernameRaw: unknown,
  passwordRaw: unknown,
): Promise<SessionUser> {
  const username = trimText(usernameRaw, 20).toLowerCase();
  const password = typeof passwordRaw === 'string' ? passwordRaw : '';

  const user = await db.get<{
    id: string;
    username: string;
    password_hash: string;
    salt: string;
    avatar: string;
  }>('SELECT id, username, password_hash, salt, avatar FROM users WHERE username_lower = ?', [
    username,
  ]);

  // Auch ohne Treffer rechnen wir einen Hash, damit man aus der Antwortzeit
  // nicht ablesen kann, welche Benutzernamen existieren.
  const salt = user?.salt ?? 'nichtvorhanden';
  const candidate = await hashPassword(password, salt);

  if (!user || candidate !== user.password_hash) {
    throw new HttpError(401, 'Benutzername oder Passwort stimmt nicht.');
  }

  return { id: user.id, username: user.username, avatar: user.avatar };
}

export async function loadUser(db: Db, userId: string): Promise<SessionUser | null> {
  const user = await db.get<{ id: string; username: string; avatar: string }>(
    'SELECT id, username, avatar FROM users WHERE id = ?',
    [userId],
  );
  return user ?? null;
}

const AVATARS = ['🦊', '🐻', '🦈', '🐺', '🦅', '🐙', '🦁', '🐸', '🦀', '🐲', '🤠', '👾'];

function randomAvatar(): string {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)] as string;
}
