import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['src/tests/setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run may download / start the mongod binary
    fileParallelism: false, // one in-memory mongod shared across files
  },
});
