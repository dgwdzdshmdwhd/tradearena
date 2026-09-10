import { useCallback, useEffect, useState } from 'react';

import { inviteLink, navigate } from '../App.js';
import { Icon, MODE_ICONS } from '../components/Icon.js';
import { CopyButton, Empty, Field, Modal, Toggle } from '../components/Ui.js';
import { ApiError, api, quiet, type LeagueSummary, type Me } from '../lib/api.js';
import { fmtBps, fmtCountdown, fmtUsd, returnBps, signClass, toCents } from '../lib/format.js';
import { pushToast } from '../lib/toast.js';

interface Scenario {
  key: string;
  name: string;
  minutes: number;
}

const MODES = [
  {
    key: 'classic',
    name: 'Klassisch',
    blurb: 'Live-Markt, feste Laufzeit. Wer am Ende am meisten hat, gewinnt.',
  },
  {
    key: 'blitz',
    name: 'Blitzrunde',
    blurb: '15 Minuten, nur Krypto, zehnfacher Hebel. Kurz und brutal.',
  },
  {
    key: 'survival',
    name: 'Survival',
    blurb: 'Wer zu tief faellt, fliegt raus. Der Letzte gewinnt.',
  },
  {
    key: 'timemachine',
    name: 'Zeitmaschine',
    blurb: 'Echte historische Kurse im Zeitraffer. Welcher Zeitraum, erfaehrst du am Ende.',
  },
] as const;

export function Lobby({ me, onRefresh }: { me: Me; onRefresh: () => void }): JSX.Element {
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    const [leagueData, scenarioData] = await Promise.all([
      api.get<{ leagues: LeagueSummary[] }>('/api/leagues'),
      api.get<{ scenarios: Scenario[] }>('/api/scenarios'),
    ]);
    setLeagues(leagueData.leagues);
    setScenarios(scenarioData.scenarios);
  }, []);

  useEffect(() => {
    quiet(load());
  }, [load]);

  const join = async (): Promise<void> => {
    // Sowohl ein reiner Code als auch ein ganzer Link funktionieren.
    const raw = code.trim();
    const parsed = raw.includes('/join/') ? (raw.split('/join/').pop() ?? '') : raw;

    try {
      const result = await api.post<{ leagueId: string }>('/api/leagues/join', {
        code: parsed.replace(/[^a-zA-Z0-9]/g, '').toUpperCase(),
      });
      navigate(`/l/${result.leagueId}`);
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Beitritt fehlgeschlagen',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    }
  };

  const running = leagues.filter((league) => league.status === 'running');
  const finished = leagues.filter((league) => league.status !== 'running');

  return (
    <div className="mx-auto max-w-[62rem] px-5 pb-20 pt-5">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <div className="num text-[21px] font-semibold tracking-[-0.02em]">
          TRADE<span className="accent">ARENA</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/desk')}>
            <Icon name="sliders" size={13} />
            {me.rank.title}
            <span className="num dimmer">{me.prestige}</span>
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Abmelden"
            onClick={async () => {
              await api.post('/api/auth/logout');
              location.hash = '';
              location.reload();
            }}
          >
            <Icon name="power" size={13} />
          </button>
        </div>
      </header>

      <section className="mb-7 flex flex-wrap items-center gap-2">
        <div className="panel flex min-w-[16rem] flex-1 items-center gap-1.5 p-1.5">
          <span className="dimmer pl-1.5">
            <Icon name="link" size={14} />
          </span>
          <input
            className="input border-0 bg-transparent focus:shadow-none"
            placeholder="Einladungslink oder Code einfuegen"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void join();
            }}
          />
          <button className="btn btn-sm" onClick={() => void join()} disabled={!code.trim()}>
            Beitreten
          </button>
        </div>

        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={13} />
          Neue Liga
        </button>
      </section>

      {running.length === 0 && finished.length === 0 ? (
        <div className="panel">
          <Empty icon="flag" title="Noch keine Liga">
            Leg eine Liga an und schick den Einladungslink an deine Freunde. Oder fuege oben einen
            Link ein, den du bekommen hast.
          </Empty>
        </div>
      ) : null}

      {running.length > 0 ? (
        <>
          <h2 className="stat-label mb-2">Laufend</h2>
          <div className="mb-7 grid gap-2 sm:grid-cols-2">
            {running.map((league) => (
              <LeagueCard key={league.id} league={league} />
            ))}
          </div>
        </>
      ) : null}

      {finished.length > 0 ? (
        <>
          <h2 className="stat-label mb-2">Beendet</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {finished.map((league) => (
              <LeagueCard key={league.id} league={league} />
            ))}
          </div>
        </>
      ) : null}

      {creating ? (
        <CreateLeague
          scenarios={scenarios}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            onRefresh();
            navigate(`/l/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function LeagueCard({ league }: { league: LeagueSummary }): JSX.Element {
  const bps = returnBps(league.equityCents, league.startCents);
  const mode = MODES.find((entry) => entry.key === league.mode);

  return (
    <div className="panel card p-3">
      <button onClick={() => navigate(`/l/${league.id}`)} className="block w-full text-left">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="dimmer mt-0.5">
              <Icon name={MODE_ICONS[league.mode] ?? 'candles'} size={15} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-medium">{league.name}</div>
              <div className="dimmer text-[12.5px]">
                {mode?.name} · {league.members} Spieler
              </div>
            </div>
          </div>
          {league.eliminated ? (
            <span className="down shrink-0 text-[11px] uppercase tracking-wider">
              ausgeschieden
            </span>
          ) : null}
        </div>

        <div className="flex items-end justify-between">
          <div>
            <div className="num text-[21px] font-medium">{fmtUsd(league.equityCents)}</div>
            <div className={`num text-[13px] ${signClass(bps)}`}>{fmtBps(bps)}</div>
          </div>
          <div className="dimmer num flex items-center gap-1 text-[12.5px]">
            {league.status === 'running' ? (
              <>
                <Icon name="clock" size={11} />
                {fmtCountdown(league.endsAt)}
              </>
            ) : (
              'beendet'
            )}
          </div>
        </div>
      </button>

      {league.status === 'running' ? (
        <div className="mt-3 flex items-center justify-between border-t border-[var(--color-hairline)] pt-2.5">
          <span className="num dimmer text-[12.5px] tracking-[0.08em]">{league.inviteCode}</span>
          <CopyButton
            value={inviteLink(league.inviteCode)}
            label="Einladungslink"
            icon="link"
            className="btn btn-ghost btn-sm"
          />
        </div>
      ) : null}
    </div>
  );
}

function CreateLeague({
  scenarios,
  onClose,
  onCreated,
}: {
  scenarios: Scenario[];
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const [mode, setMode] = useState<string>('classic');
  const [name, setName] = useState('Freitagsliga');
  const [cash, setCash] = useState('100000');
  const [hours, setHours] = useState('168');
  const [leverage, setLeverage] = useState('1');
  const [takerBps, setTakerBps] = useState('5');
  const [scenarioKey, setScenarioKey] = useState(scenarios[0]?.key ?? 'covid');
  const [feedVisibility, setFeedVisibility] = useState('instant');
  const [portfolioVisibility, setPortfolioVisibility] = useState('open');
  const [rugpullMode, setRugpullMode] = useState('locked');
  const [botsAllowed, setBotsAllowed] = useState(true);
  const [coinsAllowed, setCoinsAllowed] = useState(true);
  const [upgradesAllowed, setUpgradesAllowed] = useState(true);
  const [busy, setBusy] = useState(false);

  const isReplay = mode === 'timemachine';

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.post<{ leagueId: string }>('/api/leagues', {
        name,
        mode,
        startingCashCents: toCents(cash),
        durationMinutes: isReplay ? undefined : Math.round(Number(hours) * 60),
        maxLeverage: Number(leverage),
        takerBps: Number(takerBps),
        makerBps: Math.max(0, Math.round(Number(takerBps) * 0.4)),
        feedVisibility,
        portfolioVisibility,
        rugpullMode,
        botsAllowed,
        coinsAllowed,
        upgradesAllowed,
        scenarioKey: isReplay ? scenarioKey : undefined,
      });
      onCreated(result.leagueId);
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Liga konnte nicht angelegt werden',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Neue Liga" onClose={onClose} width="34rem">
      <div className="space-y-4 p-4">
        <div className="grid gap-1.5 sm:grid-cols-2">
          {MODES.map((entry) => (
            <button
              key={entry.key}
              onClick={() => {
                setMode(entry.key);
                if (entry.key === 'blitz') {
                  setLeverage('10');
                  setHours('0.25');
                  setBotsAllowed(false);
                  setCoinsAllowed(false);
                }
                if (entry.key === 'survival') {
                  setLeverage('2');
                  setHours('24');
                }
                if (entry.key === 'classic') {
                  setLeverage('1');
                  setHours('168');
                }
              }}
              className={`rounded-[var(--radius)] border p-2.5 text-left transition ${
                mode === entry.key
                  ? 'border-[var(--color-accent)] bg-[var(--color-raised)]'
                  : 'border-[var(--color-hairline)] hover:border-[var(--color-border)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={mode === entry.key ? 'accent' : 'dimmer'}>
                  <Icon name={MODE_ICONS[entry.key] ?? 'candles'} size={14} />
                </span>
                <span className="text-[14px] font-medium">{entry.name}</span>
              </div>
              <div className="dimmer mt-1 text-[12.5px] leading-snug">{entry.blurb}</div>
            </button>
          ))}
        </div>

        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {isReplay ? (
          <Field label="Szenario" hint="Welcher Zeitraum das war, wird erst am Ende verraten.">
            <select
              className="input"
              value={scenarioKey}
              onChange={(e) => setScenarioKey(e.target.value)}
            >
              {scenarios.map((scenario) => (
                <option key={scenario.key} value={scenario.key}>
                  {scenario.name} · ca. {scenario.minutes} Minuten
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Startkapital ($)">
              <input className="input" value={cash} onChange={(e) => setCash(e.target.value)} />
            </Field>
            <Field label="Dauer (Stunden)">
              <input className="input" value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Maximaler Hebel">
            <select className="input" value={leverage} onChange={(e) => setLeverage(e.target.value)}>
              {['1', '2', '3', '5', '10', '20'].map((value) => (
                <option key={value} value={value}>
                  {value}×{value === '1' ? ' (kein Hebel)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Gebuehr Taker (bp)"
            hint={`${(Number(takerBps) / 100).toFixed(2)} % je Trade`}
          >
            <input
              className="input"
              value={takerBps}
              onChange={(e) => setTakerBps(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Live-Feed">
            <select
              className="input"
              value={feedVisibility}
              onChange={(e) => setFeedVisibility(e.target.value)}
            >
              <option value="instant">sofort sichtbar</option>
              <option value="delayed">15 Minuten verzoegert</option>
              <option value="end_only">erst am Ende</option>
            </select>
          </Field>
          <Field label="Fremde Depots">
            <select
              className="input"
              value={portfolioVisibility}
              onChange={(e) => setPortfolioVisibility(e.target.value)}
            >
              <option value="open">offen einsehbar</option>
              <option value="hidden">verborgen</option>
            </select>
          </Field>
        </div>

        <Field label="Eigene Coins und Liquiditaet">
          <select
            className="input"
            value={rugpullMode}
            onChange={(e) => setRugpullMode(e.target.value)}
          >
            <option value="locked">erlaubt, Liquiditaet mindestens 15 Min. gesperrt</option>
            <option value="free">voll erlaubt, jederzeit abziehbar</option>
            <option value="off">Liquiditaet kann nie abgezogen werden</option>
          </select>
        </Field>

        <div className="space-y-2.5 border-t border-[var(--color-hairline)] pt-3.5">
          <Toggle checked={coinsAllowed} onChange={setCoinsAllowed} label="Eigene Coins erlauben" />
          <Toggle checked={botsAllowed} onChange={setBotsAllowed} label="KI-Bots erlauben" />
          <Toggle
            checked={upgradesAllowed}
            onChange={setUpgradesAllowed}
            label="Tycoon-Upgrades wirken lassen"
            hint="An: dein Trading-Desk wirkt sich aus. Aus: alle handeln zu identischen Konditionen."
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-hairline)] pt-3.5">
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '…' : 'Liga starten'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
