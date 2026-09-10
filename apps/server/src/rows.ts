/**
 * Datenbankzeilen und ihre typisierten Gegenstuecke.
 *
 * Regel: In der Datenbank stehen Geldbetraege als TEXT, im Code sind sie
 * bigint. Die Umwandlung passiert genau hier und nirgendwo sonst.
 */

import type { LeagueRules } from '@tradearena/core';

import { big, bigOrNull, bool, int, jsonParse } from './util.js';

export interface LeagueRow {
  id: string;
  name: string;
  owner_id: string;
  invite_code: string;
  mode: string;
  status: string;
  starting_cash: string;
  taker_bps: number;
  maker_bps: number;
  fixed_fee: string;
  slippage_factor_bps: number;
  ref_depth: string;
  short_borrow_bps: number;
  max_leverage: number;
  maintenance_bps: number;
  feed_visibility: string;
  portfolio_visibility: string;
  rugpull_mode: string;
  bots_allowed: number;
  coins_allowed: number;
  upgrades_allowed: number;
  survival_drawdown_bps: number;
  symbols: string;
  market: string;
  created_at: number;
  starts_at: number;
  ends_at: number | null;
  scenario_key: string | null;
  replay_from: number | null;
  replay_to: number | null;
  replay_cursor: number | null;
  replay_speed: number;
  finished_at: number | null;
}

export type LeagueMode = 'classic' | 'timemachine' | 'blitz' | 'survival';
export type FeedVisibility = 'instant' | 'delayed' | 'end_only';
export type PortfolioVisibility = 'open' | 'delayed' | 'hidden';
export type RugpullMode = 'off' | 'locked' | 'free';

export interface League {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  mode: LeagueMode;
  status: 'running' | 'finished';
  startingCash: bigint;
  rules: LeagueRules;
  feedVisibility: FeedVisibility;
  portfolioVisibility: PortfolioVisibility;
  rugpullMode: RugpullMode;
  botsAllowed: boolean;
  coinsAllowed: boolean;
  upgradesAllowed: boolean;
  survivalDrawdownBps: number;
  symbols: string[];
  market: 'arena' | 'crypto';
  createdAt: number;
  startsAt: number;
  endsAt: number | null;
  scenarioKey: string | null;
  replayFrom: number | null;
  replayTo: number | null;
  replayCursor: number | null;
  replaySpeed: number;
  finishedAt: number | null;
}

export function toLeague(row: LeagueRow): League {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    inviteCode: row.invite_code,
    mode: row.mode as LeagueMode,
    status: row.status as 'running' | 'finished',
    startingCash: big(row.starting_cash),
    rules: {
      fees: {
        takerBps: int(row.taker_bps, 10),
        makerBps: int(row.maker_bps, 4),
        fixedCents: big(row.fixed_fee),
      },
      slippage: {
        factorBps: int(row.slippage_factor_bps, 8),
        refDepthCents: big(row.ref_depth),
      },
      shortBorrowBpsDaily: int(row.short_borrow_bps, 8),
      maxLeverage: int(row.max_leverage, 1),
      maintenanceMarginBps: int(row.maintenance_bps, 5_000),
    },
    feedVisibility: row.feed_visibility as FeedVisibility,
    portfolioVisibility: row.portfolio_visibility as PortfolioVisibility,
    rugpullMode: row.rugpull_mode as RugpullMode,
    botsAllowed: bool(row.bots_allowed),
    coinsAllowed: bool(row.coins_allowed),
    upgradesAllowed: bool(row.upgrades_allowed),
    survivalDrawdownBps: int(row.survival_drawdown_bps, 3_000),
    symbols: jsonParse<string[]>(row.symbols, []),
    market: row.market === 'crypto' ? 'crypto' : 'arena',
    createdAt: int(row.created_at),
    startsAt: int(row.starts_at),
    endsAt: row.ends_at === null ? null : int(row.ends_at),
    scenarioKey: row.scenario_key,
    replayFrom: row.replay_from === null ? null : int(row.replay_from),
    replayTo: row.replay_to === null ? null : int(row.replay_to),
    replayCursor: row.replay_cursor === null ? null : int(row.replay_cursor),
    replaySpeed: int(row.replay_speed, 60),
    finishedAt: row.finished_at === null ? null : int(row.finished_at),
  };
}

export interface AccountRow {
  id: string;
  league_id: string;
  user_id: string;
  label: string;
  is_bot: number;
  parent_account_id: string | null;
  cash: string;
  start_cash: string;
  realized: string;
  fees_paid: string;
  equity: string;
  peak_equity: string;
  trough_equity: string;
  trades_count: number;
  trades_today: number;
  trades_today_date: string;
  created_at: number;
  updated_at: number;
}

export interface Account {
  id: string;
  leagueId: string;
  userId: string;
  label: string;
  isBot: boolean;
  parentAccountId: string | null;
  cash: bigint;
  startCash: bigint;
  realized: bigint;
  feesPaid: bigint;
  equity: bigint;
  peakEquity: bigint;
  troughEquity: bigint;
  tradesCount: number;
  tradesToday: number;
  tradesTodayDate: string;
}

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    leagueId: row.league_id,
    userId: row.user_id,
    label: row.label,
    isBot: bool(row.is_bot),
    parentAccountId: row.parent_account_id,
    cash: big(row.cash),
    startCash: big(row.start_cash),
    realized: big(row.realized),
    feesPaid: big(row.fees_paid),
    equity: big(row.equity),
    peakEquity: big(row.peak_equity),
    troughEquity: big(row.trough_equity),
    tradesCount: int(row.trades_count),
    tradesToday: int(row.trades_today),
    tradesTodayDate: row.trades_today_date,
  };
}

export interface InstrumentRow {
  id: string;
  league_id: string | null;
  symbol: string;
  display: string;
  kind: string;
  price_source: string;
  qty_step: string;
  price_step: string;
  min_notional: string;
  active: number;
  created_at: number;
}

export interface Instrument {
  id: string;
  leagueId: string | null;
  symbol: string;
  display: string;
  kind: 'crypto' | 'coin' | 'sim';
  priceSource: 'external' | 'amm' | 'sim';
  qtyStep: bigint;
  priceStep: bigint;
  minNotional: bigint;
  active: boolean;
}

export function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    leagueId: row.league_id,
    symbol: row.symbol,
    display: row.display,
    kind: row.kind as 'crypto' | 'coin' | 'sim',
    priceSource: row.price_source as 'external' | 'amm' | 'sim',
    qtyStep: big(row.qty_step),
    priceStep: big(row.price_step),
    minNotional: big(row.min_notional),
    active: bool(row.active),
  };
}

export interface PositionRow {
  id: string;
  account_id: string;
  instrument_id: string;
  qty: string;
  avg_entry: string;
  realized: string;
  opened_at: number | null;
  last_borrow_at: number | null;
  worst_bps: number;
  best_bps: number;
  updated_at: number;
}

export interface OrderRow {
  id: string;
  account_id: string;
  league_id: string;
  instrument_id: string;
  side: string;
  type: string;
  qty: string;
  filled_qty: string;
  limit_price: string | null;
  stop_price: string | null;
  trail_bps: number | null;
  trail_anchor: string | null;
  tif: string;
  status: string;
  triggered: number;
  reduce_only: number;
  oco_group: string | null;
  avg_fill_price: string | null;
  reject_reason: string | null;
  source: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface CoinRow {
  instrument_id: string;
  league_id: string;
  creator_account_id: string;
  name: string;
  ticker: string;
  emoji: string;
  color: string;
  description: string;
  total_supply: string;
  reserve_usd: string;
  reserve_tokens: string;
  fee_bps: number;
  lp_shares: string;
  lp_lock_until: number | null;
  status: string;
  created_at: number;
  rugged_at: number | null;
  rugged_amount: string | null;
  pull_at: number | null;
  pull_account_id: string | null;
  pull_pct: number | null;
}

export interface BotRow {
  id: string;
  account_id: string;
  user_id: string;
  league_id: string;
  name: string;
  strategy: string;
  params: string;
  instrument_id: string;
  budget: string;
  level: number;
  xp: number;
  error_rate_bps: number;
  status: string;
  last_action_at: number | null;
  created_at: number;
}

export const asBig = big;
export const asBigOrNull = bigOrNull;
