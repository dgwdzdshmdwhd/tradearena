import { dismissToast, useToasts, type Toast } from '../lib/toast.js';
import { ACHIEVEMENT_ICONS, Icon, type IconName } from './Icon.js';

const TONE: Record<Toast['kind'], { border: string; color: string; icon: IconName; label: string }> =
  {
    info: { border: 'var(--color-border)', color: 'var(--color-fg-2)', icon: 'list', label: '' },
    success: { border: 'var(--color-up)', color: 'var(--color-up)', icon: 'check', label: '' },
    error: { border: 'var(--color-accent)', color: 'var(--color-accent)', icon: 'alert', label: '' },
    danger: { border: 'var(--color-down)', color: 'var(--color-down)', icon: 'octagon', label: '' },
    achievement: {
      border: 'var(--color-accent)',
      color: 'var(--color-accent)',
      icon: 'medal',
      label: 'Achievement',
    },
  };

export function Toasts(): JSX.Element {
  const toasts = useToasts();

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-[9990] flex w-[min(92vw,20rem)] flex-col gap-2">
      {toasts.map((toast) => {
        const tone = TONE[toast.kind];
        const icon =
          toast.icon ??
          (toast.achievementKey ? ACHIEVEMENT_ICONS[toast.achievementKey] : undefined) ??
          tone.icon;

        return (
          <button
            key={toast.id}
            onClick={() => dismissToast(toast.id)}
            className="panel enter pointer-events-auto p-2.5 text-left shadow-xl"
            style={{ borderColor: `color-mix(in srgb, ${tone.border} 45%, transparent)` }}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-px" style={{ color: tone.color }}>
                <Icon name={icon} size={15} />
              </span>
              <div className="min-w-0">
                {tone.label ? (
                  <div className="stat-label" style={{ color: tone.color }}>
                    {tone.label}
                  </div>
                ) : null}
                <div className="text-[14px] font-medium leading-snug">{toast.title}</div>
                {toast.body ? (
                  <div className="dimmer mt-0.5 text-[12.5px] leading-snug">{toast.body}</div>
                ) : null}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
