/**
 * MemoryStore.getMemoryHealth —— 驱动提示词内「记忆健康」信号。
 *
 * 口径（H1 重构后）：健康度 = **注入段（curated）**占用 / 注入预算。
 * 观察缓冲 `## _observations` **不注入**，是**另一个独立预算**，单独报告。
 *
 * 回归背景：旧实现用**整个文件大小**除 15000 作为 percent，于是"观察缓冲很大"
 * 会把健康度推到 >100%（实测 245%），而真正注入 prompt 的只有约 2k —— 一个
 * 永远在响、但从不代表真实问题的警报。详见 docs/records/platform-hardening-2026-10.md §2。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { MEMORY_MD_CURATED_MAX_CHARS, MEMORY_OBSERVATIONS_MAX_CHARS } from '@markus/shared';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-health-'));
}

describe('MemoryStore.getMemoryHealth', () => {
  it('分开报告两个预算：注入段 cap/percent 与观察缓冲 cap/percent', () => {
    const dir = tmp();
    try {
      const store = new MemoryStore(dir);
      store.addLongTermMemory('procedures', 'step one');
      store.addEntry({ id: 'o1', timestamp: new Date().toISOString(), type: 'note', content: 'obs' });
      const h = store.getMemoryHealth();
      expect(h.curatedCap).toBe(MEMORY_MD_CURATED_MAX_CHARS);
      expect(h.observationCap).toBe(MEMORY_OBSERVATIONS_MAX_CHARS);
      expect(h.curatedSections).toBeGreaterThanOrEqual(1);
      expect(h.observations).toBe(1);
      expect(h.curatedChars).toBeGreaterThan(0);
      expect(h.percent).toBeGreaterThanOrEqual(0);
      expect(h.percent).toBeLessThan(100);
      expect(h.archiveChars).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('观察积压**不再**虚高注入段健康度（旧行为：percent ≥ 70，已被本用例推翻）', () => {
    const dir = tmp();
    try {
      const store = new MemoryStore(dir);
      // 200 × 120 字符的观察 —— 远超注入预算，但它们**不注入**。
      for (let i = 0; i < 200; i++) {
        store.addEntry({
          id: `o${i}`,
          timestamp: new Date().toISOString(),
          type: 'note',
          content: 'x'.repeat(120),
        });
      }
      const h = store.getMemoryHealth();
      // 注入段几乎为空 → 健康度必须低。绝不能因为观察多就报 >100%。
      expect(h.percent).toBeLessThan(20);
      expect(h.curatedChars).toBeLessThan(MEMORY_MD_CURATED_MAX_CHARS);
      // 观察缓冲有它自己的信号（此刻才可能接近/超过 70%）。
      expect(h.observationPercent).toBeGreaterThanOrEqual(h.percent);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('观察缓冲区超限时，最旧观察被无损归档且仍可检索', () => {
    const dir = tmp();
    try {
      const store = new MemoryStore(dir);
      for (let i = 0; i < 400; i++) {
        store.addEntry({
          id: `o${i}`,
          timestamp: new Date().toISOString(),
          type: 'note',
          content: `marker-${i} ` + 'y'.repeat(180),
        });
      }
      const h = store.getMemoryHealth();
      // §24 — 平台不再搬运：400 条全部留在原地（旧行为：裁到上限内 + 归档最旧的）
      expect(h.observations).toBe(400);
      // 内容仍全部可检索（不再靠"归档"保证）—— 最旧的 marker-0 找得到
      const results = store.search('marker-0');
      expect(results.length).toBeGreaterThan(0);
      // 越过软线只报告：占用可以超过软线 —— 这是 Agent 自己的账，平台不替他处理
      expect(h.observationChars).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS);
      expect(h.observationCap).toBe(MEMORY_OBSERVATIONS_MAX_CHARS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
