import { defineConfig } from 'vitest/config';

// `npm run eval -w apps/api`: the research evaluation set against the
// configured model (AI_PROVIDER...). Not part of `npm test`: it calls a real
// model and costs tokens.
export default defineConfig({
  test: {
    include: ['src/eval/**/*.eval.ts'],
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
