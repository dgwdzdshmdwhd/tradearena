import { useEffect, useMemo, useRef, useState } from 'react';

import { navigate } from '../App.js';
import { api, type Instrument, type LeaderboardEntry, type OrderRow, type Portfolio } from '../lib/api.js';
import { fmtBps, fmtPrice, fmtQty, fmtUsd, priceToNumber, returnBps, signClass } from '../lib/format.js';
import type { Prices } from '../lib/live.js';
import { pushToast } from '../lib/toast.js';
import { Icon } from './Icon.js';
import { Avatar, Empty } from './Ui.js';

/** Kurs, der bei jeder Aenderung kurz aufblitzt - gruen rauf, rot runter. */
function LivePrice({ value, className = '' }: { value: string | null; className?: string }): JSX.Element {
  const previous = useRef<string | null>(null);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (previous.current !== null && value !== null && value !== previous.current) {
      setFlash(Number(value) > Number(previous.current) ? 'flash-up' : 'flash-down');
      const handle = setTimeout(() => setFlash(''), 400);
      previous.current = value;
      return () => clearTimeout(handle);
    }
    previous.current = value;
  }, [value]);

  return (
    <span className={`num rounded-[3px] px-1 ${flash} ${className}`}>
      {value === null ? '—' : fmtPrice(value)}
    </span>
  );
}

export function Watchlist({
  instruments,
  prices,
  selectedId,
  onSelect,
}: {
  instruments: Instrument[];
  prices: Prices;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState('');

  const shown = instruments.filter((instrument) =>
    filter ? instrument.display.toLowerCase().includes(filter.toLowerCase()) : true,
  );

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Maerkte</span>
        <span className="num normal-case tracking-normal">{shown.length}</span>
      </div>

      <div className="border-b border-[var(--color-hairline)] p-1.5">
        <div className="flex items-center gap-1.5 rounded-[var(--radius)] bg-[var(--color-bg)] px-2">
          <span className="dimmer">
            <Icon name="search" size={12} />
          </span>
          <input
            className="input h-7 border-0 bg-transparent px-0 text-[12px] focus:shadow-none"
            placeholder="suchen"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.map((instrument) => {
          const tick = prices[instrument.symbol];
          const last = tick?.last ?? instrument.last;
          const active = selectedId === instrument.id;

          return (
            <button
              key={instrument.id}
              onClick={() => onSelect(instrument.id)}
              className={`flex w-full items-center justify-between border-l-2 px-2.5 py-1.5 text-left transition ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-raised)]'
                  : 'border-transparent hover:bg-[var(--color-raised)]'
              }`}
            >
              {/* Die Kennzeichnung steht nur bei Coins - bei zehn
                  Krypto-Zeilen waere "Krypto" darunter reines Rauschen. */}
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[12.5px]">{instrument.display}</span>
                {instrument.kind === 'coin' ? (
                  <span className="dimmer shrink-0 text-[9.5px] uppercase tracking-wider">
                    Coin
                  </span>
                ) : null}
              </span>
              <LivePrice value={last} className="text-[12.5px]" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Positions({
  portfolio,
  onClose,
}: {
  portfolio: Portfolio | null;
  onClose: (instrumentId: string, qty: string) => void;
}): JSX.Element {
  const positions = portfolio?.positions ?? [];

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Positionen</span>
        <span className="num normal-case tracking-normal">{positions.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {positions.length === 0 ? (
          <Empty icon="wallet" title="Depot leer">
            Kauf dir etwas, dann steht es hier.
          </Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Markt</th>
                <th className="r">Menge</th>
                <th className="r">Einstand</th>
                <th className="r">Kurs</th>
                <th className="r">Gewinn</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const pnl = Number(position.unrealizedCents);
                const short = Number(position.qty) < 0;

                return (
                  <tr key={position.instrumentId}>
                    <td>
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{position.display}</span>
                        {short ? (
                          <span className="down text-[9.5px] uppercase tracking-wider">Short</span>
                        ) : null}
                      </span>
                    </td>
                    <td className="num r">{fmtQty(position.qty)}</td>
                    <td className="num r dim">{fmtPrice(position.avgEntry)}</td>
                    <td className="num r">{fmtPrice(position.mark)}</td>
                    <td className={`num r ${signClass(pnl)}`}>{fmtUsd(position.unrealizedCents, true)}</td>
                    <td className="r">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => onClose(position.instrumentId, position.qty)}
                      >
                        schliessen
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  stop_limit: 'Stop-Limit',
  trailing_stop: 'Trailing',
};

export function OpenOrders({
  orders,
  onChanged,
}: {
  orders: OrderRow[];
  onChanged: () => void;
}): JSX.Element {
  const cancel = async (id: string): Promise<void> => {
    try {
      await api.post(`/api/orders/${id}/cancel`);
      onChanged();
    } catch {
      pushToast({ kind: 'error', title: 'Stornieren fehlgeschlagen' });
    }
  };

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Offene Orders</span>
        <span className="num normal-case tracking-normal">{orders.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {orders.length === 0 ? (
          <Empty icon="list" title="Nichts liegt im Markt">
            Limit- und Stop-Orders warten hier, bis ihr Kurs erreicht ist.
          </Empty>
        ) : (
          <table className="tbl">
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <span className="flex items-center gap-1.5">
                      <span className={order.side === 'buy' ? 'up' : 'down'}>
                        <Icon name={order.side === 'buy' ? 'arrow-up' : 'arrow-down'} size={12} />
                      </span>
                      <span className="text-[12px]">
                        {ORDER_TYPE_LABEL[order.type] ?? order.type}
                      </span>
                      {order.reduce_only ? (
                        <span className="dimmer text-[9.5px] uppercase tracking-wider">Schutz</span>
                      ) : null}
                    </span>
                    <span className="dimmer block text-[10.5px]">{order.display}</span>
                  </td>
                  <td className="num r">
                    {fmtQty(order.qty)}
                    <span className="dimmer block text-[10.5px]">
                      {order.limit_price ? `L ${fmtPrice(order.limit_price)}` : ''}
                      {order.stop_price ? ` S ${fmtPrice(order.stop_price)}` : ''}
                      {order.trail_bps ? ` T ${(order.trail_bps / 100).toFixed(1)} %` : ''}
                    </span>
                  </td>
                  <td className="r">
                    <button
                      className="btn btn-ghost btn-sm px-1.5"
                      onClick={() => void cancel(order.id)}
                      title="Order stornieren"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function Leaderboard({
  entries,
  bots,
  meUserId,
}: {
  entries: LeaderboardEntry[];
  bots: LeaderboardEntry[];
  meUserId: string;
}): JSX.Element {
  const [showBots, setShowBots] = useState(false);
  const list = showBots ? bots : entries;

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Rangliste</span>
        {bots.length > 0 ? (
          <button
            className="normal-case tracking-normal text-[var(--color-fg-3)] hover:text-[var(--color-fg)]"
            onClick={() => setShowBots(!showBots)}
          >
            {showBots ? 'Spieler zeigen' : 'Bots zeigen'}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <Empty icon="users" title={showBots ? 'Keine Bots' : 'Niemand da'} />
        ) : null}

        {list.map((entry, index) => {
          const bps = returnBps(entry.equityCents, entry.startCents);
          const mine = entry.userId === meUserId && !entry.isBot;

          return (
            <button
              key={entry.accountId}
              onClick={() => navigate(`/p/${entry.userId}`)}
              className={`flex w-full items-center gap-2.5 border-b border-[var(--color-hairline)] px-2.5 py-2 text-left last:border-0 transition hover:bg-[var(--color-raised)] ${
                mine ? 'bg-[var(--color-raised)]' : ''
              } ${entry.eliminated ? 'opacity-40' : ''}`}
            >
              <span
                className={`num w-4 shrink-0 text-right text-[11px] ${
                  index === 0 ? 'accent' : 'dimmer'
                }`}
              >
                {index + 1}
              </span>

              {entry.isBot ? (
                <span className="dim flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] border border-[var(--color-border)] bg-[var(--color-raised)]">
                  <Icon name="cpu" size={12} />
                </span>
              ) : (
                <Avatar name={entry.username} id={entry.userId} size={24} />
              )}

              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px]">
                  {entry.isBot ? entry.label : entry.username}
                </span>
                <span className="dimmer num text-[10.5px]">{entry.trades} Trades</span>
              </span>

              <span className="text-right">
                <span className="num block text-[12.5px]">{fmtUsd(entry.equityCents)}</span>
                <span className={`num block text-[10.5px] ${signClass(bps)}`}>{fmtBps(bps)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Simuliertes Orderbuch.
 *
 * Rein visuell: aus Bid, Ask und etwas Rauschen gebaut. Es beeinflusst die
 * Ausfuehrung NICHT - dafuer braeuchte es echte Tiefendaten. Es zeigt aber
 * den Spread, und der ist echt.
 */
export function OrderBook({
  instrument,
  prices,
}: {
  instrument: Instrument | null;
  prices: Prices;
}): JSX.Element {
  const tick = instrument ? prices[instrument.symbol] : undefined;
  const bid = priceToNumber(tick?.bid ?? instrument?.bid ?? null);
  const ask = priceToNumber(tick?.ask ?? instrument?.ask ?? null);

  const rows = useMemo(() => {
    if (!bid || !ask) return { asks: [], bids: [] };
    const step = Math.max((ask - bid) / 2, ask * 0.0002);

    const build = (start: number, direction: number): Array<{ price: number; size: number }> =>
      Array.from({ length: 7 }, (_, index) => ({
        price: start + direction * step * (index + 1),
        size: Math.round((7 - index) * 1.6 + Math.random() * 7),
      }));

    return { asks: build(ask, 1).reverse(), bids: build(bid, -1) };
  }, [bid, ask, instrument?.id]);

  const maxSize = Math.max(1, ...[...rows.asks, ...rows.bids].map((row) => row.size));
  const digits = ask > 0 && ask < 1 ? 8 : 2;

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Orderbuch</span>
        <span className="normal-case tracking-normal">simuliert</span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-1 py-1 text-[11px]">
        {rows.asks.map((row, index) => (
          <BookRow key={`a${index}`} {...row} max={maxSize} side="ask" digits={digits} />
        ))}

        <div className="my-1 flex items-center justify-between border-y border-[var(--color-hairline)] px-1 py-1">
          <span className="num up">{bid ? bid.toFixed(digits) : '—'}</span>
          <span className="dimmer num text-[10px]">
            {bid && ask ? `${(((ask - bid) / bid) * 10_000).toFixed(1)} bp` : '—'}
          </span>
          <span className="num down">{ask ? ask.toFixed(digits) : '—'}</span>
        </div>

        {rows.bids.map((row, index) => (
          <BookRow key={`b${index}`} {...row} max={maxSize} side="bid" digits={digits} />
        ))}
      </div>
    </div>
  );
}

function BookRow({
  price,
  size,
  max,
  side,
  digits,
}: {
  price: number;
  size: number;
  max: number;
  side: 'bid' | 'ask';
  digits: number;
}): JSX.Element {
  return (
    <div className="relative flex justify-between px-1 py-[1.5px]">
      <span
        className="absolute inset-y-0 right-0 rounded-[2px] opacity-[0.16]"
        style={{
          width: `${Math.round((size / max) * 100)}%`,
          background: side === 'bid' ? 'var(--color-up)' : 'var(--color-down)',
        }}
      />
      <span className={`num relative ${side === 'bid' ? 'up' : 'down'}`}>
        {price.toFixed(digits)}
      </span>
      <span className="num dimmer relative">{size}</span>
    </div>
  );
}
