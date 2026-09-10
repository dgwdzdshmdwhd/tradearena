import { useEffect, useState } from 'react';

import type { IconName } from '../components/Icon.js';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error' | 'achievement' | 'danger';
  title: string;
  body?: string;
  /** Glyph aus dem Icon-Satz. Fehlt es, wird eins aus `kind` abgeleitet. */
  icon?: IconName;
  /** Bei Achievements: der Schluessel, damit das passende Glyph erscheint. */
  achievementKey?: string;
}

let counter = 0;
let toasts: Toast[] = [];
const listeners = new Set<(value: Toast[]) => void>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

export function pushToast(toast: Omit<Toast, 'id'>, ttlMs = 5_000): void {
  const entry = { ...toast, id: (counter += 1) };
  toasts = [entry, ...toasts].slice(0, 4);
  emit();

  setTimeout(() => {
    toasts = toasts.filter((item) => item.id !== entry.id);
    emit();
  }, ttlMs);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  const [value, setValue] = useState<Toast[]>(toasts);

  useEffect(() => {
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);

  return value;
}
