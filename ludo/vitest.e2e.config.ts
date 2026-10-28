import { defineConfig } from 'vitest/config';

// Browser smoke tests (npm run test:e2e): one file at a time, they each start Chrome and a server.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
