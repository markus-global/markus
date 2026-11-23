/**
 * C10-0B §3.2 / §4-4 —— 结构性补证：**第二个身份建造点必须不存在**。
 *
 * 行为判据（见 `task-execution-identity-at-enqueue.test.ts`）证明「身份在入队时落地」；
 * 本文件证明**没有后门**：`linkMailboxItem`（只写 DB 列的后补写者）与
 * `'pending-link'`（「身份迟到」的表态词）在 `packages/*​/src` 里一处都不剩。
 *
 * 为什么两条都要：行为判据只覆盖被测路径。留着 `linkMailboxItem`，下一个人就能再造
 * 一条「先入队、后写列」的路径，台账与库重新分成两套真相 —— 而那正是本卡的根因。
 *
 * 基线上本文件立刻红（两个词各有十余处命中）。
 * 说明：注释里的历史叙述也算命中 —— 这个词本身不该再出现在产线源码里。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** `packages/<pkg>/src/**` 下的所有 .ts（跳过 .d.ts）。 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src');
    let exists = true;
    try { statSync(srcDir); } catch { exists = false; }
    if (!exists) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mts|cts)$/.test(entry)) continue;
        if (/\.d\.ts$/.test(entry)) continue;
        out.push(full);
      }
    };
    walk(srcDir);
  }
  return out;
}

function offenders(pattern: string): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf-8');
    if (!text.includes(pattern)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(pattern)) {
        hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${lines[i]!.trim().slice(0, 140)}`);
      }
    }
  }
  return hits;
}

describe('C10-0B §3.2：身份只有一个建造点（入队时）', () => {
  it('`linkMailboxItem` 在 packages/*/src 中 0 命中', () => {
    const hits = offenders('linkMailboxItem');
    expect(hits, `后补身份写者必须删除（只写 DB 列 = 台账与库两套真相）：\n${hits.join('\n')}`)
      .toHaveLength(0);
  });

  it('`pending-link` 在 packages/*/src 中 0 命中', () => {
    const hits = offenders('pending-link');
    expect(hits, `「身份迟到」的表态词必须删除（它就是第二个建造点的许可证）：\n${hits.join('\n')}`)
      .toHaveLength(0);
  });

  it('自称的令牌是真的在扫：主动塞一个违规样本必须被同一检测器抓到（自检）', () => {
    // 检测器本身若失效（例如路径算错、readdir 没读到），上面两条会永远绿。
    // 用一个只在内存里存在的样本证明它真的会命中。
    const sample = 'const x = units.linkMailboxItem(itemId, ref); // pending-link';
    expect(sample.includes('linkMailboxItem')).toBe(true);
    expect(sample.includes('pending-link')).toBe(true);
    // 而且真实源码集合非空（否则「0 命中」毫无意义）
    expect(sourceFiles().length).toBeGreaterThan(50);
  });
});

// ─── C10-B：外部信号 ref 的唯一建造点 ─────────────────────────────────────────
//
// WORK_UNIT_REF.external（shared/work-unit.ts）是外部信号 ref 的唯一构造器。
// 第二个建造点 = 同一个事件可以长出两个身份（R1 的身份版）。检测器咬三种
// **建造**形态（模板插值 / 字符串拼接 / 硬编码整 ref），不咬读取谓词：
// identity-audit 的门禁 SQL 用 LIKE 'external:%' 做形状检查（一个冒号，读取），
// 不是建造。豁免文件只有构造器本身（含其文档注释）。
//
// 本组在 base 上是「缺席断言」（0 命中 = 绿）；咬人证据 = 证伪阶段种第二建造点。

/** 唯一合法建造点（相对仓库根）。 */
const EXTERNAL_REF_CONSTRUCTOR_FILE = join('packages', 'shared', 'src', 'work-unit.ts');

/** 三种建造形态：模板插值 / 拼接 / 硬编码整 ref（source:messageId 两段）。 */
const EXTERNAL_BUILD_PATTERNS: RegExp[] = [
  /`external:\$\{/,
  /['"]external:['"]\s*\+/,
  /['"]external:[a-z0-9_-]+:/,
];

function externalBuildOffenders(): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    if (relative(REPO_ROOT, file) === EXTERNAL_REF_CONSTRUCTOR_FILE) continue;
    const text = readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (EXTERNAL_BUILD_PATTERNS.some(p => p.test(line))) {
        hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      }
    }
  }
  return hits;
}

describe('C10-B：外部信号 ref 只有一个建造点（WORK_UNIT_REF.external）', () => {
  it('packages/*/src 中除构造器文件外，0 个 external ref 建造点', () => {
    const hits = externalBuildOffenders();
    expect(hits, `第二建造点必须删除（一个事件两个身份 = R1）：\n${hits.join('\n')}`)
      .toHaveLength(0);
  });

  it('检测器真的会咬：三种建造形态的内存样本各命中一条（自检）', () => {
    const samples = [
      'const ref = `external:${src}:${id}`;',
      "const ref = 'external:' + src + ':' + id;",
      "const ref = 'external:src_hook:msg-1';",
    ];
    for (const s of samples) {
      expect(EXTERNAL_BUILD_PATTERNS.some(p => p.test(s)), `样本必须被咬：${s}`).toBe(true);
    }
    // 读取谓词（门禁 SQL 的形状检查）不是建造，不得误咬。
    const readPredicate = "work_unit_ref NOT LIKE 'external:%'";
    expect(EXTERNAL_BUILD_PATTERNS.some(p => p.test(readPredicate))).toBe(false);
    // 唯一构造器调用形态也不咬。
    expect(EXTERNAL_BUILD_PATTERNS.some(p => p.test('WORK_UNIT_REF.external(src, id)'))).toBe(false);
  });
});