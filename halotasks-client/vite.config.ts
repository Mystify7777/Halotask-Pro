/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveApiBaseUrl } from './src/config/apiBaseUrl';

/**
 * Fails `vite build` when VITE_API_BASE_URL is missing or invalid.
 *
 * Vite inlines VITE_* values while it bundles, so this is the only point where a missing value can still be
 * caught before it ships. It reads the env Vite itself resolved (.env files and the process environment, e.g.
 * what Vercel injects), which is exactly what gets baked into the bundle. The dev server and Vitest do not run
 * a build, so they keep the localhost default.
 */
const apiBaseUrlGuard = (): Plugin => ({
  name: 'halotask:api-base-url-guard',
  configResolved(config) {
    if (config.command !== 'build') return;
    resolveApiBaseUrl({ value: config.env.VITE_API_BASE_URL, isProduction: true });
  },
});

export default defineConfig({
  plugins: [react(), apiBaseUrlGuard()],
  server: {
    port: 5173
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts']
  }
});
