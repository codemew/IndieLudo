/**
 * What phone, system and browser a player is on, for the Users tab: from the browser's user agent,
 * improved with the client hints the phone sends (`device:info`) where the browser has them.
 * Chromium browsers tell the real phone model (e.g. SM-S918B) and Android version through client
 * hints; their user agent has a frozen model ("K"). Safari and Firefox have no client hints: an
 * iPhone is just "iPhone", and Firefox on Android names no model at all.
 */

export interface ClientHints {
  /** navigator.userAgentData model, e.g. "SM-S918B" or "Pixel 8" ('' on desktops). */
  model?: string;
  /** e.g. "Android", "Windows", "macOS". */
  platform?: string;
  /** e.g. "14.0.0" (Android), "15.0.0" (Windows 11). */
  platformVersion?: string;
  /** The browser's own brand, e.g. "Google Chrome", "Samsung Internet". */
  brand?: string;
  /** Its full version, e.g. "130.0.6723.58". */
  brandVersion?: string;
}

export interface DeviceDescription {
  /** The phone (or "iPhone", "iPad"); '' when the browser doesn't say. */
  model: string;
  /** e.g. "Android 14", "iOS 17.5", "Windows 11". */
  os: string;
  /** e.g. "Chrome 130", "Safari 17.5". */
  browser: string;
}

/** Model words that aren't a model: Chrome's frozen "K", Firefox's form factor, the WebView marker. */
const NOT_A_MODEL = /^(k|mobile|tablet|wv|linux|u|tv)$/i;

/** Makers whose model codes don't say whose phone it is. */
const MAKERS: [RegExp, string][] = [
  [/^SM-/i, 'Samsung'],
  [/^RMX\d/i, 'realme'],
  [/^CPH\d/i, 'OPPO'],
  [/^V\d{4}/, 'vivo'],
  [/^(moto|XT\d{4})/i, 'Motorola'],
  [/^(LM-|LG-)/i, 'LG'],
  [/^(ASUS|ASUS_)/i, 'ASUS'],
  [/^(IN|LE|NE|KB|HD|GM|CPH)\d{4}$/i, 'OnePlus'],
];

/** Removes anything that isn't plain printable text, and caps the length. */
export function clean(s: unknown, max = 40): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[^\x20-\x7E -ɏ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const major = (v: string | undefined) => (v ? v.split('.')[0] : '');
const majorMinor = (v: string | undefined) => (v ? v.split('.').slice(0, 2).join('.').replace(/\.0$/, '') : '');

function browserFromUa(ua: string): string {
  const m = (re: RegExp) => re.exec(ua)?.[1];
  let v: string | undefined;
  if ((v = m(/SamsungBrowser\/([\d.]+)/))) return `Samsung Internet ${major(v)}`;
  if ((v = m(/(?:EdgA|EdgiOS|Edg)\/([\d.]+)/))) return `Edge ${major(v)}`;
  if ((v = m(/(?:OPR|OPiOS|OPT)\/([\d.]+)/))) return `Opera ${major(v)}`;
  if ((v = m(/(?:Firefox|FxiOS)\/([\d.]+)/))) return `Firefox ${major(v)}`;
  if ((v = m(/CriOS\/([\d.]+)/))) return `Chrome ${major(v)}`;
  if (/; wv\)/.test(ua) && (v = m(/Chrome\/([\d.]+)/))) return `Android WebView ${major(v)}`;
  if ((v = m(/Chrome\/([\d.]+)/))) return `Chrome ${major(v)}`;
  if ((v = m(/Version\/([\d.]+).*Safari/))) return `Safari ${majorMinor(v)}`;
  return '';
}

function osFromUa(ua: string): string {
  let m: RegExpExecArray | null;
  if ((m = /Android (\d+(?:\.\d+)?)/.exec(ua))) return `Android ${m[1].replace(/\.0$/, '')}`;
  if ((m = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(ua))) return `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${m[1]}${m[2] !== '0' ? '.' + m[2] : ''}`;
  if (/Windows NT 10/.test(ua)) return 'Windows';
  if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) return `Windows NT ${m[1]}`;
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

function modelFromUa(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  const m = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua);
  const model = m?.[1]?.trim() ?? '';
  return model && !NOT_A_MODEL.test(model) ? model : '';
}

/** "SM-S918B" → "Samsung SM-S918B"; names that already say the maker stay as they are. */
export function withMaker(model: string): string {
  if (!model) return '';
  for (const [re, maker] of MAKERS) if (re.test(model)) return `${maker} ${model}`;
  return model;
}

function osFromHints(h: ClientHints, fallback: string): string {
  const p = clean(h.platform, 20);
  const v = clean(h.platformVersion, 20);
  if (!p) return fallback;
  if (p === 'Android') return v ? `Android ${major(v)}` : fallback;
  // Windows reports 13 and up for Windows 11, 1 to 10 for Windows 10.
  if (p === 'Windows') return v ? (Number(major(v)) >= 13 ? 'Windows 11' : 'Windows 10') : fallback;
  if (p === 'macOS') return v ? `macOS ${majorMinor(v)}` : fallback;
  if (p === 'Chrome OS' || p === 'ChromeOS') return 'ChromeOS';
  return fallback || p;
}

function browserFromHints(h: ClientHints, fallback: string): string {
  const brand = clean(h.brand, 30);
  const v = major(clean(h.brandVersion, 30));
  if (!brand || !v) return fallback;
  const name = brand
    .replace(/^Google Chrome$/, 'Chrome')
    .replace(/^Microsoft Edge$/, 'Edge')
    .replace(/^Opera( GX)?$/, 'Opera');
  return `${name} ${v}`;
}

export function describeDevice(ua: string, hints: ClientHints = {}): DeviceDescription {
  const s = typeof ua === 'string' ? ua.slice(0, 512) : '';
  const hintModel = clean(hints.model, 32);
  const model = withMaker(hintModel && !NOT_A_MODEL.test(hintModel) ? hintModel : modelFromUa(s));
  return {
    model: clean(model, 40),
    os: clean(osFromHints(hints, osFromUa(s)), 24),
    browser: clean(browserFromHints(hints, browserFromUa(s)), 32),
  };
}
