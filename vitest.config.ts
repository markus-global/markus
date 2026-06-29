import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/web-ui/**',
        'packages/gui/**',
        'packages/chrome-extension/**',
        'packages/remote/**',
        'packages/cli/src/tray.ts',
        'packages/cli/src/gui.ts',
        'packages/core/src/tools/gui.ts',
        'packages/core/src/tools/chrome-dialog-clicker.ts',
        '**/dist/**',
        '**/node_modules/**',
      ],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 78,
        lines: 80,
      },
    },
  },
});
