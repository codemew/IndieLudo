import type { DeviceInfo } from '../shared/protocol.js';

/** navigator.userAgentData, which Chromium browsers have (Safari and Firefox don't). */
interface UaData {
  platform?: string;
  brands?: { brand: string; version: string }[];
  getHighEntropyValues?(
    hints: string[],
  ): Promise<{ model?: string; platform?: string; platformVersion?: string; fullVersionList?: { brand: string; version: string }[] }>;
}

const MAX: Record<keyof DeviceInfo, number> = { model: 64, platform: 32, platformVersion: 32, brand: 48, brandVersion: 32 };

/**
 * This phone's model, system version and browser, from the client hints of Chromium browsers
 * (the user agent of those has a frozen model and Android version). Empty where there are none:
 * the server then goes by the user agent alone.
 */
export async function deviceHints(nav: Navigator = navigator): Promise<DeviceInfo> {
  const ua = (nav as Navigator & { userAgentData?: UaData }).userAgentData;
  if (!ua?.getHighEntropyValues) return {};
  try {
    const v = await ua.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
    const brands = (v.fullVersionList ?? ua.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
    // The browser's own name over the engine's ("Google Chrome", "Samsung Internet", not "Chromium").
    const own = brands.find((b) => b.brand !== 'Chromium') ?? brands[0];
    const info: DeviceInfo = {
      model: v.model,
      platform: v.platform ?? ua.platform,
      platformVersion: v.platformVersion,
      brand: own?.brand,
      brandVersion: own?.version,
    };
    const out: DeviceInfo = {};
    for (const k of Object.keys(MAX) as (keyof DeviceInfo)[]) {
      const s = info[k];
      if (typeof s === 'string' && s.trim()) out[k] = s.trim().slice(0, MAX[k]);
    }
    return out;
  } catch {
    return {};
  }
}
