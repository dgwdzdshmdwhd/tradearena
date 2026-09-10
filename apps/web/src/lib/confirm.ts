import { useEffect, useState } from 'react';

import type { IconName } from '../components/Icon.js';

/**
 * Rueckfragen im Stil des Spiels statt `window.confirm`.
 *
 * Der Systemdialog des Browsers reisst einen aus dem Terminal heraus - graue
 * Leiste, fremde Schrift, der Name der Domain darueber. Ausgerechnet an den
 * drei dramatischsten Stellen (Liquiditaet abziehen, Bot entlassen, Liga
 * beenden) waere das der falsche Ton.
 *
 * Aufgerufen wird es wie das Original: `if (await askConfirm({...}))`. Den
 * Rest macht `ConfirmHost`, das einmal in der App haengt.
 */

export interface ConfirmRequest {
  id: number;
  title: string;
  /** Absaetze. Ein Eintrag je Zeile, damit nichts zu einer Wand wird. */
  body: string[];
  confirmLabel: string;
  cancelLabel: string;
  tone: 'danger' | 'normal';
  icon?: IconName;
}

let counter = 0;
let current: ConfirmRequest | null = null;
let resolve: ((value: boolean) => void) | null = null;
const listeners = new Set<(value: ConfirmRequest | null) => void>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

export function askConfirm(options: {
  title: string;
  body: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'normal';
  icon?: IconName;
}): Promise<boolean> {
  // Eine offene Rueckfrage gilt als abgelehnt, wenn eine zweite kommt.
  // Sonst haengt der erste Aufrufer fuer immer.
  answer(false);

  current = {
    id: (counter += 1),
    title: options.title,
    body: options.body,
    confirmLabel: options.confirmLabel ?? 'Ja',
    cancelLabel: options.cancelLabel ?? 'Abbrechen',
    tone: options.tone ?? 'normal',
    icon: options.icon,
  };
  emit();

  return new Promise<boolean>((done) => {
    resolve = done;
  });
}

export function answer(value: boolean): void {
  const done = resolve;
  resolve = null;
  current = null;
  emit();
  done?.(value);
}

export function useConfirm(): ConfirmRequest | null {
  const [value, setValue] = useState<ConfirmRequest | null>(current);

  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);

  return value;
}
