import { useEffect, useMemo, useState } from 'react';

import { api, quiet } from '../lib/api.js';
import { fmtBps, fmtUsd } from '../lib/format.js';
import { confetti, sounds } from '../lib/sound.js';
import { Icon, type IconName } from './Icon.js';

/**
 * Die Siegerehrung.
 *
 * Vorher hoerte eine Liga einfach auf: Kurs steht, Rangliste friert ein,
 * fertig. Ein Spiel wertet aber aus - und der Teil, den man hinterher in die
 * Gruppe schickt, sind nicht die Plaetze (die kennt man), sondern die
 * Auszeichnungen. "Vierzig Sekunden zu frueh raus" weiss nur der Server.
 *
 * Die Kurven liegen uebereinander, damit man sieht, wo es gekippt ist. Das
 * ist die Geschichte des Abends in einem Bild.
 */

interface Platz {
  userId: string;
  name: string;
  equityCents: string;
  startCents: string;
  returnBps: number;
  trades: number;
  feesCents: string;
  eliminatedAt: number | null;
}

interface Auszeichnung {
  key: string;
  title: string;
  name: string;
  detail: string;
}

interface Kurve {
  name: string;
  punkte: Array<[number, number]>;
}

interface Ergebnis {
  podium: Platz[];
  kurven: Kurve[];
  auszeichnungen: Auszeichnung[];
  status: string;
}

const ABZEICHEN: Record<string, IconName> = {
  bester_griff: 'trend-up',
  griff_ins_klo: 'trend-down',
  diamanthand: 'diamond',
  papierhand: 'page',
  vielflieger: 'zap',
  achterbahn: 'wave',
  comeback: 'run',
  eisern: 'shield',
  dabeigewesen: 'medal',
};

/** Farben fuer die Kurven - bewusst kraeftig und gut unterscheidbar. */
const FARBEN = [
  '#d4a24c',
  '#5b8def',
  '#31c48d',
  '#f0555b',
  '#a78bfa',
  '#3fb6d6',
  '#e8a33a',
  '#e0577f',
];

export function Abspann({
  leagueId,
  meName,
  onClose,
}: {
  leagueId: string;
  meName: string;
  onClose: () => void;
}): JSX.Element | null {
  const [daten, setDaten] = useState<Ergebnis | null>(null);

  useEffect(() => {
    quiet(
      (async () => {
        const ergebnis = await api.get<Ergebnis>(`/api/leagues/${leagueId}/results`);
        setDaten(ergebnis);

        // Wer gewonnen hat, darf es auch hoeren.
        if (ergebnis.podium[0]?.name === meName) {
          confetti();
          sounds.achievement();
        }
      })(),
    );
  }, [leagueId, meName]);

  if (!daten) return null;

  const sieger = daten.podium[0];

  return (
    <div className="fixed inset-0 z-[9994] overflow-y-auto bg-[var(--color-bg)]/97 p-4 backdrop-blur-sm">
      <div className="enter mx-auto flex w-full max-w-[52rem] flex-col gap-4 py-6">
        <div className="text-center">
          <div className="dimmer text-[11.5px] uppercase tracking-[0.28em]">Runde vorbei</div>
          <div className="num mt-1 text-[34px] font-bold leading-none tracking-tight">
            {sieger ? sieger.name : 'Niemand'} gewinnt
          </div>
          {sieger ? (
            <div className="dim mt-2 text-[14px]">
              {fmtUsd(sieger.equityCents)} am Ende ·{' '}
              <span className={sieger.returnBps >= 0 ? 'up' : 'down'}>
                {fmtBps(sieger.returnBps)}
              </span>
            </div>
          ) : null}
        </div>

        <Kurven kurven={daten.kurven} />

        <Podium podium={daten.podium} meName={meName} />

        {daten.auszeichnungen.length > 0 ? (
          <div className="panel">
            <div className="panel-head">
              <span>Auszeichnungen</span>
            </div>
            <div className="grid gap-px bg-[var(--color-hairline)] sm:grid-cols-2">
              {daten.auszeichnungen.map((eintrag) => (
                <div key={eintrag.key} className="bg-[var(--color-panel)] p-3">
                  <div className="flex items-center gap-2">
                    <span className="accent">
                      <Icon name={ABZEICHEN[eintrag.key] ?? 'medal'} size={14} />
                    </span>
                    <span className="text-[13.5px] font-semibold">{eintrag.title}</span>
                  </div>
                  <div className="mt-1.5 text-[13.5px]">
                    <b className="font-medium">{eintrag.name}</b>
                  </div>
                  <div className="dim mt-0.5 text-[12.5px] leading-snug">{eintrag.detail}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <button className="btn btn-primary w-full justify-center" onClick={onClose}>
          Schliessen
        </button>
      </div>
    </div>
  );
}

function Podium({ podium, meName }: { podium: Platz[]; meName: string }): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-head">
        <span>Endstand</span>
        <span className="num normal-case tracking-normal">{podium.length}</span>
      </div>

      <div>
        {podium.map((platz, index) => {
          const ich = platz.name === meName;

          return (
            <div
              key={platz.userId}
              className={`flex items-center gap-3 border-b border-[var(--color-hairline)] px-3 py-2 last:border-0 ${
                ich ? 'bg-[var(--color-raised)]' : ''
              }`}
            >
              <span
                className="num w-6 shrink-0 text-center text-[15px] font-bold"
                style={{ color: index < 3 ? FARBEN[index] : 'var(--color-fg-3)' }}
              >
                {index + 1}
              </span>

              <span
                className="h-5 w-[3px] shrink-0 rounded-full"
                style={{ background: FARBEN[index % FARBEN.length] }}
              />

              <span className="min-w-0 flex-1 truncate text-[14px]">
                {platz.name}
                {platz.eliminatedAt ? (
                  <span className="dimmer ml-1.5 text-[11.5px]">ausgeschieden</span>
                ) : null}
              </span>

              <span className="dimmer num shrink-0 text-[12px]">{platz.trades} Trades</span>

              <span className="num shrink-0 text-[14px]">{fmtUsd(platz.equityCents)}</span>

              <span
                className={`num w-[4.5rem] shrink-0 text-right text-[13px] ${
                  platz.returnBps >= 0 ? 'up' : 'down'
                }`}
              >
                {fmtBps(platz.returnBps)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Alle Kapitalverlaeufe uebereinander.
 *
 * Bewusst selbst gezeichnet statt mit der Chart-Bibliothek: Die kann genau
 * eine Reihe je Diagramm, hier sind es acht - und mehr als ein Pfad mit
 * Beschriftung braucht es nicht.
 */
function Kurven({ kurven }: { kurven: Kurve[] }): JSX.Element | null {
  const gezeichnet = useMemo(() => {
    const mitDaten = kurven.filter((kurve) => kurve.punkte.length > 1);
    if (mitDaten.length === 0) return null;

    const alle = mitDaten.flatMap((kurve) => kurve.punkte);
    const tMin = Math.min(...alle.map((punkt) => punkt[0]));
    const tMax = Math.max(...alle.map((punkt) => punkt[0]));
    const yMin = Math.min(...alle.map((punkt) => punkt[1]));
    const yMax = Math.max(...alle.map((punkt) => punkt[1]));

    const breite = 1000;
    const hoehe = 260;
    const rand = 8;
    const tSpanne = Math.max(1, tMax - tMin);
    const ySpanne = Math.max(1, yMax - yMin);

    return {
      breite,
      hoehe,
      yMin,
      yMax,
      pfade: mitDaten.map((kurve, index) => ({
        name: kurve.name,
        farbe: FARBEN[index % FARBEN.length]!,
        d: kurve.punkte
          .map((punkt, stelle) => {
            const x = rand + ((punkt[0] - tMin) / tSpanne) * (breite - rand * 2);
            const y = hoehe - rand - ((punkt[1] - yMin) / ySpanne) * (hoehe - rand * 2);
            return `${stelle === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(' '),
      })),
    };
  }, [kurven]);

  if (!gezeichnet) return null;

  return (
    <div className="panel p-3">
      <svg
        viewBox={`0 0 ${gezeichnet.breite} ${gezeichnet.hoehe}`}
        className="h-[190px] w-full"
        preserveAspectRatio="none"
      >
        {gezeichnet.pfade.map((pfad) => (
          <path
            key={pfad.name}
            d={pfad.d}
            fill="none"
            stroke={pfad.farbe}
            strokeWidth={2.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {gezeichnet.pfade.map((pfad) => (
          <span key={pfad.name} className="flex items-center gap-1.5 text-[12px]">
            <span className="h-[3px] w-4 rounded-full" style={{ background: pfad.farbe }} />
            {pfad.name}
          </span>
        ))}
        <span className="dimmer num ml-auto text-[11.5px]">
          {fmtUsd(String(Math.round(gezeichnet.yMin)))} bis{' '}
          {fmtUsd(String(Math.round(gezeichnet.yMax)))}
        </span>
      </div>
    </div>
  );
}
