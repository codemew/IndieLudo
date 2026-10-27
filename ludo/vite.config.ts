import { defineConfig } from 'vite';
import { loadTls } from './src/server/tls.ts';

// Dev server: HTTPS with its own self-signed cert, proxying the API and sockets to the backend.
export default defineConfig(async ({ command }) => {
  const backend = process.env.LUDO_BACKEND ?? 'https://localhost:3443';
  let https: { key: string; cert: string } | undefined;
  if (command === 'serve') {
    const tls = await loadTls({ autoSelfSigned: true, certDir: './data/certs/vite' });
    https = { key: tls.key, cert: tls.cert };
  }
  return {
    root: 'src/client',
    publicDir: 'public',
    build: { outDir: '../../dist/client', emptyOutDir: true, target: 'es2020' },
    server: {
      host: true,
      port: 5173,
      https,
      proxy: {
        '/api': { target: backend, secure: false },
        '/socket.io': { target: backend, ws: true, secure: false },
      },
    },
  };
});
