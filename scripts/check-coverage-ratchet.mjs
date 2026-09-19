#!/usr/bin/env node
/**
 * 覆盖率棘轮（coverage ratchet）—— 覆盖率地板只升不降
 * ---------------------------------------------------------------------------
 * 为什么需要它：`vitest.config.ts` / `vitest.web-ui.coverage.config.ts` 里的
 * `coverage.thresholds` 是**静态数字**，一个 PR 顺手把它从 20 改成 5，CI 依然
 * 全绿，而且没人会注意到 —— 因为 diff 里只是一行数字，看起来像无害的调参。
 *
 * 本脚本把「地板」钉在一份提交进仓库的 baseline 文件里，并做两件事：
 *
 *   1. **回退即红**：实测覆盖率低于 baseline → 构建失败。
 *      （与 vitest 阈值互为冗余，但冗余在这里是故意的：阈值管「当次够不够」，
 *       baseline 管「历史上抬上去过没有」，还负责挡住"直接把阈值改小"这条路。）
 *   2. **提示抬升**：实测明显高于 baseline 时打印提醒，建议跑 --update 抬地板。
 *      棘轮只能往上走 —— 否则覆盖率会静默地一路滑回去。
 *
 * ── 两个 project ──────────────────────────────────────────────────────────
 *   node scripts/check-coverage-ratchet.mjs                    # web-ui（默认）
 *   node scripts/check-coverage-ratchet.mjs --project node     # 后端
 *   node scripts/check-coverage-ratchet.mjs --project node --update
 *
 * 两个 project 共用一份 baseline，但**各自独立读写自己的键** —— `--update`
 * 只覆盖所指定 project 的键，绝不整文件重写（否则更新前端地板会把后端地板抹掉）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASELINE_PATH = 'coverage-baseline.json';
/** 实测高出 baseline 这个幅度（百分点）就提醒抬升。 */
const RAISE_HINT_PP = 3;
const METRICS = ['statements', 'branches', 'functions', 'lines'];

/**
 * 每个 project 一份独立报告 + 独立地板。
 * summary 路径必须与各自的 reportsDirectory 下 json-summary 的产物一致：
 *   - web-ui: vitest.web-ui.coverage.config.ts → coverage/web-ui/coverage-summary.json
 *   - node:   package.json `coverage:node`     → coverage/node/coverage-summary.json
 * ⚠️ `coverage:node` 必须带 `--coverage.reporter=json-summary`，否则这里永远读不到
 * 报告、棘轮会被"报告不存在"静默跳过 —— 门禁看起来在、其实没在。
 */
const PROJECTS = {
  'web-ui': {
    summary: 'coverage/web-ui/coverage-summary.json',
    label: 'web-ui 覆盖率棘轮（前端）',
    // 缺报告时告诉人该跑哪条命令，而不是让人猜。
    producer: 'vitest run --config vitest.web-ui.coverage.config.ts',
    command: 'pnpm test:coverage:web-ui',
  },
  node: {
    summary: 'coverage/node/coverage-summary.json',
    label: 'node 覆盖率棘轮（后端）',
    producer: 'vitest run --project node --coverage --coverage.reportsDirectory=./coverage/node',
    command: 'pnpm coverage:node',
  },
};

const args = process.argv.slice(2);
const argSet = new Set(args);
const update = argSet.has('--update');

const projectIdx = args.indexOf('--project');
const project = projectIdx >= 0 ? args[projectIdx + 1] : 'web-ui';
if (!PROJECTS[project]) {
  console.error(
    `未知 project：${project ?? '(缺参数值)'}`
    + ` —— 可用：${Object.keys(PROJECTS).join(' / ')}`,
  );
  process.exit(2);
}
const { summary: SUMMARY_PATH, label, producer, command } = PROJECTS[project];

if (!existsSync(SUMMARY_PATH)) {
  console.error(
    `找不到 ${project} 覆盖率报告：${SUMMARY_PATH}\n`
    + `请先跑：${command}\n`
    + `  （等价于：${producer}）`,
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

const readBaseline = () =>
  existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) : null;

if (update) {
  const baseline = readBaseline();
  if (!baseline) {
    console.error(`找不到 ${BASELINE_PATH}。首次请先手工建一份再跑 --update。`);
    process.exit(2);
  }
  // 只动本 project 的键 + 一条可追溯的更新戳；其余项目与说明字段原样保留。
  baseline[`_updated_${project}`] = new Date().toISOString().slice(0, 10);
  baseline[project] = Object.fromEntries(METRICS.map(m => [m, Number(measured[m].toFixed(2))]));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`✔ 已更新 ${BASELINE_PATH} 的 '${project}' 地板：`);
  for (const metric of METRICS) console.log(`   ${metric}: ${baseline[project][metric]}%`);
  console.log('   其余 project 的地板未被触碰。');
  process.exit(0);
}

const baselineFile = readBaseline();
if (!baselineFile) {
  console.error(`找不到 ${BASELINE_PATH}。首次请用 --update 生成并提交。`);
  process.exit(2);
}
const baseline = baselineFile[project] ?? {};

console.log(`\n${label}`);
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
  console.log(`   确认后跑：node scripts/check-coverage-ratchet.mjs --project ${project} --update`);
}

if (regressions.length) {
  console.error(`\n✘ ${project} 覆盖率回退，低于已提交的地板：`);
  for (const reg of regressions) {
    console.error(`   ${reg.metric}: ${reg.floor}% → ${reg.actual.toFixed(2)}%（${reg.delta.toFixed(2)}pp）`);
  }
  console.error(`\n要么补测试，要么在 PR 里显式修改 ${BASELINE_PATH} 的 '${project}' 并说明理由。\n`);
  process.exit(1);
}

console.log(`\n✔ ${project} 覆盖率未回退。\n`);
