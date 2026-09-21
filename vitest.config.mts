import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      PUBLIC_DEMO_ACCESS_ENABLED: 'true',
      PUBLIC_DEMO_TENANT_ID: '000000000000000000000001',
    },
    globals: false,
    setupFiles: ['src/tests/setup.ts'],
    include: ['src/**/*.test.ts'],
    // Transaction-heavy assessment flows exercise a single-node replica set and can exceed 30s on
    // a loaded workstation even though their focused runs are fast. A timed-out request can keep
    // unwinding while the next test clears the shared database, producing misleading cascade errors.
    testTimeout: 60_000,
    hookTimeout: 120_000, // first run may download / start the mongod binary
    fileParallelism: false, // one in-memory mongod shared across files
  },
});
