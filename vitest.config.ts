import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the repo has two genuinely different runtimes.
 *
 * ── Why `projects` and not a single flat config ──────────────────────────────
 *
 * The old flat config had three structural holes that all came from treating
 * web-ui as "just another package":
 *
 *   1. `include` only matched `.ts` — so **component tests were never even
 *      collected**. A `.test.tsx` file added to the repo would sit there being
 *      green-by-absence.
 *   2. `coverage.exclude` listed `packages/web-ui/**` — the entire frontend was
 *      outside the denominator, so nothing in CI could ever complain about it.
 *   3. No DOM environment existed (no jsdom, no happy-dom), so component tests
 *      could only run via hand-rolled `vi.hoisted(() => globalThis.window = …)`
 *      stubs — see `packages/web-ui/src/pages/ChatComponents.test.ts`.
 *
 * Splitting the projects fixes all three at the root instead of per-file:
 *
 *   • `node`   — every backend package, environment `node`, strict coverage.
 *   • `web-ui` — the frontend, environment `happy-dom`.
 *
 * ── Coverage precedence in Vitest 4 (measured, 2026-09-19) ───────────────────
 *
 * Read this before "simplifying" the layout — getting it wrong produces a
 * **silently decorative gate**, which is worse than no gate at all.
 *
 *   1. The coverage block in *this* file (root) is the only one that survives a
 *      `--project X --coverage` run. A `coverage` block nested inside
 *      `test.projects[].test` is **ignored without warning**.
 *   2. Therefore root `include`/`exclude` become the denominator for **every**
 *      project run. That is fine for the backend (this root block is the backend
 *      gate), but catastrophic for the frontend: root `exclude` drops
 *      `packages/web-ui/**`, so `--project web-ui --coverage` used to report on
 *      292 *backend* files, none of which the frontend tests execute.
 *      Measured symptom: `0/49045 statements = 0.00%` while 481 frontend tests
 *      passed. That number looked like "frontend coverage collapsed to zero" —
 *      it was simply **the wrong denominator**.
 *   3. CLI overrides (`--coverage.include=…`) do not reliably change this,
 *      because `include`/`exclude` semantics interact with the root config.
 *
 * So the frontend gate lives in its **own config file**
 * (`vitest.web-ui.coverage.config.ts`, run by `pnpm test:coverage:web-ui`),
 * which has no root coverage block to fight with.
 *
 * ⚠️ Do NOT add a `coverage` block to the web-ui project below. It will be
 * ignored, and it will look correct to every reviewer.
 *
 * ── Why the coverage floors are not simply "80 everywhere" ───────────────────
 *
 * The backend genuinely sits above 75/65/78/80. The frontend does not — it is a
 * ~27k-statement app whose logic-heavy parts (hooks, managers, pure helpers) are
 * tested while its 2k-line render components are not. Real measured frontend
 * coverage (2026-09-19, 481 tests, whole `src` in the denominator):
 *   6.06 st / 4.66 br / 4.69 fn / 6.60 ln
 *
 * Those numbers are low but *honest* — and the floor is *ratcheted* rather than
 * aspirational, so it can only go up: see `scripts/check-coverage-ratchet.mjs`
 * and `coverage-baseline.json`.
 */
export default defineConfig({
  test: {
    // ── backend coverage gate (root-level = the only level that works) ──────
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/node',
      reporter: ['text-summary', 'json-summary', 'lcov'],
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

    projects: [
      // ── backend ─────────────────────────────────────────────────────────────
      {
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          setupFiles: ['./vitest.setup.ts'],
          include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'packages/web-ui/**'],
          testTimeout: 10000,
        },
      },

      // ── frontend ────────────────────────────────────────────────────────────
      {
        test: {
          name: 'web-ui',
          globals: true,
          environment: 'happy-dom',
          setupFiles: ['./vitest.web-ui.setup.ts'],
          include: ['packages/web-ui/**/*.test.ts', 'packages/web-ui/**/*.test.tsx'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 10000,
          // 前端覆盖率**不在这里**配置 —— 见文件顶部的优先级说明。
          // 前端门禁：vitest.web-ui.coverage.config.ts（pnpm test:coverage:web-ui）
        },
      },
    ],
  },
});
