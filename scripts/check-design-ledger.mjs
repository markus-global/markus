#!/usr/bin/env node
/**
 * 校验设计契约 §9「概念对照表 / 完成度台账」是否自洽。
 *
 * 为什么需要这个脚本：契约里写了「每张卡提交时同一 commit 内更新台账」，
 * 但**约定不会自己生效**——上一轮我刚把「残余」当免责声明，靠自觉的规则会重演。
 * 所以把规则变成会红的东西：本地跑 `npm run check:design-ledger`，CI 接进 quality。
 *
 * 校验五条（对应契约 §10.3）：
 *   1. 行数固定：§9.1 = 13 行、§9.2 = 10 行（少一行 = 有人删行逃避）
 *   2. 状态只能是 未开始 / 进行中 / 已完成 / 范围外
 *   3. 已完成 ⇒ 提交号真实存在（7–40 位十六进制 且 git cat-file -e 通过）
 *   4. 范围外 ⇒ 必须写清理由（§9.2 不允许出现范围外：九项必须全部落地）
 *   5. 未开始 ⇒ 提交号必须是 —；进行中 可填已产生的提交号，但必须真实存在（A 卡已交付、B 卡未实测的形态）
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const FILE = fileArg >= 0 ? resolve(args[fileArg + 1]) : resolve(ROOT, 'docs/design/superagent/DESIGN-CONTRACT.md');

const STATES = new Set(['未开始', '进行中', '已完成', '范围外']);
const EXPECTED = { '9.1': 13, '9.2': 10 };

const errors = [];
const raw = readFileSync(FILE, 'utf8');

/** 取出某个小节下的表格数据行（跳过表头与分隔行）。 */
function tableRows(section, nextSection) {
  const start = raw.indexOf(section);
  if (start < 0) {
    errors.push(`找不到小节 ${section}`);
    return null;
  }
  const end = nextSection ? raw.indexOf(nextSection, start) : raw.length;
  const body = raw.slice(start, end < 0 ? raw.length : end);
  return body
    .split('\n')
    .filter(l => l.trim().startsWith('|'))
    .filter(l => !/^\|\s*-{2,}/.test(l.trim())) // 分隔行 |---|---|
    .filter(l => !/\|\s*#\s*\|/.test(l)) // 表头行
    .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
}

function isSha(v) {
  return /^[0-9a-f]{7,40}$/.test(v);
}

function commitExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function check(rows, label, spec) {
  if (!rows) return;
  if (rows.length !== EXPECTED[label]) {
    errors.push(`${label} 行数应为 ${EXPECTED[label]}，实际 ${rows.length}（不允许删行逃避）`);
  }
  rows.forEach((cells, i) => {
    const id = `${label} 第 ${i + 1} 行（${cells[0] ?? '?'}）`;
    const state = cells[spec.state];
    const sha = cells[spec.commit];
    if (!state) {
      errors.push(`${id}：缺状态列`);
      return;
    }
    if (!STATES.has(state)) {
      errors.push(`${id}：状态「${state}」非法（只允许 未开始/进行中/已完成/范围外）`);
      return;
    }
    if (state === '已完成') {
      if (!isSha(sha)) {
        errors.push(`${id}：已完成 但没有填提交号（实际「${sha ?? ''}」）`);
      } else if (!commitExists(sha)) {
        errors.push(`${id}：提交号 ${sha} 在仓库里不存在`);
      }
    } else if (state === '范围外') {
      if (label === '9.2') {
        errors.push(`${id}：§9.2 不允许「范围外」—— 九项必须全部落地`);
      } else if (!/^理由[:：]/.test(sha ?? '') || (sha ?? '').length < 12) {
        errors.push(`${id}：范围外 必须写清理由（提交号列填「理由：…」，且说明触发条件）`);
      }
    } else if (state === '进行中') {
      // 允许携带已产生的提交号（A 卡交付、B 卡未实测），但它必须真实存在：
      // 这比“必须写 —”更严格——填了就不能是编的。
      if (sha !== '—' && !isSha(sha)) {
        errors.push(`${id}：进行中 时提交号须为 — 或真实 SHA（实际「${sha ?? ''}」）`);
      } else if (sha !== '—' && !commitExists(sha)) {
        errors.push(`${id}：提交号 ${sha} 在仓库里不存在`);
      }
    } else if (sha !== '—') {
      errors.push(`${id}：${state} 时提交号必须是 —（不许提前填预期提交号）`);
    }
  });
}

check(tableRows('### 9.1', '### 9.2'), '9.1', { state: 6, commit: 7 });
check(tableRows('### 9.2', '## 10'), '9.2', { state: 3, commit: 4 });

if (errors.length) {
  console.error('✗ 设计契约台账校验失败：');
  for (const e of errors) console.error('  -', e);
  console.error('\n改完再提交：docs/design/superagent/DESIGN-CONTRACT.md §9');
  process.exit(1);
}

console.log('✓ 设计契约台账自洽（§9.1 13 行 / §9.2 10 行，状态与提交号一致）');
