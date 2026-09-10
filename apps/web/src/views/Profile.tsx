import { useEffect, useState } from 'react';

import { navigate } from '../App.js';
import { ACHIEVEMENT_ICONS, Icon } from '../components/Icon.js';
import { Avatar, Empty, Metric } from '../components/Ui.js';
import { api, quiet, type Achievement } from '../lib/api.js';
import { fmtBps, fmtDateTime, fmtUsd, returnBps, signClass } from '../lib/format.js';

interface ProfileData {
  user: { id: string; username: string; avatar: string; createdAt: number };
  prestige: number;
  lifetimePrestige: number;
  rank: { title: string; icon: string };
  achievements: Array<{ key: string; unlockedAt: number }>;
  leagues: Array<{
    league_id: string;
    name: string;
    status: string;
    equity: string;
    start_cash: string;
  }>;
  totals: { trades: number; volumeCents: string };
}

export function Profile({ userId }: { userId: string }): JSX.Element {
  const [data, setData] = useState<ProfileData | null>(null);
  const [catalog, setCatalog] = useState<Achievement[]>([]);

  useEffect(() => {
    quiet(
      (async () => {
        const [profile, achievements] = await Promise.all([
          api.get<ProfileData>(`/api/profile/${userId}`),
          api.get<{ achievements: Achievement[] }>('/api/achievements'),
        ]);
        setData(profile);
        setCatalog(achievements.achievements);
      })(),
    );
  }, [userId]);

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="dimmer num animate-pulse text-[11px] tracking-[0.2em]">LADE PROFIL</span>
      </div>
    );
  }

  const byKey = new Map(catalog.map((entry) => [entry.key, entry]));
  const shame = data.achievements.filter((entry) => byKey.get(entry.key)?.tier === 'schande');
  const honours = data.achievements.filter((entry) => byKey.get(entry.key)?.tier !== 'schande');

  return (
    <div className="mx-auto max-w-[46rem] px-5 pb-20 pt-5">
      <button className="btn btn-ghost btn-sm mb-5" onClick={() => history.back()}>
        <Icon name="arrow-left" size={13} />
        zurueck
      </button>

      <div className="panel mb-3 flex flex-wrap items-center gap-4 p-4">
        <Avatar name={data.user.username} id={data.user.id} size={46} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-medium">{data.user.username}</div>
          <div className="dim text-[12.5px]">
            {data.rank.title} · {data.lifetimePrestige} Prestige insgesamt
          </div>
          <div className="dimmer mt-0.5 text-[11px]">dabei seit {fmtDateTime(data.user.createdAt)}</div>
        </div>

        <div className="flex gap-6">
          <Metric label="Trades" value={String(data.totals.trades)} />
          <Metric label="Volumen" value={fmtUsd(data.totals.volumeCents)} />
        </div>
      </div>

      {shame.length > 0 ? (
        <div
          className="panel mb-3 p-3"
          style={{ borderColor: 'color-mix(in srgb, var(--color-down) 35%, transparent)' }}
        >
          <div className="stat-label mb-2">Schande-Abzeichen</div>
          <div className="flex flex-wrap gap-1.5">
            {shame.map((entry) => {
              const definition = byKey.get(entry.key);
              return (
                <span
                  key={entry.key}
                  title={definition?.description}
                  className="down flex items-center gap-1.5 rounded-[var(--radius)] border px-2 py-1 text-[11.5px]"
                  style={{ borderColor: 'color-mix(in srgb, var(--color-down) 35%, transparent)' }}
                >
                  <Icon name={ACHIEVEMENT_ICONS[entry.key] ?? 'medal'} size={12} />
                  {definition?.name}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="panel mb-3 p-3">
        <div className="stat-label mb-2">Trophaeen · {honours.length}</div>
        {honours.length === 0 ? (
          <Empty icon="trophy" title="Noch nichts gewonnen" />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {honours.map((entry) => {
              const definition = byKey.get(entry.key);
              return (
                <span
                  key={entry.key}
                  title={`${definition?.description ?? ''} · ${fmtDateTime(entry.unlockedAt)}`}
                  className="flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--color-hairline)] px-2 py-1 text-[11.5px]"
                >
                  <span className="accent">
                    <Icon name={ACHIEVEMENT_ICONS[entry.key] ?? 'medal'} size={12} />
                  </span>
                  {definition?.name}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel p-3">
        <div className="stat-label mb-1">Ligen</div>
        {data.leagues.map((league) => {
          const bps = returnBps(league.equity, league.start_cash);
          return (
            <button
              key={league.league_id}
              onClick={() => navigate(`/l/${league.league_id}`)}
              className="flex w-full items-center justify-between border-t border-[var(--color-hairline)] py-2 text-left first:border-0"
            >
              <div>
                <div className="text-[12.5px]">{league.name}</div>
                <div className="dimmer text-[10.5px]">
                  {league.status === 'running' ? 'laeuft' : 'beendet'}
                </div>
              </div>
              <div className="text-right">
                <div className="num text-[12.5px]">{fmtUsd(league.equity)}</div>
                <div className={`num text-[10.5px] ${signClass(bps)}`}>{fmtBps(bps)}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
