import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { RequestHandler } from 'express';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * Serves the built JavaScript and CSS compressed: brotli where the browser takes it, gzip
 * otherwise (about a quarter of the size). Built files never change under the same name, so
 * each is compressed once, on first request, and kept. Anything else falls through to
 * express.static.
 */
export function compressedAssets(dir: string): RequestHandler {
  const cache = new Map<string, { br: Buffer; gz: Buffer }>();
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const type = TYPES[extname(req.path)];
    const accepts = String(req.headers['accept-encoding'] ?? '');
    const encoding = /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null;
    if (!type || !encoding) return next();
    const file = normalize(join(dir, decodeURIComponent(req.path)));
    if (!file.startsWith(dir + sep)) return next();
    let entry = cache.get(file);
    if (!entry) {
      try {
        if (!statSync(file).isFile()) return next();
      } catch {
        return next();
      }
      const raw = readFileSync(file);
      entry = {
        br: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
        gz: gzipSync(raw, { level: 9 }),
      };
      cache.set(file, entry);
    }
    const body = encoding === 'br' ? entry.br : entry.gz;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', body.length);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
