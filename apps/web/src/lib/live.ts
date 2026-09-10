/**
 * Live-Verbindung zum Server.
 *
 * EIN WebSocket fuer die ganze Seite. Kurse kommen gedrosselt herein und
 * werden ueber einen kleinen Verteiler an die Komponenten gegeben - React
 * rendert also nicht bei jedem einzelnen Tick neu, sondern gebuendelt.
 */

import { useEffect, useRef, useState } from 'react';

export interface Tick {
  bid: string;
  ask: string;
  last: string;
  at: number;
}

export type Prices = Record<string, Tick>;

type Handler = (event: string, payload: unknown) => void;

class LiveClient {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private leagues = new Set<string>();
  private handlers = new Set<Handler>();
  private priceHandlers = new Set<(prices: Prices) => void>();

  prices: Prices = {};
  status: 'offline' | 'connecting' | 'online' = 'offline';

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    this.status = 'connecting';
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.status = 'online';
      for (const leagueId of this.leagues) {
        socket.send(JSON.stringify({ type: 'subscribe', leagueId }));
      }
      this.emit('status', 'online');
    };

    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as {
        type?: string;
        event?: string;
        data?: Prices;
        payload?: unknown;
      };

      if (data.type === 'prices' && data.data) {
        this.prices = { ...this.prices, ...data.data };
        for (const handler of this.priceHandlers) handler(this.prices);
        return;
      }

      if (data.type === 'league' || data.type === 'user') {
        this.emit(String(data.event), data.payload);
      }
    };

    socket.onclose = () => {
      this.status = 'offline';
      this.emit('status', 'offline');
      this.attempts += 1;
      setTimeout(() => this.connect(), Math.min(15_000, 500 * 2 ** Math.min(5, this.attempts)));
    };

    socket.onerror = () => socket.close();
  }

  subscribe(leagueId: string): void {
    this.leagues.add(leagueId);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'subscribe', leagueId }));
    }
  }

  unsubscribe(leagueId: string): void {
    this.leagues.delete(leagueId);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'unsubscribe', leagueId }));
    }
  }

  onEvent(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onPrices(handler: (prices: Prices) => void): () => void {
    this.priceHandlers.add(handler);
    return () => this.priceHandlers.delete(handler);
  }

  private emit(event: string, payload: unknown): void {
    for (const handler of this.handlers) handler(event, payload);
  }
}

export const live = new LiveClient();

/** Kurse abonnieren - hoechstens alle 120 ms neu rendern. */
export function usePrices(): Prices {
  const [prices, setPrices] = useState<Prices>(live.prices);
  const pending = useRef<Prices | null>(null);

  useEffect(() => {
    let frame = 0;

    const flush = (): void => {
      if (pending.current) {
        setPrices(pending.current);
        pending.current = null;
      }
      frame = window.setTimeout(flush, 120);
    };
    frame = window.setTimeout(flush, 120);

    const off = live.onPrices((next) => {
      pending.current = next;
    });

    return () => {
      window.clearTimeout(frame);
      off();
    };
  }, []);

  return prices;
}

/** Auf Liga-Ereignisse hoeren (Trades, Feed, Chat, Liquidationen ...). */
export function useLiveEvent(handler: Handler): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => live.onEvent((event, payload) => ref.current(event, payload)), []);
}

export function useLeagueSubscription(leagueId: string | null): void {
  useEffect(() => {
    if (!leagueId) return;
    live.subscribe(leagueId);
    return () => live.unsubscribe(leagueId);
  }, [leagueId]);
}
