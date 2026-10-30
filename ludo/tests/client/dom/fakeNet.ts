/** Stands in for src/client/net.ts: records what the client sends and answers from `replies`. */
import { vi } from 'vitest';
import type { Ack } from '../../../src/shared/protocol.js';

export const sent: [string, any][] = [];
export const replies: Record<string, (payload: any) => Ack<any>> = {};
export const sendSpy = vi.fn();

export const emit = vi.fn(async (event: string, payload: any) => {
  sent.push([event, payload]);
  return replies[event]?.(payload) ?? { ok: true };
});
export const send = sendSpy;
export const onNetworkChange = vi.fn(() => () => {});
export const probe = vi.fn(async () => true);
export const reconnectNow = vi.fn();
export const transportName = vi.fn(() => 'websocket');
export const connect = vi.fn();
export const disconnect = vi.fn();
export const isConnected = vi.fn(() => true);
export const installNetworkListeners = vi.fn();

/** Events sent with this name, newest last. */
export const sentOf = (event: string) => sent.filter(([e]) => e === event).map(([, p]) => p);
export function resetNet(): void {
  sent.length = 0;
  for (const k of Object.keys(replies)) delete replies[k];
}
