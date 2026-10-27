import express from 'express';
import type { Ctx } from './context.js';
import { AppError } from './errors.js';

function idParam(raw: string | string[] | undefined): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('NOT_FOUND', 404);
  return id;
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
    ctx.lobbies.renameUser(id, user.username);
    ctx.games.renameUser(id, user.username);
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
    const id = req.params.id;
    if (typeof id !== 'string' || id.length > 64) throw new AppError('LOBBY_NOT_FOUND', 404);
    ctx.lobbies.closeByAdmin(id);
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
