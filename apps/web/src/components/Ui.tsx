import { useEffect, useState, type ReactNode } from 'react';

import { Icon, type IconName } from './Icon.js';

/**
 * Gemeinsame Bausteine.
 *
 * Alles, was in mehr als einer Ansicht vorkommt, steht hier - damit Abstaende,
 * Groessen und Verhalten an einer Stelle festgelegt sind und nicht in zwanzig
 * Komponenten leicht unterschiedlich nachgebaut werden.
 */

/**
 * Monogramm-Avatar.
 *
 * Statt eines Emojis: die Initialen auf einer Farbe, die deterministisch aus
 * der Benutzer-ID entsteht. Derselbe Spieler hat dadurch ueberall dieselbe
 * Farbe, ohne dass irgendwo etwas gespeichert werden muesste.
 */
export function Avatar({
  name,
  id,
  size = 24,
}: {
  name: string;
  id: string;
  size?: number;
}): JSX.Element {
  const hue = hashHue(id || name);
  const initials = (name || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

  return (
    <span
      className="num inline-flex items-center justify-center font-medium"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, size * 0.2),
        fontSize: size * 0.42,
        letterSpacing: '0.02em',
        background: `hsl(${hue} 32% 22%)`,
        color: `hsl(${hue} 55% 72%)`,
        border: `1px solid hsl(${hue} 30% 30%)`,
        flexShrink: 0,
      }}
      title={name}
    >
      {initials}
    </span>
  );
}

/** Farbmarke fuer einen Coin: Kuerzel auf der gewaehlten Farbe. */
export function CoinMark({
  ticker,
  color,
  size = 24,
}: {
  ticker: string;
  color: string;
  size?: number;
}): JSX.Element {
  return (
    <span
      className="num inline-flex items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, size * 0.2),
        fontSize: size * 0.4,
        background: `${color}1f`,
        color,
        border: `1px solid ${color}55`,
        flexShrink: 0,
      }}
    >
      {ticker.slice(0, 2).toUpperCase()}
    </span>
  );
}

function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  // Gelbgruen und Rot meiden - die sind fuer Gewinn und Verlust reserviert.
  const allowed = [200, 215, 230, 250, 265, 280, 300, 330, 25, 40, 165, 185];
  return allowed[hash % allowed.length] as number;
}

/** Reiter-Leiste. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  labels,
}: {
  tabs: readonly T[];
  active: T;
  onChange: (value: T) => void;
  labels?: Partial<Record<T, string>>;
}): JSX.Element {
  return (
    <div className="flex shrink-0 gap-px overflow-x-auto border-b border-[var(--color-hairline)]">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`relative whitespace-nowrap px-3 py-1.5 text-[11.5px] font-medium transition ${
            active === tab
              ? 'text-[var(--color-fg)]'
              : 'text-[var(--color-fg-3)] hover:text-[var(--color-fg-2)]'
          }`}
        >
          {labels?.[tab] ?? tab}
          {active === tab ? (
            <span className="absolute inset-x-2 -bottom-px h-px bg-[var(--color-accent)]" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** Segmentierte Auswahl, z. B. Kaufen/Verkaufen. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string; tone?: 'buy' | 'sell' }>;
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="grid gap-px rounded-[var(--radius)] border border-[var(--color-border)] p-px"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = option.value === value;
        const tone =
          option.tone === 'buy'
            ? 'text-[var(--color-up)] bg-[color-mix(in_srgb,var(--color-up)_16%,transparent)]'
            : option.tone === 'sell'
              ? 'text-[var(--color-down)] bg-[color-mix(in_srgb,var(--color-down)_16%,transparent)]'
              : 'bg-[var(--color-overlay)] text-[var(--color-fg)]';

        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={`rounded-[4px] py-1.5 text-[12px] font-medium transition ${
              active ? tone : 'text-[var(--color-fg-3)] hover:text-[var(--color-fg-2)]'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="dimmer mt-1 block text-[11px] leading-snug">{hint}</span> : null}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}): JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 text-left"
      type="button"
    >
      <span
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full border px-px transition ${
          checked
            ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]'
            : 'border-[var(--color-border)] bg-[var(--color-raised)]'
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full transition ${
            checked
              ? 'translate-x-3 bg-[var(--color-accent)]'
              : 'translate-x-0 bg-[var(--color-fg-3)]'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px]">{label}</span>
        {hint ? <span className="dimmer block text-[11px] leading-snug">{hint}</span> : null}
      </span>
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = '32rem',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="panel enter my-8 w-full shadow-2xl" style={{ maxWidth: width }}>
        <div className="panel-head">
          <span>{title}</span>
          <button className="btn btn-ghost btn-sm px-1.5" onClick={onClose} aria-label="Schliessen">
            <Icon name="x" size={13} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Kopiert Text und bestaetigt es kurz sichtbar. */
export function CopyButton({
  value,
  label = 'kopieren',
  icon = 'copy',
  className = 'btn btn-sm',
}: {
  value: string;
  label?: string;
  icon?: IconName;
  className?: string;
}): JSX.Element {
  const [done, setDone] = useState(false);

  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          // Ohne Zwischenablage-Rechte: wenigstens markierbar machen.
          window.prompt('Zum Kopieren markieren:', value);
        }
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      title={value}
    >
      <Icon name={done ? 'check' : icon} size={12} />
      {done ? 'kopiert' : label}
    </button>
  );
}

/** Statuspunkt mit Beschriftung, z. B. fuer den Kurs-Feed. */
export function Status({
  tone,
  children,
}: {
  tone: 'live' | 'warn' | 'off';
  children: ReactNode;
}): JSX.Element {
  const color =
    tone === 'live' ? 'var(--color-up)' : tone === 'warn' ? 'var(--color-accent)' : 'var(--color-fg-3)';

  return (
    <span className="dimmer inline-flex items-center gap-1.5 text-[11px]">
      <span className="dot" style={{ background: color }} />
      {children}
    </span>
  );
}

/** Leerzustand mit Glyph, Titel und einer Erklaerung. */
export function Empty({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <span className="mb-3 text-[var(--color-fg-3)]">
        <Icon name={icon} size={22} strokeWidth={1.25} />
      </span>
      <div className="mb-1 text-[13px] font-medium">{title}</div>
      {children ? (
        <p className="dimmer max-w-[26rem] text-[11.5px] leading-relaxed">{children}</p>
      ) : null}
    </div>
  );
}

/** Kennzahl mit Beschriftung. */
export function Metric({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}): JSX.Element {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`num text-[13px] ${tone ?? ''}`}>{value}</div>
      {sub ? <div className="dimmer num text-[10.5px]">{sub}</div> : null}
    </div>
  );
}
