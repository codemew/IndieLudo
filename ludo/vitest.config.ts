import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Set by Vite in real builds (vite.config.ts); the client code shows it.
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    // npm run test:coverage: fails if line coverage drops below these.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The process entry point (listens on real ports, handles signals) and type declarations.
      exclude: ['src/server/index.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        lines: 80,
        'src/shared/**': { lines: 95 },
        'src/server/**': { lines: 95 },
      },
    },
  },
});
