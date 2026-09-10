import { useEffect } from 'react';

import { answer, useConfirm } from '../lib/confirm.js';
import { Icon } from './Icon.js';

/** Zeigt die offene Rueckfrage aus `askConfirm`. Haengt einmal in der App. */
export function ConfirmHost(): JSX.Element | null {
  const request = useConfirm();

  useEffect(() => {
    if (!request) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') answer(false);
      if (event.key === 'Enter') answer(true);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;

  const danger = request.tone === 'danger';

  return (
    <div
      className="fixed inset-0 z-[9996] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) answer(false);
      }}
    >
      <div className="panel enter w-full max-w-[26rem] shadow-2xl">
        <div className="flex items-center gap-2 px-4 pt-4">
          <span style={{ color: danger ? 'var(--color-down)' : 'var(--color-accent)' }}>
            <Icon name={request.icon ?? (danger ? 'alert' : 'check')} size={18} />
          </span>
          <span className="text-[15.5px] font-semibold">{request.title}</span>
        </div>

        <div className="space-y-2 px-4 pb-1 pt-3">
          {request.body.map((line, position) => (
            <p key={position} className="dim text-[13.5px] leading-relaxed">
              {line}
            </p>
          ))}
        </div>

        <div className="flex justify-end gap-2 px-4 pb-4 pt-3">
          <button className="btn btn-sm" onClick={() => answer(false)}>
            {request.cancelLabel}
          </button>
          <button
            className={`btn btn-sm ${danger ? 'btn-sell' : 'btn-primary'}`}
            onClick={() => answer(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
