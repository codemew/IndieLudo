import { MAX_SPECTATORS, type Color } from '../shared/types.js';
import { play } from './sound.js';

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const lastHtml = new WeakMap<Element, string>();

/**
 * Sets innerHTML only when it differs from what was last set here. Screens that redraw on every
 * update (pings every few seconds, voice changes, game updates) then leave unchanged parts
 * alone: no replayed animations, no buttons swapped out mid-tap.
 */
export function setHtml(target: Element, html: string): void {
  if (lastHtml.get(target) === html) return;
  lastHtml.set(target, html);
  target.innerHTML = html;
}

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export function $<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  return root.querySelector(sel) as T;
}

/** Inline SVG icons (emoji like ⛶ are missing from many phone fonts). */
export const ICONS = {
  expand:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  collapse:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.5 2.6M12 18v3M3 3l18 18"/></svg>',
  headset:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  headsetOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 12.5-6.6M19.5 9.5A8 8 0 0 1 20 12v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/></svg>',
  rejoin:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
};

export const COLOR_NAME: Record<Color, string> = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue', purple: 'Purple', orange: 'Orange' };

const ERRORS: Record<string, string> = {
  NETWORK: 'No connection. Check your internet.',
  TIMEOUT: 'The server did not answer. Try again.',
  INVALID_CODE: 'That code is not right.',
  INVALID_USERNAME: 'Use 3–16 letters, numbers or _.',
  USERNAME_RESERVED: 'That name is reserved. Pick another.',
  USERNAME_TAKEN: 'That name is taken.',
  INVALID_AVATAR: 'That avatar is not available.',
  NOTHING_TO_CHANGE: 'Nothing to change.',
  DEVICE_NOT_VERIFIED: 'This device needs the access code first.',
  WRONG_PASSWORD: 'Wrong admin password.',
  WRONG_CREATE_PASSWORD: 'Wrong lobby creation password.',
  WRONG_LOBBY_PASSWORD: 'Wrong lobby password.',
  LOBBY_NOT_FOUND: 'That lobby no longer exists.',
  LOBBY_FULL: 'The lobby is full.',
  TOO_MANY_WATCHING: `Already ${MAX_SPECTATORS} people watching.`,
  NOT_SEATED: 'Take a seat first.',
  ALREADY_OUT: "You're already out of this game.",
  NOT_WATCHING: 'You already have a seat.',
  GAME_IN_PROGRESS: 'The game has already started.',
  ALREADY_IN_GAME: 'Finish or leave your current game first.',
  TOO_MANY_LOBBIES: 'Too many lobbies right now. Try later.',
  COLOR_TAKEN: 'That colour is taken.',
  NOT_HOST: 'Only the host can do that.',
  NOT_ENOUGH_PLAYERS: 'Need at least 2 players.',
  NOT_ALL_READY: 'Everyone must be ready.',
  NOT_YOUR_TURN: 'Not your turn.',
  WRONG_PHASE: 'Not now.',
  ILLEGAL_MOVE: 'That move is not allowed.',
  RATE_LIMITED: 'Slow down a little.',
  INVALID_NAME: 'Give the lobby a name.',
  PASSWORD_REQUIRED: 'Set a lobby password.',
  MIC_DENIED: 'Microphone access is blocked. Allow it for this site in your browser settings.',
  NO_MIC_SUPPORT: "This browser can't do voice chat.",
  NOT_IN_VOICE: 'Join the voice chat first.',
  NOT_IN_GAME: 'Only players in this game can use its voice chat.',
  INVALID_BITRATE: 'Pick 6, 12, 24 or 48 kbps.',
  VOICE_DISABLED: 'The host turned voice chat off.',
  SEAT_EMPTY: 'That seat is free now: just tap it to move there.',
  SAME_SEAT: "That's your own seat.",
  SWAP_EXPIRED: 'That swap request is no longer valid.',
  TEAMS_NEED_FOUR: 'Team-up needs the 4-player board with all 4 seats filled: add bots to the open ones.',
  TOO_MANY_PLAYERS: 'Too many players for that board: someone has to watch or leave first.',
  NOT_HOME: 'Only tokens that are home can make a wildcard entry.',
  NO_LAPS_LEFT: 'That token has had its extra lap already.',
  SURRENDERED: "You've surrendered.",
  GAME_OVER: 'The game is over.',
  BAD_TOKENS: 'Pick at least one token.',
};

export function errorText(code: string): string {
  return ERRORS[code] ?? `Something went wrong (${code}).`;
}

export function toast(msg: string, kind: 'info' | 'error' | 'success' = 'info', ms = 2200): void {
  const root = document.getElementById('toasts')!;
  const t = el(`<div class="toast toast-${kind}">${esc(msg)}</div>`);
  root.appendChild(t);
  if (kind === 'error') play('error');
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export interface ModalAction {
  label: string;
  kind?: 'primary' | 'danger' | 'ghost';
  /** Return false to keep the modal open. */
  onClick?: () => boolean | void | Promise<boolean | void>;
}

export function modal(opts: { title: string; body: string | HTMLElement; actions: ModalAction[]; onDismiss?: () => void }): {
  close: () => void;
  root: HTMLElement;
} {
  const root = document.getElementById('modal-root')!;
  const wrap = el(`
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${esc(opts.title)}</h2>
        <div class="modal-body"></div>
        <div class="modal-actions"></div>
      </div>
    </div>`);
  const body = $(wrap, '.modal-body');
  if (typeof opts.body === 'string') body.innerHTML = opts.body;
  else body.appendChild(opts.body);
  const close = () => {
    wrap.classList.add('out');
    setTimeout(() => wrap.remove(), 200);
  };
  const actions = $(wrap, '.modal-actions');
  for (const a of opts.actions) {
    const b = el<HTMLButtonElement>(`<button class="btn btn-${a.kind ?? 'ghost'}">${esc(a.label)}</button>`);
    b.onclick = async () => {
      b.disabled = true;
      try {
        const keep = (await a.onClick?.()) === false;
        if (!keep) close();
      } finally {
        b.disabled = false;
      }
    };
    actions.appendChild(b);
  }
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap) {
      close();
      opts.onDismiss?.();
    }
  });
  root.appendChild(wrap);
  ($(wrap, 'input') as HTMLInputElement | null)?.focus();
  return { close, root: wrap };
}

export function confirmDialog(title: string, text: string, confirmLabel = 'Confirm', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    modal({
      title,
      body: `<p>${esc(text)}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
      onDismiss: () => resolve(false),
    });
  });
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
