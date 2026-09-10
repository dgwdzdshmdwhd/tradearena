import { useEffect, useState } from 'react';

import type { LeaderboardEntry, LeagueDetail, Portfolio } from '../lib/api.js';
import { Icon, type IconName } from './Icon.js';

/**
 * Die Zeile, die sagt, was als Naechstes zu tun ist.
 *
 * Ein Handelsterminal ist fuer jemanden, der so etwas noch nie gesehen hat,
 * eine Wand aus Zahlen. Diese Leiste beantwortet die einzige Frage, die man
 * am Anfang wirklich hat: "Und jetzt?"
 *
 * Sie verschwindet von selbst, sobald der Schritt getan ist - und laesst sich
 * wegklicken, wenn man sie nicht mehr braucht.
 */

interface Step {
  key: string;
  icon: IconName;
  text: string;
  action?: { label: string; run: () => void };
}

export function NextStep({
  portfolio,
  league,
  bots,
  meUserId,
  prestige,
  onOpenPanel,
}: {
  portfolio: Portfolio | null;
  league: LeagueDetail;
  bots: LeaderboardEntry[];
  meUserId: string;
  prestige: number;
  onOpenPanel: (panel: 'bots' | 'coins') => void;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ta_steps_done') ?? '[]') as string[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('ta_steps_done', JSON.stringify(dismissed));
    } catch {
      // Ohne Speicher kommt der Hinweis eben wieder. Kein Beinbruch.
    }
  }, [dismissed]);

  if (!portfolio || league.status !== 'running') return null;

  const positions = portfolio.positions.length;
  const orders = portfolio.orders.length;
  const trades = portfolio.account.trades;
  const myBots = bots.filter((bot) => bot.userId === meUserId).length;

  const steps: Step[] = [];

  if (positions === 0 && orders === 0) {
    steps.push({
      key: 'first-trade',
      icon: 'arrow-up',
      text:
        trades === 0
          ? 'Such dir links einen Markt aus und druecke rechts auf Kaufen. Der Betrag steht schon drin.'
          : 'Dein Depot ist leer. Links einen Markt waehlen, rechts kaufen.',
    });
  } else if (positions > 0) {
    steps.push({
      key: 'has-position',
      icon: 'wallet',
      text: 'Du bist drin. Unten bei den Positionen siehst du laufend, wie es steht - "schliessen" verkauft wieder.',
    });
  }

  if (trades >= 5 && myBots === 0 && league.botsAllowed) {
    steps.push({
      key: 'bot-ready',
      icon: 'cpu',
      text: 'Du hast genug Trades: dein erster Bot ist frei. Er handelt selbststaendig - und macht Fehler.',
      action: { label: 'Bot einstellen', run: () => onOpenPanel('bots') },
    });
  }

  if (prestige >= 30 && trades >= 3) {
    steps.push({
      key: 'first-upgrade',
      icon: 'sliders',
      text: `Du hast ${prestige} Prestige. Oben rechts im Trading-Desk kannst du davon Upgrades kaufen.`,
    });
  }

  if (league.coinsAllowed && trades >= 10) {
    steps.push({
      key: 'coins',
      icon: 'coin',
      text: 'Du kannst einen eigenen Coin starten - und deine Freunde entscheiden, ob sie dir trauen.',
      action: { label: 'Launchpad', run: () => onOpenPanel('coins') },
    });
  }

  const step = steps.find((entry) => !dismissed.includes(entry.key));
  if (!step) return null;

  return (
    <div
      className="flex items-center gap-2.5 border-b px-3 py-2 text-[12.5px]"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-accent) 25%, var(--color-hairline))',
        background: 'color-mix(in srgb, var(--color-accent) 7%, transparent)',
      }}
    >
      <span className="accent shrink-0">
        <Icon name={step.icon} size={15} />
      </span>

      <span className="min-w-0 flex-1">{step.text}</span>

      {step.action ? (
        <button className="btn btn-sm shrink-0" onClick={step.action.run}>
          {step.action.label}
        </button>
      ) : null}

      <button
        className="dimmer shrink-0 hover:text-[var(--color-fg)]"
        onClick={() => setDismissed((current) => [...current, step.key])}
        title="Hinweis ausblenden"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
