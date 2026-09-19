import { defineConfig } from 'vitest/config';

// 前端覆盖率门禁 —— 刻意做成独立配置文件。
//
// ## 为什么不能写进 vitest.config.ts
//
// Vitest 只认「它加载的那个 config 文件」里的 test.coverage。这在本仓库造成一个躲不开的冲突：
//
//   - 后端门禁需要 include 覆盖 packages 下所有 src，同时把 web-ui 排除在外；
//     否则后端的 75/65/78/80 阈值会被前端拉平，失去意义。
//   - 前端门禁需要 include web-ui 的 src —— 而后端那条 exclude 会把前端
//     整个排除掉，结果是这一轮收集到 0 个文件、报告 Unknown% (0/0)。
//     「永远通过的门禁」比没有门禁更糟。
//
// 用命令行 --coverage.include=... 也解决不了：根级 exclude 仍会叠加生效，照样收不到文件。
//
// 所以前端单独一个 config 文件，让它是唯一的分母来源。通过 pnpm test:coverage:web-ui 调用。
//
// ## 关于阈值
//
// 它是地板，不是目标：只设在此刻实测值略下方，并且只允许往上抬
// （见 scripts/check-coverage-ratchet.mjs）。2026-09-19 实测（481 个用例）：
//   语句 29.92% / 分支 24.97% / 函数 24.13% / 行 31.48%
//
// ⚠️ 维护提示：本文件的注释一律用 //，不要改成 /* */ 块注释。
// 注释里出现的 glob（例如 packages 星号斜杠 src）内含「星号+斜杠」序列，
// 会提前闭合块注释，剩下的说明文字被当作代码执行
// （实测报错：ReferenceError: src is not defined）。已踩过一次。
export default defineConfig({
  test: {
    name: 'web-ui-coverage',
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./vitest.web-ui.setup.ts'],
    include: ['packages/web-ui/**/*.test.ts', 'packages/web-ui/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 10000,
    coverage: {
    enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage/web-ui',
      reporter: ['text-summary', 'json-summary'],
      include: ['packages/web-ui/src/**/*.ts', 'packages/web-ui/src/**/*.tsx'],
      exclude: [
        'packages/web-ui/src/**/*.test.ts',
        'packages/web-ui/src/**/*.test.tsx',
        '**/*.d.ts',
      ],
      thresholds: {
        statements: 28,
        branches: 23,
        functions: 22,
        lines: 29,
      },
    },
  },
});
