/**
 * Die Tycoon-Ebene: dein Trading-Desk ueber alle Ligen hinweg.
 *
 * Waehrung ist Prestige, verdient durch Volumen, Platzierungen und
 * Achievements. Prestige laesst sich NICHT in Spielgeld umwandeln - in keine
 * Richtung. Sonst waere die Rangliste sofort kaputt.
 *
 * Und der wichtige Teil: In Wettkampf-Ligen sind Upgrades standardmaessig
 * ABGESCHALTET. Wer 200 Stunden gespielt hat, soll keine dauerhaft
 * niedrigeren Gebuehren haben als der Neuling am Freitagabend. In
 * Tycoon-Ligen wirken sie voll.
 */

import type { FeeConfig } from './types.js';

export type UpgradeBranch = 'broker' | 'research' | 'bots' | 'launchpad' | 'treasury' | 'office';

export interface UpgradeDef {
  key: string;
  branch: UpgradeBranch;
  name: string;
  description: string;
  icon: string;
  /** Kosten je Stufe, Index 0 = erste Stufe. */
  costs: readonly number[];
  /** Was eine Stufe bewirkt - wird in `resolveEffects` ausgewertet. */
  effect: UpgradeEffect;
}

export type UpgradeEffect =
  /** Senkt die Gebuehren um X Basispunkte je Stufe. */
  | { kind: 'fee_discount_bps'; perLevel: number }
  /** Verringert die Slippage um X Prozent je Stufe. */
  | { kind: 'slippage_reduction_pct'; perLevel: number }
  /** Schaltet zusaetzliche Bot-Plaetze frei. */
  | { kind: 'bot_slots'; perLevel: number }
  /** Beschleunigt das Bot-Training. */
  | { kind: 'bot_xp_pct'; perLevel: number }
  /** Schaltet Funktionen frei. */
  | { kind: 'unlock'; feature: string }
  /** Zinsen auf ungenutztes Bargeld, in Basispunkten pro Tag. */
  | { kind: 'cash_interest_bps'; perLevel: number }
  /** Rein kosmetisch. */
  | { kind: 'cosmetic'; item: string };

export const UPGRADES: readonly UpgradeDef[] = [
  {
    key: 'broker_tier',
    branch: 'broker',
    name: 'Broker-Tier',
    description: 'Retail -> Pro -> Prime. Jede Stufe senkt deine Gebuehren um 1 bp.',
    icon: '🏦',
    costs: [60, 180, 450],
    effect: { kind: 'fee_discount_bps', perLevel: 1 },
  },
  {
    key: 'execution_desk',
    branch: 'broker',
    name: 'Execution Desk',
    description: 'Bessere Orderausfuehrung: 10 % weniger Slippage je Stufe.',
    icon: '⚡',
    costs: [80, 240, 600],
    effect: { kind: 'slippage_reduction_pct', perLevel: 10 },
  },
  {
    key: 'research_indicators',
    branch: 'research',
    name: 'Research-Abteilung',
    description: 'Schaltet zusaetzliche Indikatoren und das Level-2-Orderbuch frei.',
    icon: '🔬',
    costs: [50, 150],
    effect: { kind: 'unlock', feature: 'advanced_indicators' },
  },
  {
    key: 'volatility_radar',
    branch: 'research',
    name: 'Volatilitaets-Radar',
    description: 'Warnt dich, bevor es wild wird.',
    icon: '📡',
    costs: [120],
    effect: { kind: 'unlock', feature: 'volatility_alerts' },
  },
  {
    key: 'bot_department',
    branch: 'bots',
    name: 'Bot-Abteilung',
    description: 'Ein zusaetzlicher Bot-Platz je Stufe.',
    icon: '🤖',
    costs: [150, 400, 900],
    effect: { kind: 'bot_slots', perLevel: 1 },
  },
  {
    key: 'bot_academy',
    branch: 'bots',
    name: 'Bot-Akademie',
    description: 'Deine Bots lernen 25 % schneller je Stufe.',
    icon: '🎓',
    costs: [100, 280],
    effect: { kind: 'bot_xp_pct', perLevel: 25 },
  },
  {
    key: 'launchpad_license',
    branch: 'launchpad',
    name: 'Launchpad-Lizenz',
    description: 'Erlaubt dir, eigene Coins zu starten.',
    icon: '🪙',
    costs: [70],
    effect: { kind: 'unlock', feature: 'create_coins' },
  },
  {
    key: 'lp_lock_tools',
    branch: 'launchpad',
    name: 'LP-Lock-Werkzeuge',
    description: 'Du kannst Liquiditaet sperren und bekommst ein Verified-Badge.',
    icon: '🔒',
    costs: [200],
    effect: { kind: 'unlock', feature: 'lp_lock' },
  },
  {
    key: 'treasury',
    branch: 'treasury',
    name: 'Treasury',
    description: 'Zinsen auf ungenutztes Bargeld: 1 bp pro Tag je Stufe.',
    icon: '💰',
    costs: [120, 350, 800],
    effect: { kind: 'cash_interest_bps', perLevel: 1 },
  },
  {
    key: 'terminal_themes',
    branch: 'office',
    name: 'Terminal-Themes',
    description: 'Alternative Farbwelten fuer dein Terminal.',
    icon: '🎨',
    costs: [30, 90, 200],
    effect: { kind: 'cosmetic', item: 'theme' },
  },
  {
    key: 'trophy_room',
    branch: 'office',
    name: 'Trophaeenschrank',
    description: 'Zeigt deine Achievements auf deinem Profil gross an.',
    icon: '🏆',
    costs: [60],
    effect: { kind: 'cosmetic', item: 'trophy_room' },
  },
];

export const UPGRADE_BY_KEY: ReadonlyMap<string, UpgradeDef> = new Map(
  UPGRADES.map((upgrade) => [upgrade.key, upgrade]),
);

export function upgradeCost(def: UpgradeDef, currentLevel: number): number | null {
  if (currentLevel >= def.costs.length) return null;
  return def.costs[currentLevel] ?? null;
}

export interface ResolvedEffects {
  feeDiscountBps: number;
  slippageReductionPct: number;
  botSlots: number;
  botXpPct: number;
  cashInterestBps: number;
  features: Set<string>;
  cosmetics: Set<string>;
}

/** Der erste Bot-Platz ist immer dabei, sobald man ihn sich erspielt hat. */
export const BASE_BOT_SLOTS = 1;

export function resolveEffects(levels: ReadonlyMap<string, number>): ResolvedEffects {
  const result: ResolvedEffects = {
    feeDiscountBps: 0,
    slippageReductionPct: 0,
    botSlots: BASE_BOT_SLOTS,
    botXpPct: 0,
    cashInterestBps: 0,
    features: new Set<string>(),
    cosmetics: new Set<string>(),
  };

  for (const [key, level] of levels) {
    if (level <= 0) continue;
    const def = UPGRADE_BY_KEY.get(key);
    if (!def) continue;

    const effect = def.effect;
    switch (effect.kind) {
      case 'fee_discount_bps':
        result.feeDiscountBps += effect.perLevel * level;
        break;
      case 'slippage_reduction_pct':
        result.slippageReductionPct += effect.perLevel * level;
        break;
      case 'bot_slots':
        result.botSlots += effect.perLevel * level;
        break;
      case 'bot_xp_pct':
        result.botXpPct += effect.perLevel * level;
        break;
      case 'cash_interest_bps':
        result.cashInterestBps += effect.perLevel * level;
        break;
      case 'unlock':
        result.features.add(effect.feature);
        break;
      case 'cosmetic':
        result.cosmetics.add(effect.item);
        break;
    }
  }

  return result;
}

/**
 * Upgrades auf die Liga-Regeln anwenden.
 * Wenn die Liga `upgradesAllowed = false` hat, passiert hier bewusst nichts.
 */
export function applyUpgradesToFees(
  fees: FeeConfig,
  effects: ResolvedEffects,
  upgradesAllowed: boolean,
): FeeConfig {
  if (!upgradesAllowed) return fees;

  return {
    takerBps: Math.max(0, fees.takerBps - effects.feeDiscountBps),
    makerBps: Math.max(0, fees.makerBps - effects.feeDiscountBps),
    fixedCents: fees.fixedCents,
  };
}

export interface RankDef {
  key: string;
  title: string;
  minPrestige: number;
  icon: string;
}

export const RANKS: readonly RankDef[] = [
  { key: 'intern', title: 'Praktikant', minPrestige: 0, icon: '📎' },
  { key: 'junior', title: 'Junior Trader', minPrestige: 120, icon: '📈' },
  { key: 'trader', title: 'Trader', minPrestige: 400, icon: '💼' },
  { key: 'senior', title: 'Senior Trader', minPrestige: 1_200, icon: '🥃' },
  { key: 'pm', title: 'Portfolio Manager', minPrestige: 3_000, icon: '🎩' },
  { key: 'whale', title: 'Wal', minPrestige: 8_000, icon: '🐋' },
  { key: 'legend', title: 'Legende', minPrestige: 20_000, icon: '👑' },
];

export function rankFor(prestige: number): RankDef {
  let current = RANKS[0]!;
  for (const rank of RANKS) {
    if (prestige >= rank.minPrestige) current = rank;
  }
  return current;
}

export function nextRank(prestige: number): RankDef | null {
  for (const rank of RANKS) {
    if (prestige < rank.minPrestige) return rank;
  }
  return null;
}
