import { useState } from 'react';

import { ApiError, api, type Coin, type LeagueDetail } from '../lib/api.js';
import { fmtCountdown, fmtPrice, fmtQty, fmtUsd, toCents, toQty } from '../lib/format.js';
import { sounds } from '../lib/sound.js';
import { pushToast } from '../lib/toast.js';
import { Icon } from './Icon.js';
import { CoinMark, Empty, Field, Modal } from './Ui.js';

/** Farbpalette fuer neue Coins - abgestimmt auf den dunklen Grund. */
const SWATCHES = [
  '#d4a24c',
  '#5b8def',
  '#31c48d',
  '#f05252',
  '#a78bfa',
  '#38bdf8',
  '#fb923c',
  '#e879a6',
];

export function CoinsPanel({
  leagueId,
  league,
  coins,
  onChanged,
  onTrade,
}: {
  leagueId: string;
  league: LeagueDetail;
  coins: Coin[];
  onChanged: () => void;
  onTrade: (instrumentId: string) => void;
}): JSX.Element {
  const [creating, setCreating] = useState(false);

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Launchpad</span>
        {league.coinsAllowed && league.status === 'running' ? (
          <button
            className="normal-case tracking-normal text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
            onClick={() => setCreating(true)}
          >
            Coin starten
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {!league.coinsAllowed ? (
          <Empty icon="coin" title="Abgeschaltet">
            In dieser Liga sind eigene Coins nicht erlaubt.
          </Empty>
        ) : null}

        {coins.length === 0 && league.coinsAllowed ? (
          <Empty icon="coin" title="Noch kein Coin">
            Der Kurs entsteht aus einem Liquiditaetspool: Wer kauft, treibt ihn selbst nach oben.
            Wer die Liquiditaet abzieht, laesst ihn zusammenbrechen.
          </Empty>
        ) : null}

        {coins.map((coin) => (
          <CoinCard
            key={coin.instrumentId}
            coin={coin}
            league={league}
            onChanged={onChanged}
            onTrade={onTrade}
          />
        ))}
      </div>

      {creating ? (
        <CreateCoin
          leagueId={leagueId}
          league={league}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function CoinCard({
  coin,
  league,
  onChanged,
  onTrade,
}: {
  coin: Coin;
  league: LeagueDetail;
  onChanged: () => void;
  onTrade: (instrumentId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const dead = coin.status !== 'live';
  const locked = coin.lpLockUntil !== null && coin.lpLockUntil > Date.now();
  const canPull = coin.isMine && Number(coin.myShares) > 0 && !dead && league.rugpullMode !== 'off';

  const pull = async (): Promise<void> => {
    const confirmed = window.confirm(
      `Liquiditaet aus ${coin.ticker} abziehen?\n\n` +
        `Der Kurs bricht sofort zusammen. ${coin.holders} Spieler halten diesen Coin.\n` +
        `Das Abzeichen "Rugger" bleibt dauerhaft an deinem Profil.`,
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const result = await api.post<{ usdCents: string; rugged: boolean }>(
        `/api/coins/${coin.instrumentId}/rug`,
      );
      sounds.rug();
      pushToast({
        kind: 'danger',
        icon: 'scissors',
        title: result.rugged ? 'Liquiditaet abgezogen' : 'Anteil entnommen',
        body: `${fmtUsd(result.usdCents)} auf dein Konto.`,
      });
      onChanged();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Ging nicht',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    } finally {
      setBusy(false);
    }
  };

  const addLiquidity = async (): Promise<void> => {
    const input = window.prompt('Wie viel Dollar Liquiditaet hinzufuegen?', '1000');
    if (!input) return;

    try {
      await api.post(`/api/coins/${coin.instrumentId}/liquidity`, { amountCents: toCents(input) });
      pushToast({ kind: 'success', title: 'Liquiditaet hinzugefuegt' });
      onChanged();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Ging nicht',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    }
  };

  return (
    <div
      className={`rounded-[var(--radius)] border border-[var(--color-hairline)] p-2.5 ${
        dead ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <CoinMark ticker={coin.ticker} color={coin.color} size={26} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <b className="num text-[12.5px] font-medium">{coin.ticker}</b>
              {dead ? (
                <span className="down text-[9.5px] uppercase tracking-wider">gerugged</span>
              ) : null}
            </div>
            <div className="dimmer truncate text-[10.5px]">
              {coin.name} · {coin.creatorName} · {coin.holders} Halter
            </div>
          </div>
        </div>

        <div className="text-right">
          <div className="num text-[12.5px]">{fmtPrice(coin.priceCents)} $</div>
          <div className="dimmer num text-[10.5px]">MC {fmtUsd(coin.marketCapCents)}</div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px]">
        <Row label="Liquiditaet" value={fmtUsd(coin.reserveUsdCents)} />
        <Row label="Gebuehr" value={`${(coin.feeBps / 100).toFixed(2)} %`} />
        <Row
          label="LP-Sperre"
          value={locked ? fmtCountdown(coin.lpLockUntil) : 'keine'}
          tone={!locked && !dead ? 'accent' : undefined}
        />
        <Row label="Ersteller haelt" value={`${coin.risk.creatorSharePct.toFixed(0)} %`} />
      </div>

      {!dead ? <RiskBar score={coin.risk.score} locked={coin.risk.locked} /> : null}

      {Number(coin.myQty) > 0 ? (
        <div className="dimmer mt-1.5 text-[10.5px]">
          Du haelst <span className="num">{fmtQty(coin.myQty)}</span>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1">
        {!dead ? (
          <button className="btn btn-sm" onClick={() => onTrade(coin.instrumentId)}>
            handeln
          </button>
        ) : null}
        {!dead && league.status === 'running' ? (
          <button className="btn btn-sm" onClick={() => void addLiquidity()}>
            <Icon name="plus" size={11} />
            Liquiditaet
          </button>
        ) : null}
        {canPull ? (
          <button
            className="btn btn-sell btn-sm"
            onClick={() => void pull()}
            disabled={busy || locked}
            title={locked ? 'Liquiditaet ist noch gesperrt' : 'Liquiditaet abziehen'}
          >
            <Icon name="scissors" size={11} />
            {locked ? 'gesperrt' : 'abziehen'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RiskBar({ score, locked }: { score: number; locked: boolean }): JSX.Element {
  const color =
    score > 70 ? 'var(--color-down)' : score > 35 ? 'var(--color-accent)' : 'var(--color-up)';
  const label =
    score > 70 ? 'sehr riskant' : score > 35 ? 'riskant' : locked ? 'abgesichert' : 'ueberschaubar';

  return (
    <div className="mt-2">
      <div className="mb-1 flex justify-between text-[10px]">
        <span className="dimmer">Risiko</span>
        <span style={{ color }}>{label}</span>
      </div>
      <div className="meter">
        <i style={{ width: `${Math.max(4, score)}%`, background: color }} />
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-2">
      <span className="dimmer">{label}</span>
      <span className={`num ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function CreateCoin({
  leagueId,
  league,
  onClose,
  onCreated,
}: {
  leagueId: string;
  league: LeagueDetail;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [color, setColor] = useState(SWATCHES[0] as string);
  const [supply, setSupply] = useState('1000000000');
  const [liquidity, setLiquidity] = useState('5000');
  const [lockMinutes, setLockMinutes] = useState(league.rugpullMode === 'locked' ? '15' : '0');
  const [feeBps, setFeeBps] = useState('100');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/api/leagues/${leagueId}/coins`, {
        name,
        ticker,
        emoji: '',
        color,
        supply: toQty(supply),
        liquidityCents: toCents(liquidity),
        lockMinutes: Number(lockMinutes),
        feeBps: Number(feeBps),
      });
      pushToast({ kind: 'success', icon: 'coin', title: `${ticker.toUpperCase()} ist live` });
      onCreated();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: 'Coin konnte nicht starten',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    } finally {
      setBusy(false);
    }
  };

  const startPrice = Number(liquidity) / Math.max(1, Number(supply));

  return (
    <Modal title="Eigenen Coin starten" onClose={onClose} width="26rem">
      <div className="space-y-3.5 p-4">
        <div className="flex items-center gap-3">
          <CoinMark ticker={ticker || '??'} color={color} size={40} />
          <div className="grid flex-1 grid-cols-4 gap-1">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                onClick={() => setColor(swatch)}
                className={`h-6 rounded-[4px] border transition ${
                  color === swatch ? 'border-[var(--color-fg)]' : 'border-transparent'
                }`}
                style={{ background: `${swatch}33`, boxShadow: `inset 0 0 0 1px ${swatch}88` }}
                aria-label={swatch}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Kuerzel">
            <input
              className="input"
              value={ticker}
              placeholder="MOON"
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Name">
            <input
              className="input"
              value={name}
              placeholder="Moonboy"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Menge">
            <input className="input" value={supply} onChange={(e) => setSupply(e.target.value)} />
          </Field>
          <Field label="Liquiditaet ($)">
            <input
              className="input"
              value={liquidity}
              onChange={(e) => setLiquidity(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="LP-Sperre (Min.)"
            hint={league.rugpullMode === 'locked' ? 'Von der Liga vorgegeben.' : undefined}
          >
            <input
              className="input"
              value={lockMinutes}
              onChange={(e) => setLockMinutes(e.target.value)}
              disabled={league.rugpullMode === 'locked'}
            />
          </Field>
          <Field label="Handelsgebuehr (bp)">
            <input className="input" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} />
          </Field>
        </div>

        <div className="rounded-[var(--radius)] border border-[var(--color-hairline)] bg-[var(--color-bg)] p-2 text-[11px]">
          <Row label="Startkurs" value={`${startPrice.toPrecision(3)} $`} />
          <Row label="Listing-Gebuehr" value="500,00 $" />
          <Row
            label="kostet dich sofort"
            value={fmtUsd(String(Number(liquidity) * 100 + 50_000))}
          />
        </div>

        <p className="dimmer text-[11px] leading-relaxed">
          Deine Liquiditaet landet im Pool und bestimmt den Startkurs. Ohne Sperre kannst du sie
          jederzeit wieder abziehen — der Kurs bricht dann zusammen. Alle sehen vorher, wie hoch
          dein Anteil ist und ob gesperrt wurde.
        </p>

        <div className="flex justify-end gap-2 border-t border-[var(--color-hairline)] pt-3.5">
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy || ticker.length < 2 || name.length < 2}
          >
            {busy ? '…' : 'Starten'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
