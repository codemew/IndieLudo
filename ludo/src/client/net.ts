import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServer, ServerToClient } from '../shared/protocol.js';
import { update } from './store.js';

type ClientSocket = Socket<ServerToClient, ClientToServer>;

let socket: ClientSocket | null = null;
let intentionalClose = false;

export interface NetHandlers {
  onConnect: (reconnected: boolean) => void;
  onUnauthorized: () => void;
  bind: (s: ClientSocket) => void;
}

function banner(show: boolean): void {
  const b = document.getElementById('net-banner');
  if (b) b.hidden = !show;
}

export function connect(token: string, h: NetHandlers): void {
  disconnect();
  intentionalClose = false;
  let everConnected = false;
  const s: ClientSocket = io({
    auth: { token },
    // WebSocket first (lowest latency); if a network blocks it, fall back to plain HTTP
    // requests instead of failing to connect at all.
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10000,
  });
  socket = s;
  h.bind(s);
  s.on('connect', () => {
    banner(false);
    update({ online: true });
    h.onConnect(everConnected);
    everConnected = true;
  });
  s.on('disconnect', (reason) => {
    update({ online: false });
    if (intentionalClose) return;
    banner(true);
    // The server kicked us (revoked session or flooding); socket.io will not retry by itself.
    if (reason === 'io server disconnect') setTimeout(() => s.connect(), 1000);
  });
  s.on('connect_error', (err) => {
    if (err.message === 'UNAUTHORIZED') {
      disconnect();
      h.onUnauthorized();
      return;
    }
    banner(true);
  });
}

export function disconnect(): void {
  intentionalClose = true;
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  banner(false);
}

export function isConnected(): boolean {
  return Boolean(socket?.connected);
}

/** Emits with an acknowledgement and a timeout; never rejects. */
export function emit<T = unknown>(event: keyof ClientToServer, payload: object, timeoutMs = 8000): Promise<Ack<T>> {
  return new Promise((resolve) => {
    if (!socket?.connected) {
      resolve({ ok: false, error: 'NETWORK' });
      return;
    }
    (socket.timeout(timeoutMs) as any).emit(event, payload, (err: Error | null, res: Ack<T>) => {
      resolve(err ? { ok: false, error: 'TIMEOUT' } : res);
    });
  });
}

/** Emits without waiting for a reply (relayed voice frames); dropped while offline. */
export function send(event: keyof ClientToServer, payload: object): void {
  if (socket?.connected) (socket as any).emit(event, payload);
}

/** Coming back online or to the foreground: reconnect right away instead of waiting for backoff. */
export function installNetworkListeners(onResume: () => void): void {
  const kick = () => {
    if (socket && !socket.connected && !intentionalClose) socket.connect();
  };
  window.addEventListener('online', kick);
  window.addEventListener('offline', () => socket && !intentionalClose && banner(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (socket?.connected) onResume();
    else kick();
  });
}
