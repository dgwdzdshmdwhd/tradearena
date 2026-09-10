/**
 * Duenne Huelle um fetch.
 *
 * Die Sitzung liegt in einem httpOnly-Cookie - der Browser schickt sie von
 * selbst mit. Es gibt hier bewusst keinen Token im JavaScript, damit ein
 * eingeschleustes Skript ihn auch nicht stehlen kann.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Netzwerkfehler, z. B. waehrend der Server neu startet. Als saubere
    // ApiError weiterreichen statt als roher TypeError.
    throw new ApiError(0, 'Server gerade nicht erreichbar.');
  }

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Fehler ${response.status}`;
    throw new ApiError(response.status, message);
  }

  return data as T;
}

/**
 * Fuer die regelmaessigen Auffrisch-Aufrufe: ein Aussetzer beim Server ist
 * kein Grund, die Konsole vollzuschreiben. Beim naechsten Takt klappt es
 * wieder.
 */
export function quiet(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

export const api = {
  get: <T,>(path: string): Promise<T> => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body ?? {}),
  patch: <T,>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body ?? {}),
};

// --- Typen, die zwischen Server und Browser wandern ----------------------

export interface Me {
  user: { id: string; username: string; avatar: string };
  prestige: number;
  lifetimePrestige: number;
  soundEnabled: boolean;
  rank: { key: string; title: string; icon: string; minPrestige: number };
  nextRank: { key: string; title: string; icon: string; minPrestige: number } | null;
  upgrades: Record<string, number>;
  effects: {
    feeDiscountBps: number;
    slippageReductionPct: number;
    botSlots: number;
    features: string[];
    cosmetics: string[];
  };
}

export interface LeagueSummary {
  id: string;
  name: string;
  mode: string;
  status: string;
  inviteCode: string;
  members: number;
  endsAt: number | null;
  equityCents: string;
  startCents: string;
  eliminated: boolean;
  isOwner: boolean;
}

export interface LeagueDetail {
  id: string;
  name: string;
  mode: 'classic' | 'blitz' | 'survival' | 'timemachine';
  /** 'arena' = eigene Werte des Spiels, 'crypto' = echte Boersenkurse. */
  market: 'arena' | 'crypto';
  status: 'running' | 'finished';
  inviteCode: string;
  startingCashCents: string;
  fees: { takerBps: number; makerBps: number; fixedCents: string };
  slippageFactorBps: number;
  shortBorrowBpsDaily: number;
  maxLeverage: number;
  maintenanceMarginBps: number;
  feedVisibility: string;
  portfolioVisibility: string;
  rugpullMode: string;
  botsAllowed: boolean;
  coinsAllowed: boolean;
  upgradesAllowed: boolean;
  survivalDrawdownBps: number;
  symbols: string[];
  startsAt: number;
  endsAt: number | null;
  finishedAt: number | null;
  replayCursor: number | null;
  replaySpeed: number;
  ownerId: string;
  reveal: string | null;
  scenarioName: string | null;
  replayLoaded: boolean;
}

export interface Instrument {
  id: string;
  symbol: string;
  display: string;
  kind: 'crypto' | 'coin';
  qtyStep: string;
  priceStep: string;
  minNotionalCents: string;
  bid: string | null;
  ask: string | null;
  last: string | null;
  /** Veraenderung ueber den geladenen Zeitraum in Basispunkten. */
  changeBps: number | null;
}

export interface Position {
  instrumentId: string;
  symbol: string;
  display: string;
  kind: string;
  qty: string;
  avgEntry: string;
  mark: string;
  unrealizedCents: string;
  exposureCents: string;
  openedAt: number | null;
}

export interface OrderRow {
  id: string;
  instrument_id: string;
  display: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  qty: string;
  filled_qty: string;
  limit_price: string | null;
  stop_price: string | null;
  trail_bps: number | null;
  tif: string;
  status: string;
  reduce_only: number;
  avg_fill_price: string | null;
  reject_reason: string | null;
  created_at: number;
}

export interface Portfolio {
  account: {
    id: string;
    userId: string;
    cashCents: string;
    startCents: string;
    equityCents: string;
    realizedCents: string;
    feesPaidCents: string;
    peakEquityCents: string;
    troughEquityCents: string;
    trades: number;
    isBot: boolean;
  };
  positions: Position[];
  orders: OrderRow[];
  margin: {
    exposureCents: string;
    usedMarginCents: string;
    buyingPowerCents: string;
    marginLevelBps: string;
    marginCall: boolean;
  };
}

export interface LeaderboardEntry {
  accountId: string;
  userId: string;
  username: string;
  avatar: string;
  isBot: boolean;
  label: string;
  equityCents: string;
  startCents: string;
  cashCents: string;
  returnBps: number;
  trades: number;
  eliminated: boolean;
  isMe: boolean;
}

export interface FeedEvent {
  id: string;
  accountId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: number;
  username: string | null;
  avatar: string | null;
  reactions: Array<{ emoji: string; userId: string }>;
}

export interface ChatMessage {
  id: string;
  user_id: string;
  body: string;
  created_at: number;
  username: string;
  avatar: string;
}

export interface Coin {
  instrumentId: string;
  name: string;
  ticker: string;
  emoji: string;
  color: string;
  description: string;
  creatorUserId: string;
  creatorName: string;
  status: string;
  priceCents: string;
  reserveUsdCents: string;
  reserveTokens: string;
  totalSupply: string;
  marketCapCents: string;
  feeBps: number;
  lpLockUntil: number | null;
  ruggedAt: number | null;
  ruggedAmountCents: string | null;
  risk: { score: number; locked: boolean; creatorSharePct: number };
  holders: number;
  myShares: string;
  myQty: string;
  isMine: boolean;
  createdAt: number;
}

export interface Bot {
  id: string;
  name: string;
  strategy: string;
  instrument_id: string;
  display: string;
  budget: string;
  cash: string;
  equity: string;
  start_cash: string;
  level: number;
  xp: number;
  error_rate_bps: number;
  status: string;
  trades_count: number;
  decisions: Array<{
    id: string;
    at: number;
    action: string;
    reason: string;
    mistake: string | null;
  }>;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Achievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  tier: string;
  prestige: number;
  unlockedAt: number | null;
}

export interface Upgrade {
  key: string;
  branch: string;
  name: string;
  description: string;
  icon: string;
  costs: number[];
  level: number;
  maxLevel: number;
  nextCost: number | null;
}
