import { useEffect, useRef, useState } from 'react';

import { useLiveEvent } from '../lib/live.js';
import { sounds } from '../lib/sound.js';
import { Icon, type IconName } from './Icon.js';

/**
 * Vollbild-Meldungen.
 *
 * Manche Ereignisse gehen alle an und muessen sofort ankommen - nicht als
 * Zeile in einem Feed, den gerade niemand liest. Drei Faelle:
 *
 *   Coin-Start: jemand bringt etwas Neues an den Markt.
 *   Abzug angekuendigt: zehn Sekunden Countdown, in denen jeder raus kann.
 *     Das ist die wichtigste Meldung im ganzen Spiel - wer sie verpasst,
 *     verliert Geld.
 *   Marktereignis: ein Wert bewegt sich gleich stark.
 *
 * Bewusst gross, bewusst kurz, bewusst mit Ton. Wer will, klickt weg.
 */

interface Announcement {
  id: number;
  kind: 'coin' | 'pull' | 'event';
  icon: IconName;
  eyebrow: string;
  title: string;
  detail: string;
  color: string;
  /** Nur beim Abzug: Zeitpunkt, an dem es passiert. */
  until?: number;
}

let counter = 0;

export function Announce(): JSX.Element | null {
  const [current, setCurrent] = useState<Announcement | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [shrunk, setShrunk] = useState(false);
  const timer = useRef<number | null>(null);

  const show = (announcement: Omit<Announcement, 'id'>, ttlMs: number): void => {
    setCurrent({ ...announcement, id: (counter += 1) });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCurrent(null), ttlMs);
  };

  useLiveEvent((event, payload) => {
    const data = (payload ?? {}) as Record<string, string | number | boolean | null>;

    if (event === 'coin_launch') {
      sounds.achievement();
      show(
        {
          kind: 'coin',
          icon: 'coin',
          eyebrow: 'Neuer Coin',
          title: String(data.ticker ?? ''),
          detail: `${String(data.by ?? 'Jemand')} hat ${String(data.name ?? '')} gestartet · ${
            data.locked ? 'Liquiditaet gesperrt' : 'Liquiditaet NICHT gesperrt'
          }`,
          color: String(data.color ?? '#d4a24c'),
        },
        5_000,
      );
    }

    if (event === 'pull_warning') {
      sounds.rug();
      const until = Number(data.pullAt ?? Date.now() + 10_000);
      show(
        {
          kind: 'pull',
          icon: 'scissors',
          eyebrow: 'Liquiditaet wird abgezogen',
          title: String(data.ticker ?? ''),
          detail: `${String(data.by ?? 'Jemand')} zieht ${String(data.pct ?? 100)} % ab. Wer noch drin ist, sollte jetzt verkaufen.`,
          color: '#f0555b',
          until,
        },
        Math.max(2_000, until - Date.now() + 1_500),
      );
    }

    if (event === 'meme_launch') {
      sounds.achievement();
      show(
        {
          kind: 'coin',
          icon: 'zap',
          eyebrow: 'Neu am Markt',
          title: String(data.ticker ?? data.symbol ?? ''),
          detail: String(data.blurb ?? ''),
          color: String(data.color ?? '#d4a24c'),
        },
        5_000,
      );
    }

    if (event === 'round_phase') {
      // Der Phasenwechsel ist die Ansage, dass jetzt etwas anders ist -
      // dafuer lohnt sich der ganze Bildschirm.
      sounds.achievement();
      show(
        {
          kind: 'event',
          icon: 'clock',
          eyebrow: 'Neue Phase',
          title: String(data.label ?? ''),
          detail: String(data.blurb ?? ''),
          color: data.key === 'finale' ? '#f0555b' : data.key === 'endspurt' ? '#f0a23a' : '#d4a24c',
        },
        4_500,
      );
    }

    if (event === 'market_event') {
      show(
        {
          kind: 'event',
          icon: data.up ? 'trend-up' : 'trend-down',
          eyebrow: 'Marktnachricht',
          title: String(data.symbol ?? ''),
          detail: String(data.headline ?? ''),
          color: data.up ? '#31c48d' : '#f0555b',
        },
        4_000,
      );
    }
  });

  // Der Countdown laeuft nur, solange eine Abzugs-Meldung steht.
  useEffect(() => {
    if (!current?.until) return;

    const tick = (): void => setRemaining(Math.max(0, Math.ceil((current.until! - Date.now()) / 1000)));
    tick();

    const handle = window.setInterval(tick, 200);
    return () => window.clearInterval(handle);
  }, [current]);

  // Die Vollbild-Meldung zieht sich nach kurzer Zeit in die Ecke zurueck.
  // Beim Abzug ist das wichtig: Genau in diesen Sekunden will man verkaufen,
  // und eine Wand vor dem Orderfenster kostet dann bares Geld.
  useEffect(() => {
    setShrunk(false);
    if (!current) return;

    const handle = window.setTimeout(() => setShrunk(true), 3_000);
    return () => window.clearTimeout(handle);
  }, [current]);

  if (!current) return null;

  if (shrunk && current.until) {
    return (
      <button
        onClick={() => setCurrent(null)}
        className="panel enter fixed right-3 top-3 z-[9995] flex items-center gap-3 px-3 py-2 shadow-2xl"
        style={{ borderColor: current.color }}
      >
        <span style={{ color: current.color }}>
          <Icon name={current.icon} size={18} strokeWidth={1.4} />
        </span>

        <span className="text-left">
          <span className="block text-[12.5px] font-semibold">{current.title} wird abgezogen</span>
          <span className="dimmer block text-[11.5px]">noch Zeit zu verkaufen</span>
        </span>

        <span className="num text-[26px] font-bold leading-none" style={{ color: current.color }}>
          {remaining}
        </span>
      </button>
    );
  }

  return (
    <button
      onClick={() => setCurrent(null)}
      className="fixed inset-0 z-[9995] flex flex-col items-center justify-center"
      style={{
        background: `radial-gradient(circle at center, ${current.color}22, rgba(0,0,0,0.88))`,
        backdropFilter: 'blur(3px)',
      }}
    >
      <div className="enter flex flex-col items-center px-6 text-center">
        <span style={{ color: current.color }}>
          <Icon name={current.icon} size={44} strokeWidth={1.2} />
        </span>

        <div
          className="mt-4 text-[12px] font-semibold uppercase tracking-[0.25em]"
          style={{ color: current.color }}
        >
          {current.eyebrow}
        </div>

        <div className="num mt-2 text-[46px] font-bold leading-none tracking-tight">
          {current.title}
        </div>

        <div className="dim mt-3 max-w-[32rem] text-[15px] leading-relaxed">{current.detail}</div>

        {current.until ? (
          <div className="mt-6">
            <div
              className="num text-[64px] font-bold leading-none"
              style={{ color: current.color }}
            >
              {remaining}
            </div>
            <div className="dimmer mt-1 text-[12px] uppercase tracking-[0.2em]">Sekunden</div>
          </div>
        ) : null}

        <div className="dimmer mt-8 text-[11px]">klicken zum Ausblenden</div>
      </div>
    </button>
  );
}
