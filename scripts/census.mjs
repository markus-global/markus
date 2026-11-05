#!/usr/bin/env node
/**
 * 代码质量普查（census）—— **只读薄封装**，一条命令给出四类计数与各自的 `文件:行` 清单。
 *
 * ── 为什么必须存在（判据 6）──────────────────────────────────────────────
 * 在此之前，四类数字来自四处不同的东西：架构门禁（终态 / 键构造）、两个探针脚本
 * （吞错）、以及**报告里手写的 grep**（in-band 标记）。后果是同类问题出现两个数：
 * 「35 处命中」与「135 处终态裸比较」被混着引用过，因为它们本来就不是同一个探针。
 * 数字不可复现时，任何「已清零」的声称都无法被证伪。
 *
 * ── 纪律（改它就是改口径）──────────────────────────────────────────────
 * 1. **不实现任何检测规则**：四类全部调用既有实现（architecture-guard.mjs /
 *    probe-catch-swallow.mjs / probe-catch-setempty.py / in-band 登记表）。
 *    这里只做「调用 + 归集 + 排序」，多写一行正则就是第二处实现。
 * 2. **同 commit 连跑两次输出逐字节相同**：一切清单 `sort()`，不打印时间戳、
 *    绝对路径、耗时、随机量。
 * 3. 计数必须带探针名：任何数字都能被 `文件:行` 追到，不允许「我记得是 N 处」。
 *
 * 用法：
 *   node scripts/census.mjs              # 人类可读（四段 + 汇总）
 *   node scripts/census.mjs --json       # 机器可读（同为排序后结构，便于 diff）
 *   node scripts/census.mjs --rev <sha>  # 吞错两类支持按 commit 扫（其余两类由 guard 现扫）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const revIdx = process.argv.indexOf('--rev');
const rev = revIdx > 0 ? process.argv[revIdx + 1] : null;
const asJson = process.argv.includes('--json');

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // 探针/门禁可能以非零退出（门禁红、探针发现取数路径）—— 输出仍在 stdout 里，
    // 那是本命令要归集的事实，不能当成「跑挂了」丢掉。
    const out = (err.stdout ?? '') + (err.stderr ?? '');
    if (out.trim()) return out;
    throw err;
  }
}

const sorted = lines => [...new Set(lines)].sort();

// ─── ① 终态裸比较（architecture-guard.mjs 规则 terminal-status-predicate + 基线）──
function terminalStatus() {
  const out = run(process.execPath, ['scripts/architecture-guard.mjs', '--list']);
  const total = Number(/扫到 (\d+) 处终态裸比较/.exec(out)?.[1] ?? 0);
  const unregistered = Number(/未登记 (\d+) 组/.exec(out)?.[1] ?? 0);
  const stale = Number(/待精简 (\d+) 组/.exec(out)?.[1] ?? 0);
  // 逐处清单：存量条目只有「文件 + 处数」（基线不含行号，本命令不凭空造行号），
  // 未登记命中才带 file:line —— 而那些必须为 0。
  const baseline = JSON.parse(readFileSync(join(ROOT, 'scripts/terminal-status-baseline.json'), 'utf8'));
  const registered = sorted(
    Object.entries(baseline.files ?? {}).map(([file, e]) => `${file}  (基线登记 ${e.count ?? '?'} 处)`),
  );
  const unregisteredSites = sorted(
    out.split('\n')
      .filter(l => l.includes('[terminal-status-predicate]') && /:\d+/.test(l))
      .map(l => l.trim().replace(/^·\s*/, '').split(/\s{2,}/)[0]),
  );
  return { probe: 'architecture-guard#terminal-status-predicate', total, unregistered, staleBaseline: stale, sites: unregisteredSites, registered };
}

// ─── ② 缓存键 / 指纹里的时钟（同一门禁规则 key-constructor-no-clock）────────────
function keyClock() {
  const out = run(process.execPath, ['scripts/architecture-guard.mjs', '--list']);
  const lines = out.split('\n').filter(l => l.includes('[key-constructor-no-clock]'));
  const parse = l => {
    const m = /([\w./-]+):(\d+)/.exec(l);
    return m ? `${m[1]}:${m[2]}` : l.trim();
  };
  // 「已用 key-clock-ok 豁免」是登记过的行内豁免，与「未登记命中」不是同一类数字。
  const exempt = sorted(lines.filter(l => l.includes('key-clock-ok 豁免')).map(parse));
  const hits = sorted(lines.filter(l => !l.includes('key-clock-ok 豁免')).map(parse));
  return { probe: 'architecture-guard#key-constructor-no-clock', total: hits.length, exemptTotal: exempt.length, sites: hits, exemptSites: exempt };
}

// ─── ③ 取数吞错（两个既有探针，各自分类）────────────────────────────────────
function parseProbe(out, probeName) {
  const fetchPath = Number(/取数路径（必须为 0）= (\d+)/.exec(out)?.[1] ?? 0);
  const exemptTotal = Number(/已登记豁免 = (\d+)/.exec(out)?.[1] ?? 0);
  const hits = sorted(out.split('\n').filter(l => l.trim().startsWith('✗')).map(l => l.trim().replace(/^✗\s*/, '').split('\t')[0]));
  const exempt = sorted(out.split('\n').filter(l => l.trim().startsWith('·')).map(l => l.trim().replace(/^·\s*/, '')));
  const stale = sorted(out.split('\n').filter(l => l.trim().startsWith('?')).map(l => l.trim().replace(/^\?\s*/, '')));
  return { probe: probeName, fetchPath, exemptTotal, hits, exemptSites: exempt, staleEntries: stale };
}

function swallowProbes() {
  const revArgs = rev ? ['--rev', rev] : [];
  const swallow = run(process.execPath, ['scripts/probe-catch-swallow.mjs', '--classify', ...revArgs]);
  const setempty = run('python3', ['scripts/probe-catch-setempty.py', '--classify', ...revArgs]);
  const a = parseProbe(swallow, 'probe-catch-swallow.mjs');
  const b = parseProbe(setempty, 'probe-catch-setempty.py');
  return {
    probe: 'probe-catch-swallow.mjs + probe-catch-setempty.py',
    fetchPath: a.fetchPath + b.fetchPath,
    exemptTotal: a.exemptTotal + b.exemptTotal,
    sites: sorted([...a.hits, ...b.hits]),
    exemptSites: sorted([...a.exemptSites, ...b.exemptSites]),
    staleEntries: sorted([...a.staleEntries, ...b.staleEntries]),
    byProbe: [a, b],
  };
}

// ─── ④ in-band 结构标记（P2 登记表 + 读取点）──────────────────────────────────
function inBandMarkers() {
  const registryFile = 'packages/shared/src/types/in-band-markers.ts';
  const src = readFileSync(join(ROOT, registryFile), 'utf8');
  // 登记项 = 带 `key:` 的对象；判定谓词唯一实现是 readBooleanMarker（这里只计数，不重写规则）。
  const declared = sorted([...src.matchAll(/\bkey:\s*'([^']+)'/g)].map(m => m[1]));
  let reads = [];
  try {
    const grep = run('git', ['grep', '-n', 'isInBandMarkerSet(', '--', 'packages']);
    reads = sorted(
      grep.split('\n').filter(Boolean)
        .filter(l => !/\.test\.tsx?:/.test(l))
        .map(l => {
          const [file, line] = l.split(':');
          return `${file}:${line}`;
        }),
    );
  } catch { /* 无命中即空清单 */ }
  return {
    probe: `in-band registry (${registryFile}) + isInBandMarkerSet 读取点`,
    declaredCount: declared.length,
    declaredKeys: declared,
    readSites: reads.length,
    sites: reads,
  };
}

// ─── 输出（一切清单已排序 → 同 commit 两次运行逐字节相同）──────────────────────
const report = {
  terminalStatus: terminalStatus(),
  keyClock: keyClock(),
  swallow: swallowProbes(),
  inBand: inBandMarkers(),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (title, n, extra = '') => `\n── ${title} ──\n  计数 = ${n}${extra ? `  ${extra}` : ''}`;
  console.log(`提交: ${rev ?? 'worktree（git HEAD 派生的源码树）'}`);
  console.log(`探针: ① ${report.terminalStatus.probe}  ② ${report.keyClock.probe}  ③ ${report.swallow.probe}  ④ ${report.inBand.probe}`);

  console.log(line('① 终态裸比较', report.terminalStatus.total, `未登记 ${report.terminalStatus.unregistered} 组 / 基线待精简 ${report.terminalStatus.staleBaseline} 组`));
  for (const s of report.terminalStatus.sites) console.log(`    ✗ 未登记 ${s}`);
  for (const s of report.terminalStatus.registered) console.log(`    · ${s}`);

  console.log(line('② 缓存键/指纹里的时钟', report.keyClock.total, `已登记豁免 ${report.keyClock.exemptTotal} 处`));
  for (const s of report.keyClock.sites) console.log(`    ${s}`);
  for (const s of report.keyClock.exemptSites) console.log(`    (豁免) ${s}`);

  console.log(line('③ 取数吞错', report.swallow.fetchPath, `取数路径类（判据 = 0）/ 已登记豁免 ${report.swallow.exemptTotal}`));
  for (const s of report.swallow.sites) console.log(`    ✗ 取数路径 ${s}`);
  for (const s of report.swallow.exemptSites) console.log(`    · 已分类 ${s}`);
  for (const s of report.swallow.staleEntries) console.log(`    ? 失效登记项 ${s}`);

  console.log(line('④ in-band 结构标记', report.inBand.declaredCount, `登记项 / 读取点 ${report.inBand.readSites} 处`));
  console.log(`    登记项: ${report.inBand.declaredKeys.join(', ') || '（无）'}`);
  for (const s of report.inBand.sites) console.log(`    ${s}`);

  console.log('\n判据：① 未登记 = 0；② 未登记未豁免 = 0（存量口径见 docs/architecture/p3-terminal-status-gate.md）；③ 取数路径 = 0；④ 每个登记项都有谓词实现与读取点。');
}

if (report.swallow.fetchPath > 0 || report.terminalStatus.unregistered > 0 || report.keyClock.total > 0) {
  process.exitCode = 1;
}
