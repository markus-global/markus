#!/usr/bin/env node
/**
 * 探针：找出 catch 块里「返回空集合」的位置（审计 P1 的语义口径）。
 *
 * 为什么需要脚本而不是一行 grep：
 *   - 字面量口径 `catch(() => [])` 在本仓 = 0 处命中（早就不存在了），按它验收会得出
 *     「已经没问题」的假清零；
 *   - 真实主形态跨多行（`} catch {\n  return [];\n}`），单行 grep 抓不到；
 *   - test / .d.ts / dist 必须剔除，否则计数被测试夹具和注释语境污染。
 *
 * 用法：
 *   node scripts/probe-catch-swallow.mjs              # 扫工作树
 *   node scripts/probe-catch-swallow.mjs --rev <sha>  # 扫某个 commit（前后对照用）
 *
 * 口径（本卡定义的「空集合」）：[] / {} / new Set() / new Map() / emptyXxx()。
 * 范围：packages/<pkg>/src/**，排除 *.test.ts(x)、*.d.ts、node_modules、dist。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const revIdx = process.argv.indexOf('--rev');
const rev = revIdx > 0 ? process.argv[revIdx + 1] : null;

const EMPTY = /return\s*(\[\s*\]|\{\s*\}|new\s+Set\s*\(\s*\)|new\s+Map\s*\(\s*\)|empty[A-Za-z]*\s*\(\s*\))/;

const isTarget = p =>
  /^packages\/[^/]+\/src\//.test(p) &&
  (p.endsWith('.ts') || p.endsWith('.tsx')) &&
  !p.endsWith('.d.ts') &&
  !/\.test\.tsx?$/.test(p);

function listFiles() {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', rev ?? 'HEAD'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter(isTarget);
}

function readFile(p) {
  return rev
    ? execFileSync('git', ['show', `${rev}:${p}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : readFileSync(p, 'utf8');
}

/** 扫出每个 catch 的 body（支持多行块与单语句形）。 */
function catchBodies(text) {
  const out = [];
  const re = /\bcatch\b/g;
  let m;
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split('\n').length;
    let j = m.index + m[0].length;
    while (j < text.length && /[ \t]/.test(text[j])) j++;
    if (text[j] === '(') { // 跳过 catch (err)
      let d = 0;
      for (; j < text.length; j++) {
        if (text[j] === '(') d++;
        else if (text[j] === ')' && --d === 0) { j++; break; }
      }
      while (j < text.length && /[ \t\n]/.test(text[j])) j++;
    }
    if (text[j] === '{') {
      let d = 0, k = j;
      for (; k < text.length; k++) {
        if (text[k] === '{') d++;
        else if (text[k] === '}' && --d === 0) { k++; break; }
      }
      out.push({ line, body: text.slice(j, k) });
      re.lastIndex = k;
    } else {
      const end = text.indexOf('\n', j);
      out.push({ line, body: text.slice(j, end === -1 ? text.length : end) });
      re.lastIndex = end === -1 ? text.length : end;
    }
  }
  return out;
}

const rows = [];
for (const p of listFiles()) {
  let text;
  try { text = readFile(p); } catch { continue; }
  for (const { line, body } of catchBodies(text)) {
    // `body` 归一化后整段保留：`raises` 校验必须在**完整**命中体里 grep，
    // 不能用截断到 120 字的 snippet（升起语句常在 catch 体后半段）。
    if (EMPTY.test(body)) {
      const normBody = body.replace(/\s+/g, ' ').trim();
      rows.push({ file: p, line, snippet: normBody.slice(0, 120), body: normBody });
    }
  }
}

for (const r of rows) console.log(`${r.file}:${r.line}\t${r.snippet}`);
console.log(`\nTOTAL = ${rows.length}  (scope=packages/*/src, rev=${rev ?? 'worktree'})`);

// ── 分类（取数路径 vs 已登记豁免）─────────────────────────────────────────────
// 判据：**取数路径类 = 0**。合法形态（可选探测 / 写路径回退 / 同一 catch 已升起
// error 态）逐处登记在 scripts/read-path-exemptions.json（含 class 与理由）。
// 未登记者一律计为取数路径 —— fail-closed，不靠“看一眼觉得没问题”。
function loadLedger() {
  const p = new URL('./read-path-exemptions.json', import.meta.url);
  return JSON.parse(readFileSync(p, 'utf8')).entries ?? [];
}

const norm = s => s.replace(/\s+/g, ' ').trim();
const ledger = loadLedger();

/**
 * 台账自证（fail-closed）。`error-raised` 是一句**可机检**的断言：
 * 「同一条 catch 体内已经升起了 error 态」。只写一句 reason 等于让豁免自证 ——
 * 本仓实测踩过：把 `setLoadError(...)` 删掉后台账原样、探针照旧计 0（全绿假象）。
 * 因此 error-raised 必须带 `raises`（字面量），由探针在**同一条命中体**里 grep；
 * 缺失或不匹配一律计回「取数路径」。
 */
const invalidEntries = ledger.filter(
  e => e.class === 'error-raised' && (typeof e.raises !== 'string' || e.raises.trim() === ''),
);

function satisfies(e, r) {
  if (e.class !== 'error-raised') return { ok: true };
  if (typeof e.raises !== 'string' || !e.raises.trim()) {
    return { ok: false, why: 'error-raised 缺 raises 字段（不可自证）' };
  }
  if (!norm(r.body ?? '').includes(norm(e.raises))) {
    return { ok: false, why: `error-raised 命中体内找不到 ${JSON.stringify(e.raises)}（升起语句已消失）` };
  }
  return { ok: true };
}

const perFile = new Map();
const used = new Set();
const fetchPath = [];
const exempt = [];
for (const r of rows) {
  const nth = (perFile.get(r.file) ?? 0) + 1;
  perFile.set(r.file, nth);
  const idx = ledger.findIndex((e, i) =>
    !used.has(i) && e.probe === 'swallow' && e.file === r.file && e.nth === nth
    && (!e.snippet || norm(r.snippet).includes(norm(e.snippet))));
  if (idx < 0) {
    fetchPath.push({ ...r, why: '未登记' });
    continue;
  }
  used.add(idx);
  const verdict = satisfies(ledger[idx], r);
  if (verdict.ok) exempt.push({ ...r, class: ledger[idx].class, reason: ledger[idx].reason });
  else fetchPath.push({ ...r, why: verdict.why });
}
const stale = ledger.filter((e, i) => e.probe === 'swallow' && !used.has(i));
if (process.argv.includes('--classify')) {
  console.log(`\n取数路径（必须为 0）= ${fetchPath.length}`);
  for (const r of fetchPath) console.log(`  ✗ ${r.file}:${r.line}\t[${r.why}]\t${r.snippet}`);
  console.log(`\n已登记豁免 = ${exempt.length}`);
  for (const r of exempt) console.log(`  · ${r.file}:${r.line}  [${r.class}]  ${r.reason}`);
  if (stale.length) {
    console.log(`\n失效登记项（代码已不再命中，必须删除）= ${stale.length}`);
    for (const e of stale) console.log(`  ? ${e.file}\tnth=${e.nth}\t${e.reason ?? e.snippet ?? ''}`);
  }
  if (invalidEntries.length) {
    console.log(`\n台账不可自证（error-raised 缺 raises，必须补字段）= ${invalidEntries.length}`);
    for (const e of invalidEntries) console.log(`  ! ${e.file}\tnth=${e.nth}`);
  }
  if (fetchPath.length || stale.length || invalidEntries.length) process.exitCode = 1;
}
