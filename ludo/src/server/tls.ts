import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export interface TlsMaterial {
  key: string;
  cert: string;
  /** True for a configured certificate (mkcert, Let's Encrypt); false for the generated one. */
  trusted: boolean;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out.sort();
}

interface CertMeta {
  ips: string[];
}

/**
 * Loads the configured certificate, or creates (and caches) a self-signed one whose SANs
 * cover localhost and every LAN IPv4 address. It is regenerated when the LAN IPs change.
 */
export async function loadTls(opts: {
  certPath?: string;
  keyPath?: string;
  autoSelfSigned: boolean;
  certDir: string;
  ips?: string[];
}): Promise<TlsMaterial> {
  if (opts.certPath && opts.keyPath) {
    return { cert: readFileSync(opts.certPath, 'utf8'), key: readFileSync(opts.keyPath, 'utf8'), trusted: true };
  }
  if (!opts.autoSelfSigned) {
    throw new Error('HTTPS is enabled but no certificate is configured. Set https.certPath/keyPath, enable https.autoSelfSigned, or disable https.');
  }
  const ips = ['127.0.0.1', ...(opts.ips ?? lanAddresses())];
  const certFile = join(opts.certDir, 'selfsigned.crt');
  const keyFile = join(opts.certDir, 'selfsigned.key');
  const metaFile = join(opts.certDir, 'selfsigned.json');
  if (existsSync(certFile) && existsSync(keyFile) && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as CertMeta;
    if (JSON.stringify(meta.ips) === JSON.stringify(ips)) {
      return { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8'), trusted: false };
    }
  }
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 2);
  const pems = await generate([{ name: 'commonName', value: 'Ludo LAN server' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7 as const, ip }))],
      },
    ],
  });
  mkdirSync(opts.certDir, { recursive: true });
  writeFileSync(keyFile, pems.private, { mode: 0o600 });
  writeFileSync(certFile, pems.cert);
  writeFileSync(metaFile, JSON.stringify({ ips } satisfies CertMeta));
  return { cert: pems.cert, key: pems.private, trusted: false };
}
