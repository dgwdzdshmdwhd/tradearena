import { useEffect, useRef, useState } from 'react';

import { useLiveEvent } from '../lib/live.js';
import { sounds } from '../lib/sound.js';

/**
 * Bildschirmuebernahme durch den Spielleiter.
 *
 * Legt sich ueber alles, zeigt was der Gastgeber geschickt hat - Text, Bild,
 * Clip - und laesst sich nicht wegklicken, solange die Zeit laeuft. Das ist
 * der Punkt: Ein Fenster, das man sofort schliessen kann, ist kein Streich.
 *
 * Die Effekte fassen die ganze Seite an, nicht nur diese Ebene. Wer ein
 * Kopfstand-Fenster bekommt, soll auch sein Orderfenster auf dem Kopf sehen.
 */

interface Uebernahme {
  id: number;
  title: string;
  text: string;
  mediaUrl: string;
  effect: string;
  bis: number;
}

let zaehler = 0;

/** Welche Bildschirmklasse zu welchem Effekt gehoert. */
const EFFEKT_KLASSE: Record<string, string> = {
  beben: 'ta-beben',
  kopfstand: 'ta-kopfstand',
  stroboskop: 'ta-stroboskop',
};

function istVideo(url: string): boolean {
  return /\.(mp4|webm)(\?|$)/i.test(url);
}

function istAudio(url: string): boolean {
  return /\.(mp3|ogg)(\?|$)/i.test(url);
}

/** YouTube-Links in die einbettbare Form bringen. */
function youtube(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/,
  );
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1&rel=0` : null;
}

export function Takeover({ meUserId }: { meUserId: string }): JSX.Element | null {
  const [current, setCurrent] = useState<Uebernahme | null>(null);
  const timer = useRef<number | null>(null);

  useLiveEvent((event, payload) => {
    if (event !== 'takeover') return;

    const data = (payload ?? {}) as Record<string, string | number | null>;
    const ziel = data.targetUserId ? String(data.targetUserId) : null;
    // Gilt es jemand anderem, bleibt der eigene Bildschirm in Ruhe.
    if (ziel && ziel !== meUserId) return;

    const ms = Math.max(2_000, Math.min(60_000, Number(data.ms ?? 6_000)));
    sounds.rug();

    setCurrent({
      id: (zaehler += 1),
      title: String(data.title ?? ''),
      text: String(data.text ?? ''),
      mediaUrl: String(data.mediaUrl ?? ''),
      effect: String(data.effect ?? 'keiner'),
      bis: Date.now() + ms,
    });

    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCurrent(null), ms);
  });

  // Effekte haengen an der ganzen Seite, nicht an dieser Ebene.
  useEffect(() => {
    const klasse = current ? EFFEKT_KLASSE[current.effect] : undefined;
    if (!klasse) return;

    document.body.classList.add(klasse);
    return () => document.body.classList.remove(klasse);
  }, [current]);

  if (!current) return null;

  const eingebettet = youtube(current.mediaUrl);

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/95 p-6">
      {current.effect === 'regen' ? <Regen /> : null}

      <div className="enter flex max-h-full w-full max-w-[46rem] flex-col items-center gap-4 text-center">
        {current.title ? (
          <div className="num text-[40px] font-bold leading-none tracking-tight">
            {current.title}
          </div>
        ) : null}

        {current.mediaUrl ? (
          <div className="flex min-h-0 w-full justify-center">
            {eingebettet ? (
              <iframe
                src={eingebettet}
                title="Einspieler"
                allow="autoplay; encrypted-media"
                className="aspect-video w-full rounded-[var(--radius)] border border-[var(--color-border)]"
              />
            ) : istVideo(current.mediaUrl) ? (
              <video
                src={current.mediaUrl}
                autoPlay
                playsInline
                loop
                className="max-h-[60vh] rounded-[var(--radius)]"
              />
            ) : istAudio(current.mediaUrl) ? (
              <audio src={current.mediaUrl} autoPlay />
            ) : (
              <img
                src={current.mediaUrl}
                alt=""
                className="max-h-[60vh] rounded-[var(--radius)] object-contain"
              />
            )}
          </div>
        ) : null}

        {current.text ? (
          <div className="max-w-[34rem] text-[17px] leading-relaxed">{current.text}</div>
        ) : null}

        <Rest bis={current.bis} />
      </div>
    </div>
  );
}

/** Zeigt, wie lange es noch dauert - damit niemand denkt, es haengt. */
function Rest({ bis }: { bis: number }): JSX.Element {
  const [sekunden, setSekunden] = useState(() => Math.ceil((bis - Date.now()) / 1000));

  useEffect(() => {
    const handle = window.setInterval(
      () => setSekunden(Math.max(0, Math.ceil((bis - Date.now()) / 1000))),
      250,
    );
    return () => window.clearInterval(handle);
  }, [bis]);

  return <div className="dimmer num text-[12px]">noch {sekunden} s</div>;
}

/** Geldregen. Reine Zierde, und die einzige, die hier angebracht ist. */
function Regen(): JSX.Element {
  const scheine = Array.from({ length: 28 }, (_, index) => index);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {scheine.map((index) => (
        <span
          key={index}
          className="ta-schein num absolute text-[22px]"
          style={{
            left: `${(index * 37) % 100}%`,
            animationDelay: `${(index % 10) * 0.28}s`,
            animationDuration: `${2.4 + ((index * 7) % 20) / 10}s`,
            color: index % 3 === 0 ? 'var(--color-up)' : 'var(--color-accent)',
          }}
        >
          $
        </span>
      ))}
    </div>
  );
}
