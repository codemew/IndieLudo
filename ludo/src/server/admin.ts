import express from 'express';
import type { Ctx } from './context.js';
import { AppError } from './errors.js';

function idParam(raw: string | string[] | undefined): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('NOT_FOUND', 404);
  return id;
}

function lobbyParam(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string' || raw.length > 64) throw new AppError('LOBBY_NOT_FOUND', 404);
  return raw;
}

/** Admin-only routes. The caller has already checked the admin session server-side. */
export function adminRouter(ctx: Ctx): express.Router {
  const r = express.Router();

  r.get('/users', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 32) : '';
    res.json(ctx.users.list(q));
  });

  r.patch('/users/:id', (req, res) => {
    const id = idParam(req.params.id);
    const user = ctx.users.rename(id, req.body?.username);
    ctx.lobbies.updateUser(id, user);
    ctx.games.updateUser(id, user);
    ctx.refreshPresence();
    res.json(user);
  });

  r.delete('/users/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (!ctx.users.get(id)) throw new AppError('NOT_FOUND', 404);
    // Leave lobbies first: a running game hands the seat to a bot.
    ctx.lobbies.leave(id);
    ctx.kickUser(id);
    ctx.users.delete(id);
    res.json({ ok: true });
  });

  // Resets: a player's wins and games played, everyone's, and the match history.
  r.post('/users/:id/reset-stats', (req, res) => {
    ctx.users.resetStats(idParam(req.params.id));
    res.json({ ok: true });
  });

  r.post('/stats/reset', (_req, res) => {
    res.json({ ok: true, users: ctx.users.resetStats() });
  });

  r.delete('/history/:id', (req, res) => {
    const id = String(req.params.id);
    if (id.length > 64 || !ctx.history.delete(id)) throw new AppError('NO_GAME', 404);
    res.json({ ok: true });
  });

  r.delete('/history', (_req, res) => {
    res.json({ ok: true, matches: ctx.history.deleteAll() });
  });

  r.get('/sessions', (_req, res) => {
    res.json(ctx.sessions.list());
  });

  r.delete('/sessions/:id', (req, res) => {
    const session = ctx.sessions.revoke(idParam(req.params.id));
    ctx.kickSessions([session.id]);
    res.json({ ok: true });
  });

  r.get('/devices', (_req, res) => {
    res.json(ctx.devices.list());
  });

  r.delete('/devices/:id', (req, res) => {
    const id = idParam(req.params.id);
    const sessionIds = ctx.sessions.idsForDevice(id);
    ctx.devices.revoke(id);
    ctx.kickSessions(sessionIds);
    res.json({ ok: true });
  });

  r.get('/lobbies', (_req, res) => {
    res.json(ctx.lobbies.adminList());
  });

  r.delete('/lobbies/:id', (req, res) => {
    ctx.lobbies.closeByAdmin(lobbyParam(req.params.id));
    res.json({ ok: true });
  });

  // A new join password for a lobby: who is in it stays, new joiners need the new one.
  r.patch('/lobbies/:id', (req, res) => {
    ctx.lobbies.setPasswordByAdmin(lobbyParam(req.params.id), req.body?.password);
    res.json({ ok: true });
  });

  // The creation password (from the config, or set here) and the accounts that may create without it.
  r.get('/create-access', (_req, res) => {
    res.json({ source: ctx.hosts.source(), hosts: ctx.hosts.list() });
  });

  // A new creation password; `null` goes back to the config's. Either way every remembered account is forgotten.
  r.put('/create-password', (req, res) => {
    const password = req.body?.password;
    if (password === null) ctx.hosts.useConfig();
    else ctx.hosts.set(password);
    res.json({ source: ctx.hosts.source(), hosts: ctx.hosts.list() });
  });

  r.delete('/create-access/:id', (req, res) => {
    ctx.hosts.revoke(idParam(req.params.id));
    res.json({ ok: true });
  });

  r.get('/code', (_req, res) => {
    res.json({ code: ctx.gate.current });
  });

  r.post('/code/rotate', (_req, res) => {
    res.json({ code: ctx.gate.rotate('manual') });
  });

  return r;
}
