import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { codeBanner } from './gate.js';
import { startServer } from './server.js';
import { lanAddresses } from './tls.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const config = loadConfig();

const server = await startServer(config, {
  onGateRotate: (code, reason) => {
    if (reason === 'brute-force') console.warn('\n[gate] WARNING: too many wrong access codes from many clients; the code was rotated.');
    console.log(`\n${codeBanner(code)}\n`);
  },
});

const scheme = server.secure ? 'https' : 'http';
const portSuffix = (server.secure && server.port === 443) || (!server.secure && server.port === 80) ? '' : `:${server.port}`;
console.log(`\nLudo v${version} is running. Open on your phones:`);
for (const host of ['localhost', ...lanAddresses()]) console.log(`  ${scheme}://${host}${portSuffix}`);
if (server.redirectPort) console.log(`  (http on :${server.redirectPort} redirects to https)`);
if (server.tls && !server.tls.trusted) {
  console.log('\nUsing a self-signed certificate: phones will warn once; tap "Advanced" → "Proceed".');
  console.log('For warning-free HTTPS run: npm run cert:mkcert');
}
console.log(`\n${codeBanner(server.ctx.gate.current)}\n`);

if (process.stdin.isTTY) {
  console.log('Commands: "code" shows the access code, "rotate" makes a new one, "quit" stops the server.');
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'code') console.log(`\n${codeBanner(server.ctx.gate.current)}\n`);
    else if (cmd === 'rotate') server.ctx.gate.rotate('manual');
    else if (cmd === 'quit' || cmd === 'exit') shutdown();
    else if (cmd) console.log('Unknown command. Try: code, rotate, quit');
  });
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
