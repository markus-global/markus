/**
 * MemoryStore.getMemoryHealth (审计 P-12) —— 驱动提示词内「记忆健康」信号。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';
import { MEMORY_MD_TOTAL_MAX_CHARS, MEMORY_OBSERVATIONS_MAX_CHARS } from '@markus/shared';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-health-'));
}

describe('MemoryStore.getMemoryHealth (P-12)', () => {
  it('报告 cap / 百分比 / 观察数 / 知识段数', () => {
    const dir = tmp();
    try {
      const store = new MemoryStore(dir);
      store.addLongTermMemory('procedures', 'step one');
      store.addEntry({ id: 'o1', timestamp: new Date().toISOString(), type: 'note', content: 'obs' });
      const h = store.getMemoryHealth();
      expect(h.cap).toBe(MEMORY_MD_TOTAL_MAX_CHARS);
      expect(h.curatedSections).toBeGreaterThanOrEqual(1);
      expect(h.observations).toBe(1);
      expect(h.percent).toBeGreaterThan(0);
      expect(h.percent).toBeLessThan(100);
      expect(h.archiveChars).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('观察积压导致超预算时 percent ≥ 70（触发提示词告警）', () => {
    const dir = tmp();
    try {
      const store = new MemoryStore(dir);
      // 观察缓冲区不被 compress 归档，是超预算的主要来源之一。
      for (let i = 0; i < 200; i++) {
        store.addEntry({
          id: `o${i}`,
          timestamp: new Date().toISOString(),
          type: 'note',
          content: 'x'.repeat(120),
        });
      }
      const h = store.getMemoryHealth();
      expect(h.percent).toBeGreaterThanOrEqual(70);
      expect(h.totalChars).toBeGreaterThan(MEMORY_MD_TOTAL_MAX_CHARS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('观察缓冲区超限时，最旧观察被无损归档且仍可检索（P-10）', () => {
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
      // 缓冲区被裁剪到上限以内（不再无界增长）
      expect(h.observations).toBeLessThan(400);
      // 内容仍在归档中（无损）——最旧的 marker-0 可被检索到
      const results = store.search('marker-0');
      expect(results.length).toBeGreaterThan(0);
      expect(h.archiveChars).toBeGreaterThan(0);
      expect(h.totalChars).toBeLessThanOrEqual(MEMORY_OBSERVATIONS_MAX_CHARS + 20_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
