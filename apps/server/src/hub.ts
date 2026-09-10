/**
 * WebSocket-Verteiler.
 *
 * Ein zentraler Prozess abonniert die Kurse, alle Browser haengen hier dran.
 * Nachrichten gehen immer an eine Liga, nie an alle - so sieht niemand
 * Ereignisse aus einer Liga, in der er gar nicht mitspielt.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { readToken } from './auth.js';
import { SESSION_COOKIE } from './auth.js';

export type ServerMessage =
  | { type: 'prices'; data: Record<string, { bid: string; ask: string; last: string; at: number }> }
  | { type: 'hello'; status: string; userId: string }
  | { type: 'league'; leagueId: string; event: string; payload: unknown };

interface Client {
  socket: WebSocket;
  userId: string;
  leagues: Set<string>;
}

export class Hub {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<Client>();

  /** Wird gesetzt, damit der Hub die Ligamitgliedschaft pruefen kann. */
  memberCheck: (userId: string, leagueId: string) => Promise<boolean> = async () => false;

  constructor() {
    this.server.on('connection', (socket, request) => this.onConnection(socket, request));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(request, socket, head, (ws) => {
      this.server.emit('connection', ws, request);
    });
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const userId = readToken(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!userId) {
      socket.close(4001, 'Nicht angemeldet');
      return;
    }

    const client: Client = { socket, userId, leagues: new Set() };
    this.clients.add(client);

    socket.on('message', (raw) => {
      void this.onMessage(client, String(raw));
    });

    socket.on('close', () => {
      this.clients.delete(client);
    });

    socket.on('error', () => {
      this.clients.delete(client);
    });

    send(socket, { type: 'hello', status: 'ok', userId });
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let message: { type?: string; leagueId?: string };
    try {
      message = JSON.parse(raw) as { type?: string; leagueId?: string };
    } catch {
      return;
    }

    if (message.type === 'subscribe' && typeof message.leagueId === 'string') {
      // Nur abonnieren, wer wirklich Mitglied ist.
      if (await this.memberCheck(client.userId, message.leagueId)) {
        client.leagues.add(message.leagueId);
      }
      return;
    }

    if (message.type === 'unsubscribe' && typeof message.leagueId === 'string') {
      client.leagues.delete(message.leagueId);
    }
  }

  /** Kurse gehen an alle - Kursdaten sind kein Geheimnis. */
  broadcastPrices(data: Record<string, { bid: string; ask: string; last: string; at: number }>): void {
    const payload = JSON.stringify({ type: 'prices', data });
    for (const client of this.clients) {
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  /** Ligaereignisse gehen nur an die Mitglieder dieser Liga. */
  broadcastLeague(leagueId: string, event: string, payload: unknown): void {
    const message = JSON.stringify({ type: 'league', leagueId, event, payload });
    for (const client of this.clients) {
      if (client.leagues.has(leagueId) && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(message);
      }
    }
  }

  /** Eine Nachricht nur an einen bestimmten Spieler. */
  sendToUser(userId: string, event: string, payload: unknown): void {
    const message = JSON.stringify({ type: 'user', event, payload });
    for (const client of this.clients) {
      if (client.userId === userId && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(message);
      }
    }
  }

  get connections(): number {
    return this.clients.size;
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
