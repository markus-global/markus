import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    testTimeout: 10000,
  },
});
