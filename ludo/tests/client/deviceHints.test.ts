import { describe, expect, it } from 'vitest';
import { deviceHints } from '../../src/client/deviceHints.js';

const nav = (userAgentData: unknown) => ({ userAgentData }) as unknown as Navigator;

describe("the phone's client hints, sent to the server for the Users tab", () => {
  it("Chrome on Android: the real model and Android version, and the browser's own name over Chromium's", async () => {
    const info = await deviceHints(
      nav({
        platform: 'Android',
        getHighEntropyValues: async (asked: string[]) => {
          expect(asked).toEqual(['model', 'platformVersion', 'fullVersionList']);
          return {
            model: 'SM-S918B',
            platform: 'Android',
            platformVersion: '14.0.0',
            fullVersionList: [
              { brand: 'Not)A;Brand', version: '99.0.0.0' },
              { brand: 'Chromium', version: '130.0.6723.58' },
              { brand: 'Google Chrome', version: '130.0.6723.58' },
            ],
          };
        },
      }),
    );
    expect(info).toEqual({ model: 'SM-S918B', platform: 'Android', platformVersion: '14.0.0', brand: 'Google Chrome', brandVersion: '130.0.6723.58' });
  });

  it('falls back to the low-entropy brands; drops empty values and trims long ones to what the server takes', async () => {
    const info = await deviceHints(
      nav({
        platform: 'Windows',
        brands: [{ brand: 'Chromium', version: '130' }],
        getHighEntropyValues: async () => ({ model: '  ', platformVersion: '15.0.0'.padEnd(80, '0') }),
      }),
    );
    expect(info).toEqual({ platform: 'Windows', platformVersion: '15.0.0'.padEnd(32, '0'), brand: 'Chromium', brandVersion: '130' });
  });

  it('Safari and Firefox have no hints, and a browser that refuses them gives nothing: the server reads the user agent', async () => {
    expect(await deviceHints(nav(undefined))).toEqual({});
    expect(await deviceHints(nav({ brands: [] }))).toEqual({});
    expect(
      await deviceHints(
        nav({
          getHighEntropyValues: async () => {
            throw new Error('NotAllowedError');
          },
        }),
      ),
    ).toEqual({});
  });
});
