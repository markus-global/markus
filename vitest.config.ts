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
 *   • `web-ui` — the frontend, environment `happy-dom`, its own coverage budget.
 *
 * ⚠️ ── Coverage MUST live at the root, not inside a project ──────────────────
 *
 * This is not a style choice — it is a Vitest 4 constraint that is easy to get
 * wrong, and getting it wrong produces a **silently decorative gate**:
 *
 *   Vitest resolves coverage from the ROOT `test.coverage` only. A `coverage`
 *   block nested inside `test.projects[].test` is **ignored without warning**.
 *   Measured symptom (this repo, 2026-09-19): with per-project `reportsDirectory`
 *   configured, `npx vitest run --project web-ui --coverage` still wrote its
 *   report to `./coverage/` (the root default) using the root default reporters
 *   (`text` + `html` + `clover` + `json`) — the project's `reporter:
 *   ['text-summary','json-summary','lcov']` never appeared. Thresholds set at
 *   project level therefore never fire, and `coverage-summary.json` (which the
 *   ratchet reads) is never written where you expect it.
 *
 * So: root `test.coverage` defines the BACKEND gate (the strict one, it can hold
 * 75/65/78/80). The FRONTEND gate is a second invocation with explicit CLI
 * overrides — see the `test:coverage:web-ui` script in package.json — because a
 * single root config cannot hold two different denominators without either
 * failing CI or dragging the backend floor down to meet the frontend.
 *
 * ── Why the coverage floors are not simply "80 everywhere" ───────────────────
 *
 * The backend genuinely sits above 75/65/78/80. The frontend does not — it is a
 * ~40k-LOC app whose logic-heavy parts (hooks, managers, pure helpers) are
 * tested while its 2k-line render components are not (measured 2026-09-19:
 * 29.9 st / 25.0 br / 24.1 fn / 31.5 ln over 481 tests). The web-ui floor is
 * *ratcheted* up deliberately instead of being aspirational — see
 * `scripts/check-coverage-ratchet.mjs` and `coverage-baseline.json`.
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
          // 前端覆盖率的分母必须在这里定义（而不是根级 coverage）。
          // 根级 coverage.include/exclude 会同时套用到两个 project，而后端门禁
          // 必须把 web-ui 排除在外；两种分母无法共用一个根级配置。
          // 实测：把这段挪到根级后，web-ui 门禁收集到 0 个命中文件 → 0%（假绿）。
          coverage: {
            provider: 'v8',
            include: ['packages/web-ui/src/**'],
            exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', '**/*.tsbuildinfo'],
            all: true,
          },
        },
      },
    ],
  },
});
