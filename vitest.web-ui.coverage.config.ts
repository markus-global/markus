import { defineConfig } from 'vitest/config';

// 前端覆盖率门禁 —— 独立配置文件（刻意与根 vitest.config.ts 分开）
//
// ## 为什么必须单独一个文件
//
// 根 vitest.config.ts 里已经有一份 coverage（后端门禁：include 是 packages/*/src、
// exclude 里排除了 packages/web-ui）。实测 vitest 4 的优先级是：
//
//   跑 `--project web-ui --coverage` 时，**根级 coverage 的 include/exclude 生效**，
//   而 project 里那段 coverage 被静默忽略。
//
// 后果（2026-09-19 实测）：报告里统计的是 292 个**后端**文件（a2a/cli/comms/core/
// desktop/org-manager/shared/storage），web-ui 一个都不在；前端测试当然不会执行后端
// 代码 → 命中 0 → 打印出 0/49045 = 0%。
//
// 这就是之前那个"前端覆盖率恒为 0%"的真相：**不是收集坏了，是分母装错了**。
// 它会伪装成一个"覆盖率 0%、一直在回退"的假信号 —— 比没有门禁更危险。
//
// 修法：让前端这一跑用一份**没有根级 coverage 干扰**的配置。本文件即是。
// 它只服务一个用途：`pnpm test:coverage:web-ui`。
export default defineConfig({
  test: {
    name: 'web-ui',
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
      reporter: ['text-summary', 'json-summary', 'json'],
      // 分母：只要前端源码。这是唯一与后端门禁不同的地方。
      include: ['packages/web-ui/src/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', '**/*.tsbuildinfo', '**/*.css'],
      all: true,
      // 阈值与棘轮（coverage-baseline.json）配合：这里是硬地板，
      // 棘轮保证地板只升不降。数值 = 2026-09-19 实测地板（向下取整）。
      thresholds: {
        statements: 6,
        branches: 4,
        functions: 4,
        lines: 6,
      },
    },
  },
});
