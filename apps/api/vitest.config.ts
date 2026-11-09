import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    // PGlite boots a Postgres engine per file; give it time on slow CI.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Each test file gets a fresh module registry, so files that change
    // process.env before importing a service stay isolated.
    isolate: true,
  },
});
