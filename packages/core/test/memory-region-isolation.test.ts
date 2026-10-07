/**
 * H18 —— knowledge.md 是「带内（in-band）markdown 容器」：结构记号与载荷内容共用同一空间。
 *
 * 这一族缺陷已出现三次，全部同根：
 *   • H13：`compressLongTermMemory` 扫**整个文件**找 `## `，把观察正文里的标题当 curated
 *          段落「归档」，正文被存根覆盖；
 *   • H17：`parseEntryBlocks` 用 `split(/\n### /)`，正文里的 H3 标题被伪造成条目边界；
 *   • 根因：结构是从**裸 markdown 记号**推断的，而载荷（Agent 自撰 markdown）也能生产这些记号；
 *          且格式**没有单一主人**——写入期的守卫（`sanitizeSectionBody`）可被任何「扫错区域」的
 *          读取期变换绕开。
 *
 * 本文件不测某一个函数，而是把**整族不变式**钉死，作为系统级闸门：
 *   1. `splitKnowledgeSections` 的往返恒等（区域切分无损）。
 *   2. curated 变换**绝不**改写观察区——逐字节保留（H13 的正向不变式）。
 *   3. 观察正文里含 `## ` / `### ` / 归档存根 / `<!-- type:` 时，观察区仍逐字节保留。
 *   4. curated 段落正文里的 `## ` 不会在回读时伪造出幽灵段落（写入期守卫）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore, splitKnowledgeSections, sanitizeSectionBody } from '../src/memory/store.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-region-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const knowledgeFile = () => path.join(dir, 'knowledge.md');
const read = () => fs.readFileSync(knowledgeFile(), 'utf8');
/** The observation region = everything from `## _observations` onward. */
const obsRegion = (s: string) => {
  const i = s.indexOf('## _observations');
  return i < 0 ? '' : s.slice(i);
};

/** Adversarial observation bodies: every token that could be mistaken for structure. */
const ADVERSARIAL_BODIES = [
  '## 现象\n正文第一行\n## 根因\n正文第二行',
  '### 修复步骤\n1. 打开文件',
  '_[archived → knowledge-archive.md；正文已无损归档，可用 memory_search 检索]_',
  '<!-- type: insight -->',
  '```\n### not a heading\n```',
  '正文含 $& 与 $1 与 `$`（模板语义探测）',
  '## _observations\n（正文里逐字出现区域标记）',
];

function buildKnowledge(bodies: string[]): string {
  const entries = bodies.flatMap((b, i) => [
    `### obs_${i + 1}`,
    '<!-- type: note -->',
    b,
    '',
  ]);
  return [
    '# Knowledge', '',
    '## procedures', '- keep it short', '',
    '## _observations',
    '<!-- This section is the observation buffer. -->',
    '',
    ...entries,
  ].join('\n');
}

describe('H18 — 带内容器的区域隔离不变式', () => {
  it('splitKnowledgeSections 往返恒等：curated + observations === 原文', () => {
    const md = buildKnowledge(ADVERSARIAL_BODIES);
    const { curated, observations } = splitKnowledgeSections(md);
    expect(curated + observations).toBe(md);
  });

  it('curated 变换绝不改写观察区——逐字节保留（H13 正向不变式）', () => {
    fs.writeFileSync(knowledgeFile(), buildKnowledge(ADVERSARIAL_BODIES), 'utf8');
    const store = new MemoryStore(dir);

    const before = obsRegion(read());
    // Force the curated enforcement path (它曾经扫全文件、把观察正文当 curated 段落归档)。
    // H19: `compressLongTermMemory` was removed; `enforceMemoryBudgets` is now the only
    // code that touches the curated budget at load — and it must not touch observations.
    store.enforceMemoryBudgets();
    const after = obsRegion(read());

    expect(after).toBe(before);
    // 观测区内「归档存根」的行数不因 curated 变换而增加（夹具正文里本就有 1 条同形文本，
    // 属载荷；变换不得新增任何存根）。
    const stubs = (s: string) => s.split('\n').filter((l) => /^_\[archived →/.test(l.trim())).length;
    expect(stubs(after)).toBe(stubs(before));
  });

  it('观察条目数在 curated 变换前后不变（不伪造、不吞并）', () => {
    fs.writeFileSync(knowledgeFile(), buildKnowledge(ADVERSARIAL_BODIES), 'utf8');
    const store = new MemoryStore(dir);
    const n0 = store.getObservations().length;
    store.enforceMemoryBudgets();
    const n1 = store.getObservations().length;
    expect(n1).toBe(n0);
    expect(n0).toBe(ADVERSARIAL_BODIES.length);
  });

  it('curated 段落正文里的 ## 不会在回读时伪造幽灵段落（写入期守卫）', () => {
    const store = new MemoryStore(dir);
    const body = 'first line\n## 假段落\nsecond line';
    const res = store.addLongTermMemory('procedures', body);
    expect(res.ok).toBe(true);

    // 磁盘上该段落正文里的 `## ` 已被降级，不会与真正的段落头混淆
    const raw = read();
    expect(raw).toContain('### 假段落');
    // 且 curated 头部表里只有 procedures 一个段落（无「假段落」）
    const { curated } = splitKnowledgeSections(raw);
    const headers = curated.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
    expect(headers).toEqual(['## procedures']);
  });

  it('sanitizeSectionBody 是幂等的（重复写入不累积转义）', () => {
    const once = sanitizeSectionBody('a\n## b\nc');
    const twice = sanitizeSectionBody(once);
    expect(twice).toBe(once);
    expect(once).toContain('### b');
  });
});
