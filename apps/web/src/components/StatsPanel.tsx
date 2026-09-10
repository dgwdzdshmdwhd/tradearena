import { ColorType, createChart, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';

import { api, quiet } from '../lib/api.js';
import { fmtBps, fmtPrice, fmtQty, fmtTime, fmtUsd, signClass } from '../lib/format.js';
import { Icon } from './Icon.js';
import { Empty, Metric } from './Ui.js';

interface EquityResponse {
  curve: Array<{ at: number; equityCents: string }>;
  stats: {
    totalPnlCents: string;
    returnBps: string;
    maxDrawdownBps: string;
    maxDrawdownCents: string;
    winRateBps: string;
    bestTradeCents: string;
    worstTradeCents: string;
    trades: number;
    wins: number;
    losses: number;
    profitFactor: number | null;
    sharpe: number | null;
    avgHoldMs: number | null;
  };
}

interface TradeRow {
  id: string;
  display: string;
  side: string;
  qty: string;
  price: string;
  fee: string;
  realized: string;
  source: string;
  executed_at: number;
}

export function StatsPanel({ leagueId }: { leagueId: string }): JSX.Element {
  const [data, setData] = useState<EquityResponse | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async (): Promise<void> => {
      const [equity, tradeData] = await Promise.all([
        api.get<EquityResponse>(`/api/leagues/${leagueId}/equity`),
        api.get<{ trades: TradeRow[] }>(`/api/leagues/${leagueId}/trades`),
      ]);
      setData(equity);
      setTrades(tradeData.trades);
    };

    quiet(load());
    const handle = setInterval(() => quiet(load()), 30_000);
    return () => clearInterval(handle);
  }, [leagueId]);

  useEffect(() => {
    if (!holder.current || !data || data.curve.length < 2) return;

    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#646e7d',
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(28,33,40,0.7)' },
        horzLines: { color: 'rgba(28,33,40,0.7)' },
      },
      rightPriceScale: { borderColor: '#1c2128' },
      timeScale: { borderColor: '#1c2128', timeVisible: true },
      height: 170,
      width: holder.current.clientWidth,
      handleScale: false,
      handleScroll: false,
    });

    const series = chart.addAreaSeries({
      lineColor: '#d4a24c',
      topColor: 'rgba(212,162,76,0.22)',
      bottomColor: 'rgba(212,162,76,0.01)',
      lineWidth: 2,
      priceLineVisible: false,
    });

    const seen = new Set<number>();
    series.setData(
      data.curve
        .map((point) => ({
          time: Math.floor(point.at / 1000) as UTCTimestamp,
          value: Number(point.equityCents) / 100,
        }))
        .filter((point) => {
          if (seen.has(point.time)) return false;
          seen.add(point.time);
          return true;
        }),
    );
    chart.timeScale().fitContent();

    const observer = new ResizeObserver(() => {
      if (holder.current) chart.applyOptions({ width: holder.current.clientWidth });
    });
    observer.observe(holder.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [data]);

  const stats = data?.stats;

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-head">
        <span>Auswertung</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={holder} className="min-h-[170px] border-b border-[var(--color-hairline)]" />

        {stats ? (
          <div className="grid grid-cols-3 gap-x-4 gap-y-3 border-b border-[var(--color-hairline)] p-3">
            <Metric
              label="Gewinn/Verlust"
              value={fmtUsd(stats.totalPnlCents, true)}
              tone={signClass(Number(stats.totalPnlCents))}
            />
            <Metric
              label="Rendite"
              value={fmtBps(stats.returnBps)}
              tone={signClass(Number(stats.returnBps))}
            />
            <Metric label="Max Drawdown" value={fmtBps(stats.maxDrawdownBps, false)} tone="down" />
            <Metric
              label="Trefferquote"
              value={fmtBps(stats.winRateBps, false)}
              sub={`${stats.wins} zu ${stats.losses}`}
            />
            <Metric
              label="Profit-Faktor"
              value={stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}
            />
            <Metric label="Sharpe" value={stats.sharpe === null ? '—' : stats.sharpe.toFixed(2)} />
            <Metric label="bester Trade" value={fmtUsd(stats.bestTradeCents, true)} tone="up" />
            <Metric
              label="schlimmster Trade"
              value={fmtUsd(stats.worstTradeCents, true)}
              tone="down"
            />
            <Metric label="Trades" value={String(stats.trades)} />
          </div>
        ) : null}

        <div className="panel-head border-b-0 border-t border-[var(--color-hairline)]">
          <span>Historie</span>
          <span className="num normal-case tracking-normal">{trades.length}</span>
        </div>

        {trades.length === 0 ? (
          <Empty icon="list" title="Noch keine Trades" />
        ) : (
          <table className="tbl">
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id}>
                  <td>
                    <span className="flex items-center gap-1.5">
                      <span className={trade.side === 'buy' ? 'up' : 'down'}>
                        <Icon name={trade.side === 'buy' ? 'arrow-up' : 'arrow-down'} size={11} />
                      </span>
                      <span className="text-[13.5px]">{trade.display}</span>
                      {trade.source === 'bot' ? (
                        <span className="dimmer">
                          <Icon name="cpu" size={10} />
                        </span>
                      ) : null}
                      {trade.source === 'liquidation' ? (
                        <span className="down">
                          <Icon name="octagon" size={10} />
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="num r">
                    {fmtQty(trade.qty)}
                    <span className="dimmer block text-[12px]">{fmtPrice(trade.price)}</span>
                  </td>
                  <td className="num r">
                    <span className={signClass(Number(trade.realized))}>
                      {Number(trade.realized) === 0 ? '—' : fmtUsd(trade.realized, true)}
                    </span>
                    <span className="dimmer block text-[12px]">{fmtUsd(trade.fee)}</span>
                  </td>
                  <td className="num r dimmer text-[12px]">{fmtTime(trade.executed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
