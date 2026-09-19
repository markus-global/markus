import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 覆盖面修复（2026-09-19）
 *
 * 此前 `files` 只匹配 `packages/*​/src/**​/*.ts`，**不含 `.tsx`** —— 整个 web-ui 的
 * React 组件（40+ 个文件）从未被 lint 过，问题只能靠 tsc + vitest 兜底。这不是
 * 「规则太严」，而是**文件根本没进 lint 范围**（eslint 会静默报
 * "File ignored because no matching configuration was supplied"）。
 *
 * 纳入 `.tsx` 后一次性暴露出 144 个 error，逐类处理如下：
 *   · 82 × eqeqeq —— 绝大多数是 `x == null` 这类**同时排除 null 与 undefined** 的
 *     惯用法。这不是坏味道，而是该规则的标准豁免场景，故采用官方推荐的
 *     `{ null: 'ignore' }`（语义正确：`x == null` 本就该同时命中两者）。
 *   · 38 ×「Definition for rule 'react-hooks/exhaustive-deps' was not found」——
 *     代码里早写了 `eslint-disable` 注释，但仓库**从未安装/注册** react-hooks 插件，
 *     那些 disable 全是**死指令**（既没生效、还反过来报错）。本次补装
 *     `eslint-plugin-react-hooks` 并注册，死指令随之复活为**真的**依赖检查。
 *   · 24 × 真实存量欠账（见下方 ratchet 注释）。
 */
export default [
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      // TypeScript-aware rules
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      }],

      // General quality
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-template-curly-in-string': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      // `null: 'ignore'` 放行 `x == null` / `x != null`（同时判 null 与 undefined）。
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // React Hooks —— 必须在 .tsx 上才真正命中，写在通用块对纯 .ts 无副作用。
      // rules-of-hooks 是**真 bug 级**规则（条件式调用 hook），保持 error。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: [
      'packages/*/test/**/*.ts',
      'packages/*/test/**/*.tsx',
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // ── `.tsx` 存量欠账棘轮（ratchet）────────────────────────────────────────
    // 拿到 .tsx 覆盖后，下面 3 条规则在既有组件里共 24 处违规。它们是**历史欠账**，
    // 不是本次改动引入的；且这些文件当前有他人未提交的改动，不宜在本次一并大改。
    //
    // 这里先降为 warn，好处是：① `.tsx` 立刻进入 lint 范围（这是本次要修的「覆盖」问题）；
    // ② `npm run lint` 保持绿色，不打断别人的工作流。
    //
    // 清账后请把这三条删掉（让它们回到上面的 error）。存量分布：
    //   · no-duplicate-imports           12
    //   · @typescript-eslint/consistent-type-imports  9
    //   · prefer-const                    3
    files: ['packages/*/src/**/*.tsx'],
    rules: {
      'no-duplicate-imports': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',
      'prefer-const': 'warn',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.cjs', '**/*.mjs'],
  },
];
