import { KEYS, storage } from './storage.js';

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public retryAfterSec?: number,
  ) {
    super(code);
  }
}

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const device = storage.get(KEYS.device);
  const session = storage.get(KEYS.session);
  if (device) headers['X-Device-Token'] = device;
  if (session) headers.Authorization = `Bearer ${session}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError('NETWORK', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number };
  if (!res.ok) throw new ApiError(data.error ?? 'HTTP_' + res.status, res.status, data.retryAfterSec);
  return data as T;
}
