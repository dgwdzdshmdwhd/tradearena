import { useEffect, useState, type FormEvent } from 'react';

import { Icon, MODE_ICONS } from '../components/Icon.js';
import { Segmented } from '../components/Ui.js';
import { ApiError, api } from '../lib/api.js';
import { fmtUsd } from '../lib/format.js';

interface InvitePreview {
  name: string;
  mode: string;
  status: string;
  members: number;
  startingCashCents: string;
  owner: string | null;
}

const MODE_LABELS: Record<string, string> = {
  classic: 'Klassisch',
  blitz: 'Blitzrunde',
  survival: 'Survival',
  timemachine: 'Zeitmaschine',
};

export function Auth({
  onDone,
  inviteCode,
}: {
  onDone: () => void;
  inviteCode: string | null;
}): JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>(inviteCode ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<InvitePreview | null>(null);

  useEffect(() => {
    if (!inviteCode) return;
    void api
      .get<{ league: InvitePreview }>(`/api/leagues/preview/${inviteCode}`)
      .then((data) => setInvite(data.league))
      .catch(() => setInvite(null));
  }, [inviteCode]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.post(`/api/auth/${mode}`, { username, password });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Da ging etwas schief.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-5">
      <div className="w-full max-w-[21rem]">
        <div className="mb-7">
          <div className="num text-[22px] font-semibold tracking-[-0.02em]">
            TRADE<span className="accent">ARENA</span>
          </div>
          <p className="dim mt-1.5 text-[12.5px] leading-relaxed">
            Echte Kurse, Spielgeld, deine Freunde.
          </p>
        </div>

        {invite ? (
          <div className="panel mb-3 p-3">
            <div className="stat-label mb-2">Einladung</div>
            <div className="flex items-start gap-2.5">
              <span className="accent mt-px">
                <Icon name={MODE_ICONS[invite.mode] ?? 'candles'} size={16} />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{invite.name}</div>
                <div className="dimmer text-[11px]">
                  {MODE_LABELS[invite.mode] ?? invite.mode} · {invite.members}{' '}
                  {invite.members === 1 ? 'Spieler' : 'Spieler'}
                  {invite.owner ? ` · von ${invite.owner}` : ''}
                </div>
                <div className="dimmer num mt-1 text-[11px]">
                  Startkapital {fmtUsd(invite.startingCashCents)}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <form onSubmit={submit} className="panel p-3.5">
          <div className="mb-3.5">
            <Segmented
              options={[
                { value: 'login', label: 'Anmelden' },
                { value: 'register', label: 'Konto anlegen' },
              ]}
              value={mode}
              onChange={setMode}
            />
          </div>

          <label className="mb-3 block">
            <span className="label">Benutzername</span>
            <input
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="3-20 Zeichen"
              autoFocus
            />
          </label>

          <label className="mb-4 block">
            <span className="label">Passwort</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder="mindestens 6 Zeichen"
            />
          </label>

          {error ? (
            <div
              className="down mb-3 flex items-start gap-2 rounded-[var(--radius)] border p-2 text-[12px] leading-snug"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-down) 40%, transparent)',
                background: 'color-mix(in srgb, var(--color-down) 10%, transparent)',
              }}
            >
              <Icon name="alert" size={14} className="mt-px" />
              {error}
            </div>
          ) : null}

          <button className="btn btn-primary w-full" disabled={busy}>
            {busy ? '…' : invite ? 'Beitreten' : mode === 'login' ? 'Anmelden' : 'Konto anlegen'}
          </button>
        </form>

        <p className="dimmer mt-4 text-[11px] leading-relaxed">
          Kein echtes Geld, keine Einzahlung, keine E-Mail-Adresse. Nur ein Name, ein Passwort
          und ein Einladungslink von deinen Freunden.
        </p>
      </div>
    </div>
  );
}
