/**
 * H19 —— curated（会被注入 prompt 的）区必须有上限，但**不得**用"静默归档"来达成。
 *
 * 背景（docs §15）：
 *   旧机制 `compressLongTermMemory()` 在 curated 超软预算时，把**最大的段落**正文搬进
 *   `knowledge-archive.md` 并原位留指针存根——静默、按体积、价值盲目，且与同文件里
 *   「单段超限 = 拒绝写入」的策略自相矛盾，是 H13 的根因。实测：**0/94** 个 Agent 曾
 *   合法超过软预算，即该机制从未产生价值。
 *
 *   新契约：
 *     • 单段 > 3000           → 拒绝写入 + 理由（不变）
 *     • curated > 15000(软)   → **只报告**（横幅/日志），一个字节都不改
 *     • curated > 45000(硬)   → 拒绝写入 + 可操作理由（fail-closed）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MEMORY_MD_CURATED_MAX_CHARS,
  MEMORY_MD_CURATED_HARD_MAX_CHARS,
  MEMORY_MD_SECTION_MAX_CHARS,
} from '@markus/shared';
import { MemoryStore } from '../src/memory/store.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-curated-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const kFile = () => path.join(dir, 'knowledge.md');
const read = () => fs.readFileSync(kFile(), 'utf8');
const stubCount = (s: string) => s.split('\n').filter((l) => /^_\[archived →/.test(l.trim())).length;

/** A body just under the per-section limit, so the ONLY limit that can bite is the total. */
const bigBody = (tag: string) => `${tag}\n` + 'x'.repeat(MEMORY_MD_SECTION_MAX_CHARS - 60);

/** Add sections until either a refusal or `max` sections; returns the results in order. */
function addUntilRefused(store: MemoryStore, max: number) {
  const results: Array<{ ok: boolean; reason?: string }> = [];
  for (let i = 0; i < max; i++) {
    const r = store.addLongTermMemory(`sec${i}`, bigBody(`section ${i}`));
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}

describe('H19 — curated 预算：报告而不静默归档；硬天花板 fail-closed', () => {
  it('curated 超软预算但未到硬天花板 → 写入全部成功，且文件里没有任何新指针存根', () => {
    const store = new MemoryStore(dir);
    const n = Math.ceil(MEMORY_MD_CURATED_MAX_CHARS / MEMORY_MD_SECTION_MAX_CHARS) + 2; // 越过软预算
    const results = addUntilRefused(store, n);

    expect(results.every((r) => r.ok)).toBe(true); // 软预算不拒绝
    const curatedLen = store.getLongTermMemory().length;
    expect(curatedLen).toBeGreaterThan(MEMORY_MD_CURATED_MAX_CHARS); // 确实越过了软预算
    expect(curatedLen).toBeLessThan(MEMORY_MD_CURATED_HARD_MAX_CHARS);
    expect(stubCount(read())).toBe(0); // 绝不静默归档
  });

  it('curated 超硬天花板 → 拒绝写入（fail-closed），文件未被改动', () => {
    const store = new MemoryStore(dir);
    const results = addUntilRefused(store, 40);
    const refused = results.find((r) => !r.ok);
    expect(refused).toBeTruthy();
    expect(refused!.reason).toMatch(/limit|ceiling|上限/i);

    // 被拒绝的那次调用没有写入任何东西
    const before = read();
    const again = store.addLongTermMemory('secXX', bigBody('one more'));
    expect(again.ok).toBe(false);
    expect(read()).toBe(before);
  });

  it('合并路径不被软预算阻塞（中间态变大是必要的）', () => {
    const store = new MemoryStore(dir);
    // 先填到略超软预算
    addUntilRefused(store, Math.ceil(MEMORY_MD_CURATED_MAX_CHARS / MEMORY_MD_SECTION_MAX_CHARS) + 2);
    expect(store.getLongTermMemory().length).toBeGreaterThan(MEMORY_MD_CURATED_MAX_CHARS);

    // 往已存在段落写更大的合并正文 —— 必须仍然成功（否则唯一的收敛路径被锁死）
    const merged = store.addLongTermMemory('sec0', 'm'.repeat(MEMORY_MD_SECTION_MAX_CHARS - 10));
    expect(merged.ok).toBe(true);
  });

  it('enforceMemoryBudgets 在 curated 超软预算时只报告，不改写文件', () => {
    const store = new MemoryStore(dir);
    addUntilRefused(store, Math.ceil(MEMORY_MD_CURATED_MAX_CHARS / MEMORY_MD_SECTION_MAX_CHARS) + 2);
    const before = read();
    store.enforceMemoryBudgets();
    expect(read()).toBe(before);
    expect(stubCount(read())).toBe(0);
  });

  it('任何 curated 写入路径都只产出 curated —— 文件里绝不出现观察区（H24 契约）', () => {
    const store = new MemoryStore(dir);
    // 唯一的写入者 `writeKnowledgeMd` 强制“仅 curated”。旧实现**不一致**：add/remove 保留
    // 观察区、而 saveToDisk 却剥离它 —— 文件内容取决于最后跑的是哪条路径（R2：同一不变量多个
    // 执行点）。观察数据在 observations.json；“加载期把 in-band 观察区无损迁到 JSON”由
    // memory-migration.test.ts 独立覆盖（本例的夹具是加载后外部追加，那是迁移后不可达的形态）。
    const obs = '\n## _observations\n<!-- buffer -->\n\n### obs_a\n<!-- type: note -->\nhello\n';
    fs.appendFileSync(kFile(), obs);

    addUntilRefused(store, 40);
    store.enforceMemoryBudgets();

    expect(read().includes('## _observations')).toBe(false);
  });
});
