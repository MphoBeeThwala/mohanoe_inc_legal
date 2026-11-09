import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Each test file gets a fresh module registry, so files that change
    // process.env before importing a service stay isolated.
    isolate: true,
  },
});
