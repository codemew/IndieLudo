import express, { type NextFunction, type Request, type Response } from 'express';
import { adminRouter } from './admin.js';
import type { Ctx } from './context.js';
import { AppError } from './errors.js';
import { safeEqual } from './lobbies.js';
import { RateLimiter } from './rateLimit.js';
import type { Device, ResolvedSession } from './sessions.js';

export const DEVICE_COOKIE = 'ludo_device';
const DEVICE_COOKIE_MAX_AGE = 10 * 365 * 24 * 3600;

export interface ApiOptions {
  /** Every gate attempt is answered after the same delay, right or wrong. */
  gateDelayMs?: number;
}

interface Locals {
  device?: Device;
  deviceToken?: string;
  deviceFromCookieOnly?: boolean;
  auth?: ResolvedSession;
}

function locals(res: Response): Locals {
  return res.locals as Locals;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setDeviceCookie(req: Request, res: Response, token: string): void {
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE * 1000,
  });
}

export function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function apiRouter(ctx: Ctx, opts: ApiOptions = {}): express.Router {
  const api = express.Router();
  const gateDelayMs = opts.gateDelayMs ?? 300;
  const signupLimiter = new RateLimiter(10, 60_000);
  const adminLoginLimiter = new RateLimiter(5, 60_000);
  const renameLimiter = new RateLimiter(5, 60_000);

  // Device token from header (localStorage copy) or cookie. Each copy restores the other.
  api.use((req, res, next) => {
    const fromHeader = req.get('x-device-token') || undefined;
    const fromCookie = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    const l = locals(res);
    for (const token of [fromHeader, fromCookie]) {
      const device = token ? ctx.devices.resolve(token) : undefined;
      if (device) {
        l.device = device;
        l.deviceToken = token;
        l.deviceFromCookieOnly = token === fromCookie && token !== fromHeader;
        if (token !== fromCookie) setDeviceCookie(req, res, token!);
        break;
      }
    }
    const auth = ctx.sessions.resolve(bearer(req));
    if (auth) {
      l.auth = auth;
      if (auth.user) ctx.users.touch(auth.user.id);
    }
    next();
  });

  const requireDevice = (_req: Request, res: Response, next: NextFunction) => {
    if (!locals(res).device) throw new AppError('DEVICE_NOT_VERIFIED', 401);
    next();
  };

  // ---- Reachable before the gate ----

  api.get('/gate/status', (_req, res) => {
    const l = locals(res);
    // Hand the token back only when the page lost its localStorage copy.
    res.json({ verified: Boolean(l.device), deviceToken: l.deviceFromCookieOnly ? l.deviceToken : undefined });
  });

  api.post('/gate/verify', async (req, res) => {
    const started = Date.now();
    const result = ctx.gate.verify(req.body?.code, req.ip ?? '');
    await sleep(Math.max(0, gateDelayMs - (Date.now() - started)));
    if (!result.ok) {
      if (result.retryAfterSec) res.set('Retry-After', String(result.retryAfterSec));
      res.status(result.retryAfterSec ? 429 : 401).json({ error: 'INVALID_CODE', retryAfterSec: result.retryAfterSec });
      return;
    }
    const { token } = ctx.devices.create(req.get('user-agent') ?? '', req.ip ?? '');
    setDeviceCookie(req, res, token);
    res.json({ deviceToken: token });
  });

  // ---- Verified device, no session yet ----

  api.post('/users', requireDevice, (req, res) => {
    if (!signupLimiter.hit(req.ip ?? '')) throw new AppError('RATE_LIMITED', 429);
    const user = ctx.users.create(req.body?.username);
    const { token } = ctx.sessions.create({ userId: user.id, deviceId: locals(res).device!.id, userAgent: req.get('user-agent') });
    res.status(201).json({ token, user: { id: user.id, username: user.username } });
  });

  api.post('/admin/login', requireDevice, (req, res) => {
    if (!adminLoginLimiter.hit(req.ip ?? '')) throw new AppError('RATE_LIMITED', 429);
    const password = req.body?.password;
    if (typeof password !== 'string' || !safeEqual(password, ctx.config.adminPassword)) throw new AppError('WRONG_PASSWORD', 403);
    const l = locals(res);
    // A signed-in player is elevated in place; otherwise an admin-only session is issued.
    if (l.auth) {
      ctx.sessions.setAdmin(l.auth.session.id, true);
      res.json({ token: bearer(req) });
      return;
    }
    const { token } = ctx.sessions.create({ userId: null, deviceId: l.device!.id, isAdmin: true, userAgent: req.get('user-agent') });
    res.json({ token });
  });

  // ---- Everything below needs a session ----

  api.use((_req, res, next) => {
    if (!locals(res).auth) throw new AppError('UNAUTHORIZED', 401);
    next();
  });

  api.get('/me', (_req, res) => {
    const { user, isAdmin } = locals(res).auth!;
    res.json({ user: user && { id: user.id, username: user.username, gamesPlayed: user.games_played, wins: user.wins }, isAdmin });
  });

  // Players rename themselves; lobbies and games in progress show the new name right away.
  api.patch('/me', (req, res) => {
    const { user } = locals(res).auth!;
    if (!user) throw new AppError('NOT_FOUND', 404);
    if (!renameLimiter.hit(String(user.id))) throw new AppError('RATE_LIMITED', 429);
    const renamed = ctx.users.rename(user.id, req.body?.username);
    ctx.lobbies.renameUser(user.id, renamed.username);
    ctx.games.renameUser(user.id, renamed.username);
    res.json({ user: { id: renamed.id, username: renamed.username, gamesPlayed: renamed.games_played, wins: renamed.wins } });
  });

  api.post('/logout', (_req, res) => {
    const { session } = locals(res).auth!;
    ctx.sessions.revoke(session.id);
    ctx.kickSessions([session.id]);
    res.json({ ok: true });
  });

  api.post('/admin/logout', (_req, res) => {
    const { session, user } = locals(res).auth!;
    if (user) ctx.sessions.setAdmin(session.id, false);
    else ctx.sessions.revoke(session.id);
    res.json({ ok: true });
  });

  api.use('/admin', (_req, res, next) => {
    if (!locals(res).auth!.isAdmin) throw new AppError('FORBIDDEN', 403);
    next();
  });
  api.use('/admin', adminRouter(ctx));

  api.use((_req, _res) => {
    throw new AppError('NOT_FOUND', 404);
  });

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'BAD_JSON' });
      return;
    }
    console.error('[api]', err);
    res.status(500).json({ error: 'INTERNAL' });
  });

  return api;
}
