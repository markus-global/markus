/**
 * P-17 回归（严重：静默数据丢失）—— `## _observations` 必须是最后一个段落。
 *
 * 历史 bug：addLongTermMemory 把新 curated 段落**追加到文件末尾**，而 _observations
 * 已是最后一段 → 新段落落在其后；saveToDisk() 又以 `## _observations` 为界重建文件、
 * 丢弃其后全部内容 → 任何新建段落在下一次观察区保存时被静默删除（正文只剩归档副本）。
 *
 * 由 CTO 亲测 memory_organize 时发现：合并进新段的观察在两次保存之间消失。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import type { MemoryEntry } from '../src/memory/types.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-order-'));
}
function entry(id: string, content: string): MemoryEntry {
  return { id, timestamp: new Date().toISOString(), type: 'note', content };
}

describe('knowledge.md 段落顺序不变量（P-17）', () => {
  it('反复保存观察不会删除或改动已有 curated 段落（顺序稳定）', () => {
    const dir = tmp();
    try {
      const store = new MemoryStore(dir);
      // 1) 建立第一个 curated 段落 + 一条观察
      store.addLongTermMemory('alpha', 'content-alpha');
      store.addEntry(entry('o1', 'obs-1'));

      // 2) 在观察已存在的前提下，新增第二个 curated 段落
      const w = store.addLongTermMemory('beta', 'content-beta');
      expect(w.ok).toBe(true);

      // 3) 再次触发观察区保存（历史上这一步会静默删除 beta）
      store.addEntry(entry('o2', 'obs-2'));

      // 4) 两个段落都必须存活
      expect(store.getLongTermSection('alpha')).toBe('content-alpha');
      expect(store.getLongTermSection('beta')).toBe('content-beta');

      // 5) H24 — 观察区已不在 knowledge.md；这里的不变量收敛为「curated 相对顺序稳定、
      //    且观察正文绝不落进 curated 文件」。
      const raw = fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf-8');
      expect(raw.indexOf('## alpha')).toBeGreaterThanOrEqual(0);
      expect(raw.indexOf('## alpha')).toBeLessThan(raw.indexOf('## beta'));
      expect(raw).not.toContain('obs-1');
      expect(raw).not.toContain('obs-2');

      // 6) 持久化无损：重新加载后依然如此
      const reopened = new MemoryStore(dir);
      expect(reopened.getLongTermSection('alpha')).toBe('content-alpha');
      expect(reopened.getLongTermSection('beta')).toBe('content-beta');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不变量：多次「加段落 + 存观察」后，所有 curated 段落存活、顺序稳定、且不含观察', () => {
    const dir = tmp();
    try {
      const store = new MemoryStore(dir);
      store.addLongTermMemory('alpha', 'content-alpha');
      store.addEntry(entry('o1', 'obs-1'));
      store.addLongTermMemory('beta', 'content-beta');
      store.addEntry(entry('o2', 'obs-2'));
      store.addLongTermMemory('gamma', 'content-gamma');
      store.addEntry(entry('o3', 'obs-3'));

      // 所有 curated 段落都存活
      for (const [k, v] of [['alpha', 'content-alpha'], ['beta', 'content-beta'], ['gamma', 'content-gamma']] as const) {
        expect(store.getLongTermSection(k)).toBe(v);
      }

      // H24 — curated 相对顺序稳定；观察正文绝不出现在 curated 文件里
      const raw = fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf-8');
      expect(raw.indexOf('## alpha')).toBeLessThan(raw.indexOf('## beta'));
      expect(raw.indexOf('## beta')).toBeLessThan(raw.indexOf('## gamma'));
      expect(raw).not.toContain('obs-1');
      expect(raw).not.toContain('obs-3');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
