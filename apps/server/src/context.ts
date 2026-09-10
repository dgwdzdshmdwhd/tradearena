import type { FastifyReply, FastifyRequest } from 'fastify';

import { SESSION_COOKIE, readToken } from './auth.js';
import type { Db } from './db.js';
import type { Engine } from './engine.js';
import type { Hub } from './hub.js';
import type { MarketFeed } from './market.js';
import type { ReplayStore } from './replay.js';
import type { SimMarket } from './simmarket.js';
import type { Trading } from './trading.js';
import { unauthorized } from './util.js';

export interface Context {
  db: Db;
  trading: Trading;
  engine: Engine;
  feed: MarketFeed;
  replay: ReplayStore;
  hub: Hub;
  sim: SimMarket;
}

/** Holt den angemeldeten Benutzer aus dem Cookie - oder wirft 401. */
export function requireUser(request: FastifyRequest): string {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies ?? {};
  const userId = readToken(cookies[SESSION_COOKIE]);
  if (!userId) throw unauthorized();
  return userId;
}

export function optionalUser(request: FastifyRequest): string | null {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies ?? {};
  return readToken(cookies[SESSION_COOKIE]);
}

export function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}
