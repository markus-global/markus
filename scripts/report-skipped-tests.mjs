#!/usr/bin/env node
/**
 * 跳过用例审计（skipped-test audit）
 * ---------------------------------------------------------------------------
 * 为什么需要它：vitest 默认 reporter 只在汇总行写一个 `N skipped`，没人会去
 * 数那 N 是不是变大了。而「整文件被静默跳过」是最危险的一种覆盖幻觉 ——
 * 文件还在、看着还在跑、CI 还是绿的，但里面一条断言都没执行。
 *
 * 典型例子：`packages/core/test/multimodal-providers.test.ts` 在没有 API key 时
 * 整个文件走 `describe.skipIf`，CI 无密钥 → 这个文件**永远不执行**，却让覆盖率
 * 数字看上去是完整的。
 *
 * 本脚本读 vitest 的 JSON 报告，做两件事：
 *   1. **打印**完整跳过清单（文件 + 用例名 + 原因），让 skip 在 CI 日志里可见；
 *   2. **拦截**「整文件全跳过」—— 这类文件必须显式登记到 ALLOWLIST 才能过。
 *      登记是刻意的、可 review 的动作；未登记就整文件跳过 → 直接红。
 *
 * 注意：单独的 `it.skip` 不算违规。它们是显式的、写在 diff 里看得见的；
 * 真正要拦的是「整个文件静默消失」。
 *
 * 用法：
 *   node scripts/report-skipped-tests.mjs coverage/vitest-report.json
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

/**
 * 允许「整文件跳过」的文件清单，必须写明原因。
 *
 * 往这里加条目之前请先问：这个文件在 CI 里真的跑不了任何东西吗？
 * 如果只是「某个环境缺配置」，更该做的是让它至少跑一部分。
 */
const ALLOWLIST = new Map([
  [
    'packages/core/test/multimodal-providers.test.ts',
    '需要真实 provider 凭据（OPENROUTER / GEMINI 等）。CI 无密钥 → 整体 skip。'
      + ' 缓解：core 里对同一批适配器的**纯解析逻辑**已有离线用例（llm-google / llm-anthropic / llm-minimax）。',
  ],
]);

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('用法：node scripts/report-skipped-tests.mjs <vitest-json-report>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf-8'));
} catch (err) {
  console.error(`无法读取 vitest JSON 报告（${reportPath}）：${err.message}`);
  // 报告缺失本身就是问题：说明 CI 的 test 步骤没有产出 JSON，skip 审计形同虚设。
  process.exit(2);
}

const results = Array.isArray(report.testResults) ? report.testResults : [];

let totalTests = 0;
let totalSkipped = 0;
/** @type {Array<{ file: string, total: number, skipped: number }>} */
const fullySkipped = [];
/** @type {Array<{ file: string, tests: string[] }>} */
const partial = [];

for (const file of results) {
  const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
  const rel = relative(process.cwd(), file.name ?? '');
  const skipped = assertions.filter(a => a.status === 'pending' || a.status === 'skipped');
  totalTests += assertions.length;
  totalSkipped += skipped.length;

  if (assertions.length === 0) continue;

  if (skipped.length === assertions.length) {
    fullySkipped.push({ file: rel, total: assertions.length, skipped: skipped.length });
  } else if (skipped.length > 0) {
    partial.push({ file: rel, tests: skipped.map(a => a.fullName ?? a.title ?? '(未命名)') });
  }
}

const line = '─'.repeat(72);

console.log(`\n${line}\n跳过用例审计\n${line}`);
console.log(`总计 ${totalTests} 个用例，其中跳过 ${totalSkipped} 个。`);

if (partial.length) {
  console.log('\n▸ 部分跳过（显式 it.skip，属正常，仅列出）：');
  for (const entry of partial) {
    console.log(`  · ${entry.file} —— ${entry.tests.length} 例`);
    for (const name of entry.tests) console.log(`      - ${name}`);
  }
}

const unregistered = fullySkipped.filter(f => !ALLOWLIST.has(f.file));

if (fullySkipped.length) {
  console.log('\n▸ 整文件跳过：');
  for (const entry of fullySkipped) {
    const reason = ALLOWLIST.get(entry.file);
    console.log(`  ${reason ? '✔' : '✘'} ${entry.file} —— ${entry.skipped} 例全部跳过`);
    if (reason) {
      console.log(`      已登记：${reason}`);
    } else {
      console.log('      未登记。整文件跳过 = 该文件的覆盖率是幻觉。');
      console.log('      若确认无解，请把它加进本脚本的 ALLOWLIST 并写明原因。');
    }
  }
}

console.log(`\n${line}`);

if (unregistered.length) {
  console.error(`✘ 有 ${unregistered.length} 个文件整文件跳过且未登记，构建失败。\n`);
  process.exit(1);
}

console.log('✔ 跳过清单已审计（整文件跳过均已登记）。\n');
