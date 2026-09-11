import { useEffect, useState } from 'react';

import { phaseAt, type PhaseInfo } from '@tradearena/core';

/**
 * Die Uhr der Runde.
 *
 * Vorher stand im Kopf nur "noch 6 T 23 Std." - eine Zahl, die niemanden
 * angeht. Bei einer Runde, die an einem Abend durch ist, bedeutet die Zeit
 * dagegen etwas: Sie sagt, wie viel noch geht, und in den letzten Minuten
 * faerbt sie sich rot.
 *
 * Der Balken zeigt den Fortschritt, darunter steht die Phase. Bei langen
 * Ligen faellt beides weg - dort gibt es keinen Takt (siehe `rounds.ts`).
 */
export function Rundenuhr({
  startsAt,
  endsAt,
}: {
  startsAt: number;
  endsAt: number | null;
}): JSX.Element | null {
  const [jetzt, setJetzt] = useState(() => Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => setJetzt(Date.now()), 1_000);
    return () => window.clearInterval(handle);
  }, []);

  const phase: PhaseInfo | null = phaseAt(startsAt, endsAt, jetzt);
  if (!phase || endsAt === null) return null;

  const rest = Math.max(0, endsAt - jetzt);
  const anteil = Math.max(0, Math.min(1, (jetzt - startsAt) / (endsAt - startsAt)));

  const minuten = Math.floor(rest / 60_000);
  const sekunden = Math.floor((rest % 60_000) / 1000);

  // Unter zwei Minuten wird es rot und sekundengenau - vorher reicht die
  // Minute, sonst flackert die Zahl die ganze Runde vor sich hin.
  const knapp = rest < 2 * 60_000;
  const farbe = knapp
    ? 'var(--color-down)'
    : phase.key === 'endspurt'
      ? '#f0a23a'
      : 'var(--color-fg-2)';

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-baseline gap-2">
        <span
          className="text-[10.5px] uppercase tracking-[0.18em]"
          style={{ color: farbe }}
          title={phase.blurb}
        >
          {phase.label}
        </span>
        <span className={`num text-[15px] font-semibold ${knapp ? 'pulse' : ''}`} style={{ color: farbe }}>
          {knapp
            ? `${minuten}:${String(sekunden).padStart(2, '0')}`
            : `${minuten + 1} Min.`}
        </span>
      </div>

      <span className="h-[3px] w-28 overflow-hidden rounded-full bg-[var(--color-hairline)]">
        <i
          className="block h-full transition-all duration-1000"
          style={{ width: `${anteil * 100}%`, background: farbe }}
        />
      </span>
    </div>
  );
}
