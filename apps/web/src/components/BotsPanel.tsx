import { useEffect, useState } from 'react';

import { ApiError, api, quiet, type Bot, type Instrument, type LeagueDetail } from '../lib/api.js';
import { fmtBps, fmtTime, fmtUsd, returnBps, signClass, toCents } from '../lib/format.js';
import { pushToast } from '../lib/toast.js';
import { Icon } from './Icon.js';
import { Empty, Field, Modal } from './Ui.js';

interface BotsResponse {
  bots: Bot[];
  slots: { unlocked: boolean; slots: number; trades: number; tradesNeeded: number };
  botsAllowed: boolean;
  strategies: Array<{ key: string; label: string; params: Record<string, number> }>;
}

const STRATEGY_BLURB: Record<string, string> = {
  dca: 'Kauft stur in festen Abstaenden. Solide, aber im Abwaertstrend gnadenlos.',
  mean_reversion: 'Kauft Rueckseter, verkauft Uebertreibungen. Stark seitwaerts, im Trend chancenlos.',
  momentum: 'Springt auf Ausbrueche auf. Faengt grosse Bewegungen, frisst Fehlausbrueche.',
  grid: 'Legt ein Netz aus Orders um den Kurs. Melkt Schwankungen, bricht bei Trends aus.',
  scalper: 'Viele Mini-Trades. Die Gebuehren fressen ihn, wenn die Liga teuer ist.',
};

const TRADES_FOR_FIRST_BOT = 5;

export function BotsPanel({
  leagueId,
  league,
  instruments,
  onChanged,
}: {
  leagueId: string;
  league: LeagueDetail;
  instruments: Instrument[];
  onChanged: () => void;
}): JSX.Element {
  const [data, setData] = useState<BotsResponse | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async (): Promise<void> => {
    setData(await api.get<BotsResponse>(`/api/leagues/${leagueId}/bots`));
  };

  useEffect(() => {
    quiet(load());
    const handle = setInterval(() => quiet(load()), 8_000);
    return () => clearInterval(handle);
  }, [leagueId]);

  const act = async (botId: string, action: string): Promise<void> => {
    try {
      await api.post(`/api/bots/${botId}/${action}`);
      await load();
      onChanged();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Ging nicht',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    }
  };

  const slots = data?.slots;
  const active = data?.bots.filter((bot) => bot.status !== 'fired') ?? [];
  const canAdd = slots?.unlocked === true && active.length < (slots?.slots ?? 0);

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Bots</span>
        {league.botsAllowed && canAdd && league.status === 'running' ? (
          <button
            className="normal-case tracking-normal text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
            onClick={() => setCreating(true)}
          >
            einstellen
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {!league.botsAllowed ? (
          <Empty icon="cpu" title="Abgeschaltet">
            In dieser Liga sind Bots nicht erlaubt.
          </Empty>
        ) : null}

        {league.botsAllowed && slots && !slots.unlocked ? (
          <div className="px-4 py-8 text-center">
            <span className="dimmer mb-3 inline-block">
              <Icon name="cpu" size={22} strokeWidth={1.25} />
            </span>
            <div className="mb-1 text-[15px] font-medium">Dein erster Bot muss verdient werden</div>
            <p className="dimmer mb-3 text-[13px]">
              Noch <span className="num">{slots.tradesNeeded}</span> Trades.
            </p>
            <div className="meter mx-auto max-w-[13rem]">
              <i style={{ width: `${Math.min(100, (slots.trades / TRADES_FOR_FIRST_BOT) * 100)}%` }} />
            </div>
          </div>
        ) : null}

        {active.map((bot) => {
          const bps = returnBps(bot.equity, bot.start_cash);

          return (
            <div key={bot.id} className="rounded-[var(--radius)] border border-[var(--color-hairline)] p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="dim mt-0.5">
                    <Icon name="cpu" size={14} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <b className="num text-[14px] font-medium">{bot.name}</b>
                      <span className="dimmer text-[11px]">Lv {bot.level}</span>
                      {bot.status !== 'running' ? (
                        <span className="dimmer text-[11px] uppercase tracking-wider">
                          pausiert
                        </span>
                      ) : null}
                    </div>
                    <div className="dimmer truncate text-[12px]">
                      {bot.strategy} · {bot.display} · {bot.trades_count} Trades
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="num text-[14px]">{fmtUsd(bot.equity)}</div>
                  <div className={`num text-[12px] ${signClass(bps)}`}>{fmtBps(bps)}</div>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-3 text-[12px]">
                <div className="flex justify-between">
                  <span className="dimmer">Fehlerquote</span>
                  <span className="num">{(bot.error_rate_bps / 100).toFixed(1)} %</span>
                </div>
                <div className="flex justify-between">
                  <span className="dimmer">Bargeld</span>
                  <span className="num">{fmtUsd(bot.cash)}</span>
                </div>
              </div>

              {bot.decisions.length > 0 ? (
                <div className="mt-2 max-h-28 space-y-1 overflow-y-auto rounded-[4px] bg-[var(--color-bg)] p-1.5 text-[12px]">
                  {bot.decisions.map((decision) => (
                    <div key={decision.id} className="flex gap-1.5">
                      <span className="dimmer num shrink-0">{fmtTime(decision.at)}</span>
                      <span className={decision.mistake ? 'down' : 'dim'}>{decision.reason}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="dimmer mt-2 text-[12px]">Wartet auf ein Signal.</p>
              )}

              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  className="btn btn-sm"
                  onClick={() => void act(bot.id, bot.status === 'running' ? 'stop' : 'start')}
                >
                  <Icon name={bot.status === 'running' ? 'pause' : 'play'} size={11} />
                  {bot.status === 'running' ? 'pausieren' : 'starten'}
                </button>

                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    const input = window.prompt('Wie viel Budget nachlegen ($)?', '1000');
                    if (!input) return;
                    try {
                      await api.post(`/api/bots/${bot.id}/budget`, { amountCents: toCents(input) });
                      await load();
                      onChanged();
                    } catch (error) {
                      pushToast({
                        kind: 'error',
                        title: 'Ging nicht',
                        body: error instanceof ApiError ? error.message : '',
                      });
                    }
                  }}
                >
                  <Icon name="plus" size={11} />
                  Budget
                </button>

                <button
                  className="btn btn-sell btn-sm"
                  onClick={() => {
                    if (window.confirm(`${bot.name} entlassen? Position wird glattgestellt.`)) {
                      void act(bot.id, 'fire');
                    }
                  }}
                >
                  entlassen
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {creating && data ? (
        <CreateBot
          leagueId={leagueId}
          instruments={instruments}
          strategies={data.strategies}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            quiet(load());
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateBot({
  leagueId,
  instruments,
  strategies,
  onClose,
  onCreated,
}: {
  leagueId: string;
  instruments: Instrument[];
  strategies: Array<{ key: string; label: string }>;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState('mean_reversion');
  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? '');
  const [budget, setBudget] = useState('10000');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.post<{ name: string }>(`/api/leagues/${leagueId}/bots`, {
        name,
        strategy,
        instrumentId,
        budgetCents: toCents(budget),
      });
      pushToast({ kind: 'success', icon: 'cpu', title: `${result.name} faengt an` });
      onCreated();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Bot konnte nicht anfangen',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Bot einstellen" onClose={onClose} width="26rem">
      <div className="space-y-3.5 p-4">
        <Field label="Name" hint="Leer lassen fuer einen zufaelligen Namen.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div>
          <span className="label">Strategie</span>
          <div className="space-y-1">
            {strategies.map((entry) => (
              <button
                key={entry.key}
                onClick={() => setStrategy(entry.key)}
                className={`w-full rounded-[var(--radius)] border p-2 text-left transition ${
                  strategy === entry.key
                    ? 'border-[var(--color-accent)] bg-[var(--color-raised)]'
                    : 'border-[var(--color-hairline)] hover:border-[var(--color-border)]'
                }`}
              >
                <div className="text-[14px] font-medium">{entry.label}</div>
                <div className="dimmer text-[12.5px] leading-snug">
                  {STRATEGY_BLURB[entry.key] ?? ''}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Markt">
            <select
              className="input"
              value={instrumentId}
              onChange={(e) => setInstrumentId(e.target.value)}
            >
              {instruments.map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.display}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Budget ($)">
            <input className="input" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
        </div>

        <p className="dimmer text-[12.5px] leading-relaxed">
          Das Budget wandert auf ein eigenes Bot-Konto. Der Bot zahlt dieselben Gebuehren wie du und
          sieht dieselben Kurse — und er macht Fehler. Mit jedem Level werden es weniger, nie null.
        </p>

        <div className="flex justify-end gap-2 border-t border-[var(--color-hairline)] pt-3.5">
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '…' : 'Einstellen'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
