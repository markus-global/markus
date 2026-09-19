#!/usr/bin/env node
/**
 * 覆盖率棘轮（coverage ratchet）—— 前端覆盖率地板只升不降
 * ---------------------------------------------------------------------------
 * 为什么需要它：`vitest.config.ts` 里的 `coverage.thresholds` 是**静态数字**，
 * 一个 PR 顺手把它从 20 改成 5，CI 依然全绿，而且没人会注意到 —— 因为 diff 里
 * 只是一行数字，看起来像无害的调参。
 *
 * 本脚本把「地板」钉在一份提交进仓库的 baseline 文件里，并做两件事：
 *
 *   1. **回退即红**：实测覆盖率低于 baseline → 构建失败。
 *      （与 vitest 阈值互为冗余，但冗余在这里是故意的：阈值管「当次够不够」，
 *       baseline 管「历史上抬上去过没有」。）
 *   2. **提示抬升**：实测明显高于 baseline 时打印提醒，建议跑 --update 抬地板。
 *      棘轮只能往上走 —— 否则覆盖率会静默地一路滑回去。
 *
 * 用法：
 *   node scripts/check-coverage-ratchet.mjs              # 校验（CI 用）
 *   node scripts/check-coverage-ratchet.mjs --update     # 抬高 baseline
 *   node scripts/check-coverage-ratchet.mjs --check      # 只报告，不因抬升提醒失败
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASELINE_PATH = 'coverage-baseline.json';
const SUMMARY_PATH = 'coverage/web-ui/coverage-summary.json';
/** 实测高出 baseline 这个幅度（百分点）就提醒抬升。 */
const RAISE_HINT_PP = 3;
const METRICS = ['statements', 'branches', 'functions', 'lines'];

const args = new Set(process.argv.slice(2));
const update = args.has('--update');

if (!existsSync(SUMMARY_PATH)) {
  console.error(
    `找不到 web-ui 覆盖率报告：${SUMMARY_PATH}\n`
    + '请先跑：pnpm vitest run --project web-ui --coverage',
  );
  process.exit(2);
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf-8'));
const measured = {};
for (const metric of METRICS) {
  const value = summary?.total?.[metric]?.pct;
  if (typeof value !== 'number') {
    console.error(`覆盖率报告缺少 total.${metric}.pct —— 报告格式可能变了。`);
    process.exit(2);
  }
  measured[metric] = value;
}

// ── 收集健康检查（防假绿）───────────────────────────────────────────────────
// 若报告里所有指标都是 0%，几乎可以肯定不是"代码没被测试覆盖"，而是
// **覆盖率根本没有被收集到**（provider/路径解析失效）。此时棘轮若还判"未回退"，
// 就把一个坏掉的门禁伪装成了绿色 —— 比没有门禁更危险。直接判失败。
// 已知触发场景：vitest 4 下用 `--project web-ui --coverage` 跑 monorepo，
// v8 provider 记录不到命中（见 audit-reports/frontend-coverage-instrumentation.md）。
const allZero = METRICS.every(m => measured[m] === 0);
const hasFiles = (summary?.total?.statements?.total ?? 0) > 0;
if (allZero && hasFiles) {
  console.error(
    '\n✘ 覆盖率收集为空（所有指标 0%，但报告里统计了 '
    + `${summary.total.statements.total} 条语句）。\n`
    + '  这说明覆盖率**没有被真正收集**，门禁当前无效 —— 不能当作"未回退"。\n'
    + '  请先修复收集链路，再依赖本门禁。详见 docs/TESTING.md 的「已知限制」。\n',
  );
  process.exit(2);
}

if (update) {
  const next = {
    _comment:
      'web-ui 覆盖率地板（棘轮：只升不降）。由 scripts/check-coverage-ratchet.mjs --update 生成。'
      + '修改本文件会在评审中显式暴露 —— 这正是它存在的意义。',
    _updatedFrom: 'scripts/check-coverage-ratchet.mjs --update',
    'web-ui': Object.fromEntries(METRICS.map(m => [m, Number(measured[m].toFixed(2))])),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`✔ 已更新 ${BASELINE_PATH}：`);
  for (const metric of METRICS) console.log(`   ${metric}: ${next['web-ui'][metric]}%`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    `找不到 ${BASELINE_PATH}。首次请用 --update 生成并提交。`,
  );
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))['web-ui'] ?? {};

console.log('\nweb-ui 覆盖率棘轮');
console.log('─'.repeat(56));
console.log('指标          实测      地板      差');
const regressions = [];
const raiseHints = [];

for (const metric of METRICS) {
  const floor = baseline[metric];
  const actual = measured[metric];
  if (typeof floor !== 'number') {
    console.log(`${metric.padEnd(12)}  ${actual.toFixed(2).padStart(7)}%  (未设地板)   —`);
    continue;
  }
  const delta = actual - floor;
  const mark = delta < 0 ? '✘' : delta >= RAISE_HINT_PP ? '↑' : '✔';
  console.log(
    `${metric.padEnd(12)}  ${actual.toFixed(2).padStart(7)}%  ${floor.toFixed(2).padStart(6)}%  `
    + `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp ${mark}`,
  );
  if (delta < 0) regressions.push({ metric, actual, floor, delta });
  else if (delta >= RAISE_HINT_PP) raiseHints.push({ metric, actual, floor, delta });
}
console.log('─'.repeat(56));

if (raiseHints.length) {
  console.log('\n↑ 覆盖率已明显高于地板，建议抬高地板（棘轮只升不降）：');
  for (const hint of raiseHints) {
    console.log(`   ${hint.metric}: ${hint.floor}% → ${hint.actual.toFixed(2)}%（+${hint.delta.toFixed(2)}pp）`);
  }
  console.log('   确认后跑：node scripts/check-coverage-ratchet.mjs --update');
}

if (regressions.length) {
  console.error('\n✘ 覆盖率回退，低于已提交的地板：');
  for (const reg of regressions) {
    console.error(`   ${reg.metric}: ${reg.floor}% → ${reg.actual.toFixed(2)}%（${reg.delta.toFixed(2)}pp）`);
  }
  console.error('\n要么补测试，要么在 PR 里显式修改 coverage-baseline.json 并说明理由。\n');
  process.exit(1);
}

console.log('\n✔ web-ui 覆盖率未回退。\n');
