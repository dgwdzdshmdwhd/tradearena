import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Candle } from '../lib/api.js';

const INTERVALS = ['1m', '5m', '15m', '1h', '1d'] as const;

/** Farben aus dem Designsystem - die Bibliothek kann keine CSS-Variablen. */
const COLORS = {
  up: '#22c55e',
  down: '#ef4444',
  accent: '#f5b52e',
  info: '#7c8cff',
  text: '#6b7789',
  grid: 'rgba(31,39,51,0.8)',
  border: '#1f2733',
};

export function Chart({
  candles,
  interval,
  onInterval,
  title,
  livePrice,
  simple = false,
}: {
  candles: Candle[];
  interval: string;
  onInterval: (value: string) => void;
  title: string;
  livePrice: number | null;
  /** Einfacher Modus: ohne Indikator-Schalter. */
  simple?: boolean;
}): JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const smaSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const emaSeries = useRef<ISeriesApi<'Line'> | null>(null);

  const [showSma, setShowSma] = useState(true);
  const [showEma, setShowEma] = useState(false);
  const [showRsi, setShowRsi] = useState(false);

  useEffect(() => {
    if (!holder.current) return;

    const chart = createChart(holder.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: COLORS.text,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: COLORS.text, labelBackgroundColor: '#252e3d' },
        horzLine: { color: COLORS.text, labelBackgroundColor: '#252e3d' },
      },
    });

    chartRef.current = chart;

    candleSeries.current = chart.addCandlestickSeries({
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.up,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });

    volumeSeries.current = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.88, bottom: 0 } });

    smaSeries.current = chart.addLineSeries({
      color: COLORS.accent,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    emaSeries.current = chart.addLineSeries({
      color: COLORS.info,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const observer = new ResizeObserver(() => {
      if (!holder.current) return;
      chart.applyOptions({
        width: holder.current.clientWidth,
        height: holder.current.clientHeight,
      });
    });
    observer.observe(holder.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Doppelte Zeitstempel weist die Bibliothek zurueck - Coin-Trades koennen
  // in derselben Sekunde passieren, deshalb vorher filtern.
  useEffect(() => {
    if (!candleSeries.current || candles.length === 0) return;

    const seen = new Set<number>();
    const clean = candles
      .map((candle) => ({ ...candle, time: Math.floor(candle.t / 1000) as UTCTimestamp }))
      .filter((candle) => {
        if (seen.has(candle.time)) return false;
        seen.add(candle.time);
        return Number.isFinite(candle.o) && Number.isFinite(candle.c);
      })
      .sort((a, b) => a.time - b.time);

    candleSeries.current.setData(
      clean.map((candle) => ({
        time: candle.time,
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
      })),
    );

    volumeSeries.current?.setData(
      clean.map((candle) => ({
        time: candle.time,
        value: candle.v,
        color: candle.c >= candle.o ? 'rgba(34,197,94,0.28)' : 'rgba(239,68,68,0.28)',
      })),
    );

    smaSeries.current?.setData(showSma ? movingAverage(clean, 20) : []);
    emaSeries.current?.setData(showEma ? exponential(clean, 50) : []);
  }, [candles, showSma, showEma]);

  // Laufender Kurs: die letzte Kerze mitziehen, damit der Chart lebt.
  useEffect(() => {
    if (!candleSeries.current || livePrice === null || candles.length === 0) return;

    const last = candles[candles.length - 1];
    if (!last) return;

    candleSeries.current.update({
      time: Math.floor(last.t / 1000) as UTCTimestamp,
      open: last.o,
      high: Math.max(last.h, livePrice),
      low: Math.min(last.l, livePrice),
      close: livePrice,
    });
  }, [livePrice, candles]);

  const rsiValue = useMemo(
    () => (showRsi ? rsiOf(candles.map((candle) => candle.c), 14) : null),
    [candles, showRsi],
  );

  return (
    <div className="panel flex min-h-0 flex-1 flex-col" data-tour="chart">
      <div className="panel-head">
        <span className="num truncate normal-case tracking-normal text-[13.5px] text-[var(--color-fg)]">
          {title}
        </span>

        <div className="flex items-center gap-0.5">
          {rsiValue !== null ? (
            <span
              className={`num mr-1.5 text-[11px] ${
                rsiValue > 70 ? 'down' : rsiValue < 30 ? 'up' : 'dimmer'
              }`}
            >
              RSI {rsiValue.toFixed(0)}
            </span>
          ) : null}

          {simple ? null : (
            <>
              <Chip active={showSma} onClick={() => setShowSma(!showSma)} label="SMA" />
              <Chip active={showEma} onClick={() => setShowEma(!showEma)} label="EMA" />
              <Chip active={showRsi} onClick={() => setShowRsi(!showRsi)} label="RSI" />
              <span className="mx-1 h-3 w-px bg-[var(--color-border)]" />
            </>
          )}

          {INTERVALS.map((value) => (
            <Chip
              key={value}
              active={interval === value}
              onClick={() => onInterval(value)}
              label={value}
            />
          ))}
        </div>
      </div>

      <div ref={holder} className="min-h-[200px] flex-1" />
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`num rounded-[4px] px-1.5 py-0.5 text-[11px] normal-case tracking-normal transition ${
        active
          ? 'bg-[var(--color-raised)] text-[var(--color-fg)]'
          : 'text-[var(--color-fg-3)] hover:text-[var(--color-fg-2)]'
      }`}
    >
      {label}
    </button>
  );
}

interface Point {
  time: UTCTimestamp;
  value: number;
}

function movingAverage(candles: Array<{ time: UTCTimestamp; c: number }>, period: number): Point[] {
  const out: Point[] = [];
  let sum = 0;

  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i]!.c;
    if (i >= period) sum -= candles[i - period]!.c;
    if (i >= period - 1) out.push({ time: candles[i]!.time, value: sum / period });
  }

  return out;
}

function exponential(candles: Array<{ time: UTCTimestamp; c: number }>, period: number): Point[] {
  const out: Point[] = [];
  const k = 2 / (period + 1);
  let previous: number | null = null;

  for (let i = 0; i < candles.length; i += 1) {
    const value = candles[i]!.c;
    previous = previous === null ? value : value * k + previous * (1 - k);
    if (i >= period - 1) out.push({ time: candles[i]!.time, value: previous });
  }

  return out;
}

function rsiOf(values: number[], period: number): number | null {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
