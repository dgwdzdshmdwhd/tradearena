/**
 * Achievements - der Grund, warum man am naechsten Abend nochmal spielt.
 *
 * Alle Regeln werden serverseitig ausgewertet. Der Client bekommt nur das
 * Ergebnis. Sonst haette sich der erste Freund in fuenf Minuten alle
 * Trophaeen freigeschaltet.
 */

import { abs, type Cents } from './money.js';
import type { OrderType } from './types.js';

export type AchievementTier = 'bronze' | 'silber' | 'gold' | 'schande';

export interface AchievementDef {
  key: string;
  name: string;
  description: string;
  icon: string;
  tier: AchievementTier;
  /** Prestige-Punkte fuer die Tycoon-Ebene. */
  prestige: number;
  /** Versteckte Achievements werden erst nach dem Freischalten verraten. */
  hidden?: boolean;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  {
    key: 'first_blood',
    name: 'Erster Trade',
    description: 'Deine erste Order wurde ausgefuehrt.',
    icon: '🎯',
    tier: 'bronze',
    prestige: 10,
  },
  {
    key: 'diamond_hands',
    name: 'Diamond Hands',
    description: 'Eine Position trotz -20 % gehalten und im Plus geschlossen.',
    icon: '💎',
    tier: 'gold',
    prestige: 100,
  },
  {
    key: 'paper_hands',
    name: 'Paper Hands',
    description: 'Eine Position nach weniger als 60 Sekunden mit Verlust geschlossen.',
    icon: '🧻',
    tier: 'bronze',
    prestige: 5,
  },
  {
    key: 'sniper',
    name: 'Sniper',
    description: 'Eine Limit-Order exakt am Tagestief gefuellt bekommen.',
    icon: '🎯',
    tier: 'gold',
    prestige: 120,
  },
  {
    key: 'liquidated',
    name: 'Liquidiert',
    description: 'Zwangsliquidation. Das Abzeichen bleibt.',
    icon: '💀',
    tier: 'schande',
    prestige: 0,
  },
  {
    key: 'ten_bagger',
    name: 'Ten Bagger',
    description: 'Einen Trade mit ueber 1000 % Gewinn geschlossen.',
    icon: '🚀',
    tier: 'gold',
    prestige: 200,
  },
  {
    key: 'round_trip',
    name: 'Round Trip',
    description: 'Von +50 % zurueck auf null. Autsch.',
    icon: '🎢',
    tier: 'schande',
    prestige: 0,
  },
  {
    key: 'whale',
    name: 'Wal',
    description: 'Eine einzelne Order ueber 50 % deines Kapitals ausgefuehrt.',
    icon: '🐋',
    tier: 'silber',
    prestige: 50,
  },
  {
    key: 'short_seller',
    name: 'Leerverkaeufer',
    description: 'Mit einer Short-Position Geld verdient.',
    icon: '🐻',
    tier: 'silber',
    prestige: 40,
  },
  {
    key: 'rugger',
    name: 'Rugger',
    description: 'Einen eigenen Coin gerugged. Alle wissen es. Fuer immer.',
    icon: '🔪',
    tier: 'schande',
    prestige: 0,
  },
  {
    key: 'bagholder',
    name: 'Bagholder',
    description: 'Einen Coin gehalten, als der Ersteller die Liquiditaet abzog.',
    icon: '🎒',
    tier: 'schande',
    prestige: 0,
  },
  {
    key: 'exit_liquidity',
    name: 'Rechtzeitig raus',
    description: 'Einen Coin mit Gewinn verkauft, der spaeter gerugged wurde.',
    icon: '🏃',
    tier: 'gold',
    prestige: 150,
  },
  {
    key: 'coin_creator',
    name: 'Muenzpraeger',
    description: 'Einen eigenen Coin gestartet.',
    icon: '🪙',
    tier: 'bronze',
    prestige: 25,
  },
  {
    key: 'bot_owner',
    name: 'Chef',
    description: 'Deinen ersten Bot eingestellt.',
    icon: '🤖',
    tier: 'bronze',
    prestige: 20,
  },
  {
    key: 'bot_beats_you',
    name: 'Ersetzt',
    description: 'Dein Bot hat eine bessere Rendite als du. Peinlich.',
    icon: '🪦',
    tier: 'schande',
    prestige: 10,
  },
  {
    key: 'comeback',
    name: 'Comeback',
    description: 'Von -30 % zurueck ins Plus.',
    icon: '📈',
    tier: 'gold',
    prestige: 150,
  },
  {
    key: 'league_winner',
    name: 'Ligasieger',
    description: 'Eine Liga auf Platz 1 beendet.',
    icon: '🏆',
    tier: 'gold',
    prestige: 250,
  },
  {
    key: 'survivor',
    name: 'Ueberlebender',
    description: 'Eine Survival-Runde als Letzter ueberstanden.',
    icon: '🛡️',
    tier: 'gold',
    prestige: 200,
  },
  {
    key: 'iron_hand',
    name: 'Eiserne Hand',
    description: 'Eine Position laenger als 24 Stunden gehalten.',
    icon: '🪨',
    tier: 'silber',
    prestige: 40,
  },
  {
    key: 'overtrader',
    name: 'Zockerherz',
    description: '50 Trades an einem Tag. Die Gebuehren freuen sich.',
    icon: '🎰',
    tier: 'schande',
    prestige: 15,
  },
];

export const ACHIEVEMENT_BY_KEY: ReadonlyMap<string, AchievementDef> = new Map(
  ACHIEVEMENTS.map((achievement) => [achievement.key, achievement]),
);

/** Was beim Schliessen eines Trades bekannt ist. */
export interface TradeOutcome {
  realizedPnlCents: Cents;
  costBasisCents: Cents;
  holdMs: number;
  /** Tiefster Buchverlust waehrend der Haltedauer, in Basispunkten. */
  worstDrawdownBps: number;
  /** Hoechster Buchgewinn waehrend der Haltedauer, in Basispunkten. */
  bestGainBps: number;
  wasShort: boolean;
  orderType: OrderType;
  /** Wurde die Order exakt am Tagestief gefuellt? */
  filledAtSessionLow: boolean;
  /** Anteil des Kontos, den diese Order gebunden hat, in Basispunkten. */
  accountShareBps: number;
  tradesToday: number;
  isFirstTrade: boolean;
}

/** Welche Achievements loest dieser abgeschlossene Trade aus? */
export function evaluateTrade(outcome: TradeOutcome): string[] {
  const unlocked: string[] = [];
  const profitable = outcome.realizedPnlCents > 0n;

  if (outcome.isFirstTrade) unlocked.push('first_blood');

  if (profitable && outcome.worstDrawdownBps <= -2_000) unlocked.push('diamond_hands');

  if (!profitable && outcome.holdMs < 60_000) unlocked.push('paper_hands');

  if (outcome.orderType === 'limit' && outcome.filledAtSessionLow) unlocked.push('sniper');

  if (
    outcome.costBasisCents > 0n &&
    outcome.realizedPnlCents >= outcome.costBasisCents * 10n
  ) {
    unlocked.push('ten_bagger');
  }

  if (outcome.bestGainBps >= 5_000 && abs(outcome.realizedPnlCents) * 20n < outcome.costBasisCents) {
    unlocked.push('round_trip');
  }

  if (outcome.accountShareBps >= 5_000) unlocked.push('whale');

  if (outcome.wasShort && profitable) unlocked.push('short_seller');

  if (outcome.holdMs >= 24 * 60 * 60_000) unlocked.push('iron_hand');

  if (outcome.tradesToday >= 50) unlocked.push('overtrader');

  return unlocked;
}

/** Achievements, die nicht an einem Trade haengen, sondern an Ereignissen. */
export type AchievementEvent =
  | { kind: 'liquidated' }
  | { kind: 'coin_created' }
  | { kind: 'rugged_someone' }
  | { kind: 'got_rugged' }
  | { kind: 'sold_before_rug'; profitable: boolean }
  | { kind: 'bot_created' }
  | { kind: 'bot_outperformed_owner' }
  | { kind: 'league_won' }
  | { kind: 'survived' }
  | { kind: 'comeback' };

export function evaluateEvent(event: AchievementEvent): string[] {
  switch (event.kind) {
    case 'liquidated':
      return ['liquidated'];
    case 'coin_created':
      return ['coin_creator'];
    case 'rugged_someone':
      return ['rugger'];
    case 'got_rugged':
      return ['bagholder'];
    case 'sold_before_rug':
      return event.profitable ? ['exit_liquidity'] : [];
    case 'bot_created':
      return ['bot_owner'];
    case 'bot_outperformed_owner':
      return ['bot_beats_you'];
    case 'league_won':
      return ['league_winner'];
    case 'survived':
      return ['survivor'];
    case 'comeback':
      return ['comeback'];
  }
}
