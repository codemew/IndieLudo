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

/**
 * After a network change: does the game connection still answer within `timeoutMs`? A socket
 * can look connected for up to ~20 s after its network went away (until the heartbeat misses).
 */
export async function probe(timeoutMs = 2500): Promise<boolean> {
  return (await emit('net:probe', {}, timeoutMs)).ok;
}

/** Drops the game connection so it reconnects at once, over whatever network the phone has now. */
export function reconnectNow(): void {
  if (!socket || intentionalClose) return;
  if (socket.connected) socket.io.engine?.close();
  else socket.connect();
}

/** How the game connection runs: "websocket" or "polling" (both over TCP), or null while offline. */
export function transportName(): string | null {
  return socket?.connected ? (socket.io.engine?.transport?.name ?? null) : null;
}

const networkListeners = new Set<() => void>();
/** Called when the phone changes network (Wi-Fi ↔ mobile data, or back online). */
export function onNetworkChange(fn: () => void): () => void {
  networkListeners.add(fn);
  return () => networkListeners.delete(fn);
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
  const changed = () => networkListeners.forEach((fn) => fn());
  window.addEventListener('online', () => {
    kick();
    changed();
  });
  // Android Chrome reports switches between Wi-Fi and mobile data; iOS only online/offline, and
  // there the voice link noticing its route died (voice.ts) does the job.
  (navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener?.('change', changed);
  window.addEventListener('offline', () => socket && !intentionalClose && banner(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (socket?.connected) onResume();
    else kick();
  });
}
