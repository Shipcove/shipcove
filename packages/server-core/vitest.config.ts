import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
    // Les tests d'intégration partagent la base `cap_test` : exécution séquentielle.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
