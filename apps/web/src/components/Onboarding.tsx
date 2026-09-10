import { useState, type ReactNode } from 'react';

import { Icon, type IconName } from './Icon.js';

/**
 * Kurzes Tutorial beim ersten Betreten eines Terminals.
 *
 * Erklaert die Ordertypen an genau dem Punkt, an dem man sie sonst erst
 * versteht, wenn sie Geld gekostet haben.
 */

const STEPS: Array<{ icon: IconName; title: string; body: ReactNode }> = [
  {
    icon: 'candles',
    title: 'Das Terminal',
    body: (
      <>
        Links die Maerkte, in der Mitte der Chart, rechts das Orderticket. Alle Kurse sind echt und
        kommen live von der Boerse. Dein Geld ist es nicht — deshalb darfst du hier alles
        ausprobieren.
      </>
    ),
  },
  {
    icon: 'arrow-up',
    title: 'Market: sofort, aber nicht zum Wunschpreis',
    body: (
      <>
        Eine Market-Order wird sofort ausgefuehrt: Kaufen zum <b>Ask</b>, Verkaufen zum <b>Bid</b> —
        nie zum Kurs in der Mitte. Der Abstand heisst Spread. Deshalb siehst du direkt nach dem Kauf
        ein kleines Minus. Das ist kein Fehler, das ist echt.
      </>
    ),
  },
  {
    icon: 'target',
    title: 'Limit: dein Preis oder gar nicht',
    body: (
      <>
        Mit einer Limit-Order sagst du: „Ich kaufe, aber hoechstens zu 60.000." Faellt der Kurs
        dorthin, wird ausgefuehrt — sonst bleibt die Order liegen. Guenstiger in den Gebuehren,
        dafuer ohne Garantie, dass sie ueberhaupt zum Zug kommt.
      </>
    ),
  },
  {
    icon: 'alert',
    title: 'Stop: die Notbremse, die rutschen kann',
    body: (
      <>
        Ein Stop-Loss loest aus, wenn der Kurs deine Schwelle beruehrt, und wird dann zur
        Market-Order. <b>Wichtig:</b> Bei einem Sturz bekommst du nicht deinen Stop-Preis, sondern
        den Kurs, der gerade da ist. Genau diese Luecke kostet in echt Geld.
      </>
    ),
  },
  {
    icon: 'coin',
    title: 'Coins und Liquiditaet',
    body: (
      <>
        Jeder kann eigene Coins starten. Der Kurs entsteht aus einem Liquiditaetspool — wer kauft,
        treibt ihn selbst nach oben. Der Ersteller kann die Liquiditaet aber auch wieder abziehen,
        dann ist der Coin wertlos. Bei jedem Coin steht vorher, wie hoch dieses Risiko ist. Schau da
        hin.
      </>
    ),
  },
  {
    icon: 'zap',
    title: 'Schnell handeln',
    body: (
      <>
        <b>B</b> stellt das Ticket auf Kaufen, <b>S</b> auf Verkaufen, <b>Enter</b> schickt ab. Viel
        Erfolg — und denk dran: jeder Trade kostet Gebuehren, auch der aus Langeweile.
      </>
    ),
  },
];

export function Onboarding({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState(0);
  const current = STEPS[step]!;
  const last = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-[2px]">
      <div className="panel enter w-full max-w-[24rem] shadow-2xl">
        <div className="p-6">
          <span className="accent mb-4 inline-block">
            <Icon name={current.icon} size={20} strokeWidth={1.4} />
          </span>
          <h2 className="mb-2 text-[17px] font-medium">{current.title}</h2>
          <p className="dim text-[14px] leading-relaxed">{current.body}</p>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-hairline)] p-3">
          <button className="dimmer text-[12.5px] hover:text-[var(--color-fg-2)]" onClick={onClose}>
            ueberspringen
          </button>

          <div className="flex gap-1">
            {STEPS.map((_, index) => (
              <span
                key={index}
                className="h-1 rounded-full transition-all"
                style={{
                  width: index === step ? 14 : 5,
                  background:
                    index === step ? 'var(--color-accent)' : 'var(--color-border)',
                }}
              />
            ))}
          </div>

          <button
            className="btn btn-primary btn-sm"
            onClick={() => (last ? onClose() : setStep(step + 1))}
          >
            {last ? 'Los' : 'Weiter'}
          </button>
        </div>
      </div>
    </div>
  );
}
