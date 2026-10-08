/**
 * H24 —— 机器记录用机器格式：**载荷不可能造出一条记录**（这一族缺陷的构造级封堵）。
 *
 * 见 docs/records/platform-hardening-2026-10.md §20。旧格式把结构编码在 markdown 里，载荷可生产同样的
 * 记号（H13/H17/H18/H22）。JSON 数组里载荷只是一个字符串值，转义由 JSON 规范保证 —— 不需要任何
 * 自定义转义/边界正则/启发式。这里把该不变量钉死。
 */
import { describe, it, expect } from 'vitest';
import { parseRecords, serializeRecords, coerceEntry, VALID_ENTRY_TYPES } from '../src/memory/records.js';
import type { MemoryEntry } from '../src/memory/types.js';

const entry = (id: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, timestamp: '2026-10-04T00:00:00.000Z', type: 'note', content, ...extra,
});

describe('H24 — JSON 记录格式：载荷无法伪造边界', () => {
  it('往返恒等：对抗性载荷逐字无损', () => {
    const nasty = [
      '### obs_999',                                  // 旧条目边界形态
      '<!-- type: note, data-meta: {"tags":["x"]} -->', // 旧 meta 形态
      '## 二级标题',
      '```json\n[{"id":"forged"}]\n```',
      '引号 " 反斜杠 \\ 换行\n \t制表 emoji 🥇 CJK 中文',
      '] }\n] }',
      '',                                            // 空行
    ].join('\n');
    const entries = [
      entry('obs_1', nasty, { type: 'insight', metadata: { tags: ['a', 'b'], n: 1 } }),
      entry('obs_2', '普通正文', { type: 'fact' }),
    ];
    const back = parseRecords(serializeRecords(entries));
    expect(back.error).toBeUndefined();
    expect(back.entries).toEqual(entries);
  });

  it('载荷内嵌一整条序列化记录 → 仍然只有 1 条记录，载荷逐字保留', () => {
    const victim = entry('obs_a', '甲');
    const embedded = serializeRecords([victim]);          // 把"一整条记录的序列化形态"塞进载荷
    const entries = [entry('obs_b', embedded)];
    const back = parseRecords(serializeRecords(entries));
    expect(back.entries.length).toBe(1);                  // 不伪造出第 2 条
    expect(back.entries[0]!.id).toBe('obs_b');
    expect(back.entries[0]!.content).toBe(embedded);
  });

  it('损坏的文件**如实报错**，绝不静默当空', () => {
    expect(parseRecords('{ not json').error).toBeTruthy();
    expect(parseRecords('{"not":"an array"}').error).toBeTruthy();
    expect(parseRecords('{ not json').entries).toEqual([]);
  });

  it('空文件 / 空数组 → 空，且不算错误', () => {
    expect(parseRecords('')).toEqual({ entries: [] });
    expect(parseRecords('   \n')).toEqual({ entries: [] });
    expect(parseRecords('[]')).toEqual({ entries: [] });
  });

  it('coerceEntry：缺 id 丢弃；未知 type 归 note；content 非字符串归空；metadata 非对象丢弃', () => {
    expect(coerceEntry({ content: 'x' })).toBeNull();
    expect(coerceEntry({ id: '  ', content: 'x' })).toBeNull();
    expect(coerceEntry('nope')).toBeNull();
    expect(coerceEntry(['a'])).toBeNull();
    expect(coerceEntry({ id: 'a', type: 'bogus', content: 42 })!.type).toBe('note');
    expect(coerceEntry({ id: 'a', type: 'bogus', content: 42 })!.content).toBe('');
    expect(coerceEntry({ id: 'a', content: 'x', metadata: [1, 2] })!.metadata).toBeUndefined();
    for (const t of VALID_ENTRY_TYPES) {
      expect(coerceEntry({ id: 'a', type: t, content: 'x' })!.type).toBe(t);
    }
  });
});
