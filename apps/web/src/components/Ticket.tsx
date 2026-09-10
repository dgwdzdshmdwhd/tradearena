import { useEffect, useState } from 'react';

import { ApiError, api, type Instrument, type Portfolio } from '../lib/api.js';
import { centsToNumber, fmtPrice, fmtQty, fmtUsd, toCents, toPrice, toQty } from '../lib/format.js';
import { sounds } from '../lib/sound.js';
import { pushToast } from '../lib/toast.js';
import { Icon } from './Icon.js';
import { Field, Segmented, Toggle } from './Ui.js';

const TYPES = [
  { key: 'market', label: 'Market', hint: 'Sofort. Kauf zum Ask, Verkauf zum Bid.' },
  { key: 'limit', label: 'Limit', hint: 'Nur zu deinem Kurs oder besser. Kann liegen bleiben.' },
  { key: 'stop', label: 'Stop', hint: 'Loest bei deinem Kurs aus, wird dann zur Market-Order.' },
  { key: 'stop_limit', label: 'Stop-Limit', hint: 'Loest aus, wird dann zur Limit-Order.' },
  { key: 'trailing_stop', label: 'Trailing', hint: 'Folgt dem Kurs, aber nie zurueck.' },
] as const;

export function Ticket({
  leagueId,
  instrument,
  portfolio,
  onDone,
}: {
  leagueId: string;
  instrument: Instrument | null;
  portfolio: Portfolio | null;
  onDone: () => void;
}): JSX.Element {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<string>('market');
  const [useNotional, setUseNotional] = useState(true);
  const [amount, setAmount] = useState('1000');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [trailPct, setTrailPct] = useState('3');
  const [dayOnly, setDayOnly] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [useBracket, setUseBracket] = useState(false);
  const [stopLossPct, setStopLossPct] = useState('5');
  const [takeProfitPct, setTakeProfitPct] = useState('10');
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);

  const position = portfolio?.positions.find((entry) => entry.instrumentId === instrument?.id);
  const buyingPower = portfolio ? Number(portfolio.margin.buyingPowerCents) : 0;
  const cash = portfolio ? Number(portfolio.account.cashCents) : 0;

  // Die Vorschau kommt vom Server. Im Browser wird kein Preis berechnet -
  // sonst koennte man ihn dort auch manipulieren.
  useEffect(() => {
    if (!instrument || !amount || Number(amount) <= 0) {
      setPreview(null);
      return;
    }

    const handle = setTimeout(() => {
      void api
        .post<Record<string, string>>('/api/orders/preview', {
          leagueId,
          instrumentId: instrument.id,
          side,
          ...(useNotional ? { notionalCents: toCents(amount) } : { qty: toQty(amount) }),
        })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 200);

    return () => clearTimeout(handle);
  }, [leagueId, instrument, side, amount, useNotional]);

  const quickAmount = (fraction: number): void => {
    if (useNotional) {
      const base = side === 'buy' ? Math.max(buyingPower, cash) : cash;
      setAmount(String(Math.max(1, Math.floor(centsToNumber(String(base)) * fraction))));
      return;
    }
    if (position) setAmount(String((Number(position.qty) / 1e8) * fraction));
  };

  const submit = async (): Promise<void> => {
    if (!instrument) return;
    setBusy(true);
    sounds.click();

    try {
      const result = await api.post<{ status: string; message: string }>('/api/orders', {
        leagueId,
        instrumentId: instrument.id,
        side,
        type,
        ...(useNotional ? { notionalCents: toCents(amount) } : { qty: toQty(amount) }),
        ...(limitPrice ? { limitPrice: toPrice(limitPrice) } : {}),
        ...(stopPrice ? { stopPrice: toPrice(stopPrice) } : {}),
        ...(type === 'trailing_stop' ? { trailBps: Math.round(Number(trailPct) * 100) } : {}),
        tif: dayOnly ? 'day' : 'gtc',
        reduceOnly,
        ...(useBracket && type === 'market'
          ? {
              attachStopBps: Math.round(Number(stopLossPct) * 100),
              attachTakeProfitBps: Math.round(Number(takeProfitPct) * 100),
            }
          : {}),
      });

      if (result.status === 'filled') sounds.fill();

      pushToast({
        kind: 'success',
        icon: side === 'buy' ? 'arrow-up' : 'arrow-down',
        title: result.status === 'filled' ? 'Ausgefuehrt' : 'Order liegt im Markt',
        body: result.message,
      });

      onDone();
    } catch (error) {
      sounds.error();
      pushToast({
        kind: 'error',
        title: 'Order abgelehnt',
        body: error instanceof ApiError ? error.message : 'Unbekannter Fehler',
      });
    } finally {
      setBusy(false);
    }
  };

  // Tastenkuerzel: B kaufen, S verkaufen, Enter absenden.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);

      if (event.key === 'Enter' && !busy) {
        void submit();
        return;
      }
      if (typing) return;
      if (event.key.toLowerCase() === 'b') setSide('buy');
      if (event.key.toLowerCase() === 's') setSide('sell');
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const needsLimit = type === 'limit' || type === 'stop_limit';
  const needsStop = type === 'stop' || type === 'stop_limit';
  const selected = TYPES.find((entry) => entry.key === type);

  return (
    <div className="panel flex flex-col">
      <div className="panel-head">
        <span>Order</span>
        <span className="num normal-case tracking-normal text-[var(--color-fg-2)]">
          {instrument ? instrument.display : '—'}
        </span>
      </div>

      <div className="space-y-3 p-3">
        <Segmented
          options={[
            { value: 'buy', label: 'Kaufen', tone: 'buy' },
            { value: 'sell', label: 'Verkaufen', tone: 'sell' },
          ]}
          value={side}
          onChange={setSide}
        />

        <div>
          <select className="input" value={type} onChange={(event) => setType(event.target.value)}>
            {TYPES.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
          <p className="dimmer mt-1.5 text-[11px] leading-snug">{selected?.hint}</p>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="label mb-0">{useNotional ? 'Betrag ($)' : 'Menge'}</span>
            <button
              className="dimmer text-[10.5px] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-2)]"
              onClick={() => setUseNotional(!useNotional)}
            >
              {useNotional ? 'in Stueck' : 'in Dollar'}
            </button>
          </div>

          <input
            className="input"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
          />

          <div className="mt-1 grid grid-cols-4 gap-1">
            {[0.25, 0.5, 0.75, 1].map((fraction) => (
              <button
                key={fraction}
                className="btn btn-sm justify-center px-0"
                onClick={() => quickAmount(fraction)}
              >
                {fraction === 1 ? 'max' : `${fraction * 100} %`}
              </button>
            ))}
          </div>
        </div>

        {needsLimit ? (
          <Field label="Limitkurs">
            <input
              className="input"
              value={limitPrice}
              onChange={(event) => setLimitPrice(event.target.value)}
              placeholder={instrument?.last ? fmtPrice(instrument.last) : ''}
              inputMode="decimal"
            />
          </Field>
        ) : null}

        {needsStop ? (
          <Field label="Stopkurs">
            <input
              className="input"
              value={stopPrice}
              onChange={(event) => setStopPrice(event.target.value)}
              placeholder={instrument?.last ? fmtPrice(instrument.last) : ''}
              inputMode="decimal"
            />
          </Field>
        ) : null}

        {type === 'trailing_stop' ? (
          <Field label="Abstand (%)">
            <input
              className="input"
              value={trailPct}
              onChange={(event) => setTrailPct(event.target.value)}
              inputMode="decimal"
            />
          </Field>
        ) : null}

        <div className="space-y-2">
          <Toggle checked={dayOnly} onChange={setDayOnly} label="Nur heute gueltig" />
          <Toggle checked={reduceOnly} onChange={setReduceOnly} label="Nur Position schliessen" />
          {type === 'market' ? (
            <Toggle
              checked={useBracket}
              onChange={setUseBracket}
              label="Stop-Loss und Take-Profit anhaengen"
            />
          ) : null}
        </div>

        {useBracket && type === 'market' ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Stop-Loss %">
              <input
                className="input"
                value={stopLossPct}
                onChange={(event) => setStopLossPct(event.target.value)}
              />
            </Field>
            <Field label="Take-Profit %">
              <input
                className="input"
                value={takeProfitPct}
                onChange={(event) => setTakeProfitPct(event.target.value)}
              />
            </Field>
          </div>
        ) : null}

        {preview ? (
          <div className="rounded-[var(--radius)] border border-[var(--color-hairline)] bg-[var(--color-bg)] p-2 text-[11px]">
            <Row label="Menge" value={fmtQty(preview.qty)} />
            <Row label="Kurs" value={`${fmtPrice(preview.price)} $`} />
            <Row label="Volumen" value={fmtUsd(preview.grossCents)} />
            <Row label="Gebuehr" value={fmtUsd(preview.feeCents)} />
            {Number(preview.slippageCents) > 0 ? (
              <Row label="Slippage" value={fmtUsd(preview.slippageCents)} tone="accent" />
            ) : null}
            <div className="mt-1.5 border-t border-[var(--color-hairline)] pt-1.5">
              <Row
                label={side === 'buy' ? 'kostet dich' : 'bringt dir'}
                value={fmtUsd(String(Math.abs(Number(preview.cashDeltaCents))))}
                strong
              />
            </div>
          </div>
        ) : null}

        <button
          className={`btn w-full ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
          onClick={() => void submit()}
          disabled={busy || !instrument}
        >
          <Icon name={side === 'buy' ? 'arrow-up' : 'arrow-down'} size={13} />
          {busy ? '…' : side === 'buy' ? 'Kaufen' : 'Verkaufen'}
        </button>

        <div className="space-y-0.5 text-[11px]">
          {portfolio ? (
            <Row label="Kaufkraft" value={fmtUsd(portfolio.margin.buyingPowerCents)} />
          ) : null}
          {position ? (
            <Row
              label="Position"
              value={`${fmtQty(position.qty)} @ ${fmtPrice(position.avgEntry)}`}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <span className="dimmer">{label}</span>
      <span className={`num ${tone ?? ''} ${strong ? 'font-medium text-[var(--color-fg)]' : ''}`}>
        {value}
      </span>
    </div>
  );
}
