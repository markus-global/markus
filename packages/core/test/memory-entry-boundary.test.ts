/**
 * H17 —— 观察/片段条目的**边界**必须锚在机器产物上，而不是 markdown 记号。
 *
 * 回归背景（见 docs/records/PLATFORM-HARDENING-2026-10.md §13）：
 *
 *   `parseEntryBlocks()` 曾用 `obsContent.split(/\n### /)` 划分条目。但 `### ` 是
 *   **markdown H3 标题**，Agent 正文（任意 markdown）可以自由生产它。于是一条正文含
 *   H3 标题的合法观察会被**静默切坏**：
 *
 *     ### obs_probe_1
 *     <!-- type: insight -->
 *     结论：这样做。
 *     ### 修复步骤            <-- 正文里的 H3
 *     1. 打开文件
 *     => 解析出 2 条：obs_probe_1（正文被截断）+ 幽灵条目 id="修复步骤"
 *
 *   与 H13（curated 段落误切正文里的 `## `）同类：容器结构记号与载荷内容空间重叠。
 *   修复：边界收紧为 "`### ` 且其后紧跟 `<id>\n<!-- type: … -->`"（写入方必然产出的
 *   机器形态）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MemoryStore,
  serializeObservationBuffer,
  serializeFragmentRegion,
} from '../src/memory/store.js';
import type { MemoryEntry } from '../src/memory/types.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-boundary-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Round-trip entries through the REAL serializer + the REAL parser. */
function roundTrip(entries: MemoryEntry[]): MemoryEntry[] {
  const store = new MemoryStore(dir);
  const buf = serializeObservationBuffer(entries);
  const region = buf.slice(buf.indexOf('\n### '));
  // parseEntryBlocks is the single reader shared by obs region / fragment region / archive.
  return (store as unknown as { parseEntryBlocks: (s: string) => MemoryEntry[] }).parseEntryBlocks(region);
}

const entry = (id: string, content: string, type: MemoryEntry['type'] = 'insight'): MemoryEntry => ({
  id,
  timestamp: new Date().toISOString(),
  type,
  content,
});

describe('H17 — 正文里的 ### 标题不得伪造条目边界', () => {
  it('往返不变式：正文含 ### 标题 → 仍是 1 条，且正文完整', () => {
    const original = entry(
      'obs_probe_1',
      '结论：这样做。\n### 修复步骤\n1. 打开文件\n2. 改一行',
    );
    const parsed = roundTrip([original]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('obs_probe_1');
    expect(parsed[0]!.content).toContain('结论：这样做。');
    expect(parsed[0]!.content).toContain('### 修复步骤');
    expect(parsed[0]!.content).toContain('1. 打开文件');
    expect(parsed[0]!.content).toBe(original.content);
  });

  it('幽灵条目不复现：解析结果里不存在 id 为正文片段的条目', () => {
    const parsed = roundTrip([entry('obs_probe_1', '结论：这样做。\n### 修复步骤\n1. 打开文件')]);
    expect(parsed.map((e) => e.id)).toEqual(['obs_probe_1']);
    expect(parsed.some((e) => e.id === '修复步骤')).toBe(false);
  });

  it('多条目混合：正文含 ### 的条目 + 正常条目，条目数与内容均正确', () => {
    const parsed = roundTrip([
      entry('obs_1', 'first\n### A heading\nbody A'),
      entry('obs_2', 'second, plain'),
      entry('obs_3', 'third\n### Another\nbody B'),
    ]);

    expect(parsed.map((e) => e.id)).toEqual(['obs_1', 'obs_2', 'obs_3']);
    expect(parsed[0]!.content).toBe('first\n### A heading\nbody A');
    expect(parsed[1]!.content).toBe('second, plain');
    expect(parsed[2]!.content).toBe('third\n### Another\nbody B');
  });

  it('片段区同受保护：serializeFragmentRegion 往返，正文含 ### 不分裂', () => {
    const store = new MemoryStore(dir);
    const frag = entry('frag_123_sess_1', 'transcript\n### 现象\nsomething', 'conversation_fragment');
    const region = serializeFragmentRegion([frag]);
    const parsed = (store as unknown as { parseEntryBlocks: (s: string) => MemoryEntry[] })
      .parseEntryBlocks(region.slice(region.indexOf('\n### ')));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe('conversation_fragment');
    expect(parsed[0]!.content).toContain('### 现象');
  });

  it('真·条目边界仍生效：两个合法条目仍解析为 2 条', () => {
    const parsed = roundTrip([entry('obs_a', 'alpha'), entry('obs_b', 'beta')]);
    expect(parsed.map((e) => e.id)).toEqual(['obs_a', 'obs_b']);
    expect(parsed[0]!.content).toBe('alpha');
    expect(parsed[1]!.content).toBe('beta');
  });
});
