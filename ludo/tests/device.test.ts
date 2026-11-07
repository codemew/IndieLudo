import { describe, expect, it } from 'vitest';
import { clean, describeDevice, withMaker } from '../src/server/device.js';

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  samsungOld:
    'Mozilla/5.0 (Linux; Android 11; SM-A515F Build/RP1A.200720.012) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  webview:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
};

describe('what phone and browser a player is on', () => {
  it('from the user agent alone', () => {
    expect(describeDevice(UA.samsungOld)).toEqual({ model: 'Samsung SM-A515F', os: 'Android 11', browser: 'Samsung Internet 23' });
    expect(describeDevice(UA.iphone)).toEqual({ model: 'iPhone', os: 'iOS 17.5', browser: 'Safari 17.5' });
    expect(describeDevice(UA.chromeIos)).toEqual({ model: 'iPhone', os: 'iOS 18', browser: 'Chrome 130' });
    expect(describeDevice(UA.firefoxAndroid)).toEqual({ model: '', os: 'Android 14', browser: 'Firefox 131' });
    expect(describeDevice(UA.edgeWindows)).toEqual({ model: '', os: 'Windows', browser: 'Edge 130' });
    expect(describeDevice(UA.webview)).toEqual({ model: 'Pixel 7', os: 'Android 13', browser: 'Android WebView 129' });
    expect(describeDevice(UA.ipad)).toEqual({ model: 'iPad', os: 'iPadOS 16.6', browser: 'Safari 16.6' });
  });

  it("Chrome's frozen model (K) and Android version are replaced by the client hints", () => {
    expect(describeDevice(UA.chromeAndroid)).toEqual({ model: '', os: 'Android 10', browser: 'Chrome 130' });
    expect(
      describeDevice(UA.chromeAndroid, {
        model: 'SM-S918B',
        platform: 'Android',
        platformVersion: '14.0.0',
        brand: 'Google Chrome',
        brandVersion: '130.0.6723.58',
      }),
    ).toEqual({
      model: 'Samsung SM-S918B',
      os: 'Android 14',
      browser: 'Chrome 130',
    });
    expect(
      describeDevice(UA.chromeAndroid, { model: 'Pixel 8', platform: 'Android', platformVersion: '15', brand: 'Brave', brandVersion: '1.71.118' }).model,
    ).toBe('Pixel 8');
  });

  it('Windows 11 from the platform version; macOS with its real version', () => {
    expect(describeDevice(UA.edgeWindows, { platform: 'Windows', platformVersion: '15.0.0', brand: 'Microsoft Edge', brandVersion: '130.0.2849.68' })).toEqual({
      model: '',
      os: 'Windows 11',
      browser: 'Edge 130',
    });
    expect(describeDevice(UA.edgeWindows, { platform: 'Windows', platformVersion: '10.0.0' }).os).toBe('Windows 10');
    expect(
      describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36', { platform: 'macOS', platformVersion: '14.5.0' }).os,
    ).toBe('macOS 14.5');
  });

  it('names the maker of bare model codes, and keeps hostile or huge input short and plain', () => {
    expect(withMaker('RMX3085')).toBe('realme RMX3085');
    expect(withMaker('CPH2381')).toBe('OPPO CPH2381');
    expect(withMaker('Redmi Note 12')).toBe('Redmi Note 12');
    expect(clean('<b>hi</b>\u0000‮')).toBe('<b>hi</b>');
    const d = describeDevice('x'.repeat(5000), { model: 'M'.repeat(500), brand: 'B'.repeat(500), brandVersion: '1' });
    expect(d.model.length).toBeLessThanOrEqual(40);
    expect(d.browser.length).toBeLessThanOrEqual(32);
    expect(describeDevice(undefined as unknown as string)).toEqual({ model: '', os: '', browser: '' });
  });
});
