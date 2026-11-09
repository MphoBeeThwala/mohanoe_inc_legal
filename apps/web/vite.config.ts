/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const apiTarget = process.env.API_URL || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Bundle the shared package from source (it is published as CommonJS
    // for the API, which Rollup cannot tree-shake).
    alias: {
      '@ahava88/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 3000,
    // Same-origin API in development, matching production where the API
    // serves the built app.
    proxy: {
      '/api': apiTarget,
      '/health': apiTarget,
      '/ready': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
