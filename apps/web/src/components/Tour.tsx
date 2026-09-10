import { useEffect, useLayoutEffect, useState } from 'react';

import { Icon, type IconName } from './Icon.js';

/**
 * Gefuehrter Rundgang durch das Terminal.
 *
 * Alles wird abgedunkelt ausser dem Element, um das es gerade geht. Das ist
 * der Unterschied zu einer Folge von Textkarten: Man liest nicht ueber eine
 * Oberflaeche, man schaut sie an - und weiss danach, wo der Knopf ist.
 *
 * Technisch ein Loch im Dunkeln: ein Rahmen um das Ziel mit einem riesigen
 * Schlagschatten nach aussen. Braucht kein Fremdpaket und funktioniert mit
 * jedem Element, das ein `data-tour`-Attribut traegt.
 */

interface Step {
  target: string;
  icon: IconName;
  title: string;
  body: string;
  /** Wo die Sprechblase sitzt, wenn Platz ist. */
  place?: 'right' | 'left' | 'top' | 'bottom';
}

const STEPS: Step[] = [
  {
    target: 'markets',
    icon: 'list',
    title: 'Die Werte',
    body: 'Acht Unternehmen, jedes mit eigenem Charakter. Der ruhige Anker bewegt sich kaum, Voltmark springt in Minuten zweistellig. Ein Klick waehlt aus.',
    place: 'right',
  },
  {
    target: 'chart',
    icon: 'candles',
    title: 'Der Kurs',
    body: 'Gruen heisst gestiegen, rot gefallen. Wichtig: Diese Kurse sind fuer alle gleich - und deine eigenen Kaeufe bewegen sie mit.',
    place: 'bottom',
  },
  {
    target: 'amount',
    icon: 'wallet',
    title: 'Dein Einsatz',
    body: 'Wie viel Geld du hineinsteckst. Die Knoepfe darunter sind Abkuerzungen - 500 $ ist ein guter Anfang.',
    place: 'left',
  },
  {
    target: 'buy',
    icon: 'arrow-up',
    title: 'Kaufen',
    body: 'Mehr braucht es nicht. Der erste Trade steht danach immer leicht im Minus - das ist die Spanne zwischen Kauf- und Verkaufskurs, kein Fehler.',
    place: 'left',
  },
  {
    target: 'positions',
    icon: 'wallet',
    title: 'Was dir gehoert',
    body: 'Hier laeuft mit, wie deine Position steht. Ueber "schliessen" verkaufst du sie wieder.',
    place: 'top',
  },
  {
    target: 'side',
    icon: 'trophy',
    title: 'Die anderen',
    body: 'Rangliste, Feed und Chat. Unter "Coins" kannst du ein eigenes Papier auf den Markt bringen - und deine Freunde entscheiden, ob sie dir trauen.',
    place: 'left',
  },
  {
    // Nur auf dem Handy sichtbar - auf dem Rechner faellt der Schritt weg.
    target: 'tabs',
    icon: 'list',
    title: 'Die vier Bereiche',
    body: 'Chart zeigt den Kurs, Handeln ist dein Orderfenster, Depot deine Positionen, Liga die Rangliste und den Chat.',
    place: 'top',
  },
  {
    target: 'desk',
    icon: 'sliders',
    title: 'Dein Fortschritt',
    body: 'Jeder Trade bringt Prestige. Davon kaufst du Upgrades: guenstigere Gebuehren, mehr Bot-Plaetze, eigene Coins. Die Zahl waechst beim Spielen mit.',
    place: 'bottom',
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function Tour({ onClose }: { onClose: () => void }): JSX.Element | null {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  // Auf dem Handy ist immer nur ein Bereich sichtbar. Schritte auf Ziele, die
  // dort nichts anzeigen, werden weggelassen - eine Fuehrung, die ins Leere
  // zeigt, ist schlimmer als keine.
  //
  // Gewartet wird, bis ueberhaupt etwas da ist: Beim ersten Aufbau steht das
  // Terminal noch auf Ladezustand, und ein zu frueher Blick faende gar nichts.
  const [steps, setSteps] = useState<Step[] | null>(null);

  useEffect(() => {
    if (steps) return;

    const look = (): Step[] | null => {
      const present = STEPS.filter((entry) => visibleTarget(entry.target));
      return present.length > 0 ? present : null;
    };

    const found = look();
    if (found) {
      setSteps(found);
      return;
    }

    let tries = 0;
    const handle = window.setInterval(() => {
      tries += 1;
      const later = look();
      if (later) {
        setSteps(later);
        window.clearInterval(handle);
      } else if (tries > 20) {
        window.clearInterval(handle);
        onClose();
      }
    }, 300);

    return () => window.clearInterval(handle);
  }, [steps, onClose]);

  const step = steps?.[index];
  const total = steps?.length ?? 0;

  // Position des Ziels bestimmen - und bei jeder Aenderung neu, damit der
  // Ausschnitt nicht verrutscht.
  useLayoutEffect(() => {
    if (!step) return;

    const measure = (): void => setRect(visibleTarget(step.target));

    measure();
    const handle = window.setInterval(measure, 500);
    window.addEventListener('resize', measure);

    return () => {
      window.clearInterval(handle);
      window.removeEventListener('resize', measure);
    };
  }, [step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setIndex((current) => (current + 1 >= total ? (onClose(), current) : current + 1));
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, total]);

  if (!step) return null;

  const padding = 6;
  const hole = rect
    ? {
        top: rect.top - padding,
        left: rect.left - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
      }
    : null;

  const bubble = hole ? placeBubble(hole, step.place ?? 'right') : { top: '50%', left: '50%' };
  const last = index === total - 1;

  return (
    <div className="fixed inset-0 z-[9997]">
      {/* Das Loch im Dunkeln. Ohne Ziel wird einfach alles abgedunkelt.
          Bewusst ohne Uebergang: Ein animierter Schlagschatten dieser Groesse
          laesst den ganzen Bildschirm neu zeichnen und ruckelt sichtbar. */}
      {hole ? (
        <div
          className="pointer-events-none absolute rounded-[8px]"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            boxShadow: '0 0 0 9999px rgba(4, 6, 10, 0.86)',
            border: '2px solid var(--color-accent)',
          }}
        />
      ) : (
        <div className="absolute inset-0" style={{ background: 'rgba(4, 6, 10, 0.86)' }} />
      )}

      {/* Klickfaenger, damit waehrend der Fuehrung nichts ausgeloest wird. */}
      <div className="absolute inset-0" onClick={() => (index + 1 >= total ? onClose() : setIndex(index + 1))} />

      <div
        className="panel enter absolute w-[min(90vw,20rem)] p-4 shadow-2xl"
        style={{ ...bubble, borderColor: 'var(--color-border)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="accent">
            <Icon name={step.icon} size={16} />
          </span>
          <span className="text-[15px] font-semibold">{step.title}</span>
        </div>

        <p className="dim text-[13.5px] leading-relaxed">{step.body}</p>

        <div className="mt-4 flex items-center justify-between">
          <button className="dimmer text-[12px] hover:text-[var(--color-fg-2)]" onClick={onClose}>
            ueberspringen
          </button>

          <div className="flex items-center gap-2">
            <span className="dimmer num text-[11px]">
              {index + 1}/{total}
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => (last ? onClose() : setIndex(index + 1))}
            >
              {last ? 'Los geht’s' : 'Weiter'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Sucht ein Ziel und gibt seine Flaeche zurueck - aber nur, wenn es wirklich
 * zu sehen ist.
 *
 * Der Handy- und der Rechner-Aufbau stehen beide im Dokument, der jeweils
 * andere nur per CSS ausgeblendet. `querySelector` findet also auch, was
 * niemand sieht; nach der Groesse gefragt kommt dann ein Punkt in der Ecke
 * heraus - und der Rundgang leuchtet ins Nichts.
 */
function visibleTarget(target: string): Rect | null {
  for (const element of document.querySelectorAll(`[data-tour="${target}"]`)) {
    const box = element.getBoundingClientRect();
    if (box.width > 8 && box.height > 8) {
      return { top: box.top, left: box.left, width: box.width, height: box.height };
    }
  }

  return null;
}

/** Sprechblase neben das Loch legen - und dabei am Bildschirm bleiben. */
function placeBubble(hole: Rect, place: string): { top: number; left: number } {
  const width = Math.min(window.innerWidth * 0.9, 320);
  const height = 190;
  const gap = 14;

  let top = hole.top;
  let left = hole.left + hole.width + gap;

  if (place === 'left') left = hole.left - width - gap;
  if (place === 'top') {
    top = hole.top - height - gap;
    left = hole.left;
  }
  if (place === 'bottom') {
    top = hole.top + hole.height + gap;
    left = hole.left;
  }

  return {
    top: Math.max(12, Math.min(top, window.innerHeight - height - 12)),
    left: Math.max(12, Math.min(left, window.innerWidth - width - 12)),
  };
}
