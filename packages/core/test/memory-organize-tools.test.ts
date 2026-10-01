/**
 * P1-1 回归：memory_stats / memory_organize —— 记忆整理工具化。
 *
 * 方案（agent-self-management-redesign.md §三 P1-1）：
 *  1. memory_stats：暴露 knowledge.md 预算用量 / observation 数 / curated section 数（记忆健康度）
 *  2. memory_organize：把观测合并进目标 curated section 并归档（_observations → 精选知识）
 */
import { describe, it, expect, vi } from 'vitest';
import { createMemoryTools } from '../src/tools/memory.js';
import type { IMemoryStore, MemoryEntry } from '../src/memory/types.js';
import type { SemanticMemorySearch } from '../src/memory/semantic-search.js';
import { MEMORY_MD_TOTAL_MAX_CHARS } from '@markus/shared';

function makeObs(id: string, content: string, type: MemoryEntry['type'] = 'fact'): MemoryEntry {
  return { id, timestamp: '2026-09-27T00:00:00.000Z', type, content };
}

/** 带状态的 memory mock：实现 addLongTermMemory 的真实「同 section 替换」语义。 */
function createStatefulMemory(entries: MemoryEntry[], initialLtm = ''): IMemoryStore & { ltm: string } {
  let data = [...entries];
  const state = { ltm: initialLtm };

  /** 真实 setLongTermMemory 语义：已有同名 section → 整体替换；否则追加。纯字符串操作避免转义。 */
  const setSection = (key: string, content: string): void => {
    const header = '## ' + key + '\n';
    const idx = state.ltm.indexOf(header);
    if (idx >= 0) {
      const head = state.ltm.slice(0, idx);
      const restStart = idx + header.length;
      const nextSection = state.ltm.indexOf('\n## ', restStart);
      const rest = nextSection >= 0 ? state.ltm.slice(nextSection) : '';
      state.ltm = head + header + content + (rest ? '\n' + rest.slice(1) : '');
    } else {
      state.ltm = (state.ltm.length > 0 ? state.ltm + '\n' : '') + header + content;
    }
  };

  return {
    ltm: state.ltm,
    addEntry: vi.fn((e: MemoryEntry) => { data.push(e); }),
    getEntries: vi.fn((type?: string) => (type ? data.filter(e => e.type === type) : [...data])),
    search: vi.fn(() => []),
    getEntriesByTag: vi.fn(() => []),
    getObservations: vi.fn(() => [...data]),
    removeEntries: vi.fn((ids: string[]) => {
      const idSet = new Set(ids);
      const before = data.length;
      data = data.filter(e => !idSet.has(e.id));
      return before - data.length;
    }),
    removeEntriesByTag: vi.fn(() => 0),
    replaceEntries: vi.fn(),
    getStoreFileName: vi.fn(() => 'knowledge.md'),
    // 预算 SSOT：真实 MemoryStore 以「文件原始大小」为准（与提示词横幅 / 写入端强制归档一致）。
    getMemoryHealth: vi.fn(() => {
      const totalChars = state.ltm.length;
      const cap = MEMORY_MD_TOTAL_MAX_CHARS;
      return {
        totalChars,
        cap,
        percent: Math.round((totalChars / cap) * 100),
        observations: data.length,
        curatedSections: (state.ltm.match(/^## /gm) ?? []).length,
        archiveChars: 0,
        lastConsolidatedAt: null,
      };
    }),
    addLongTermMemory: vi.fn((key: string, content: string) => {
      setSection(key, content);
      return { ok: true };
    }),
    getLongTermMemory: vi.fn(() => state.ltm),
    getLongTermSection: vi.fn((key: string) => {
      const header = '## ' + key + '\n';
      const idx = state.ltm.indexOf(header);
      if (idx < 0) return '';
      const start = idx + header.length;
      const next = state.ltm.indexOf('\n## ', start);
      return (next >= 0 ? state.ltm.slice(start, next) : state.ltm.slice(start)).trim();
    }),
    getLongTermMemoryExcluding: vi.fn(() => state.ltm),
    compressLongTermMemory: vi.fn(() => ({
      charsBefore: 0, charsAfter: 0, sectionsBefore: 0, sectionsAfter: 0, truncatedChunks: 0,
    })),
    removeLongTermSection: vi.fn(() => ({ ok: true, removedChars: 0 })),
    createSession: vi.fn(), getSession: vi.fn(), appendMessage: vi.fn(),
    getRecentMessages: vi.fn(), listSessions: vi.fn(), getLatestSession: vi.fn(),
    getLatestMainSession: vi.fn(), getOrCreateSession: vi.fn(), compactSession: vi.fn(),
    summarizeAndTruncate: vi.fn(), writeDailyLog: vi.fn(), getDailyLog: vi.fn().mockReturnValue(''),
    getRecentDailyLogs: vi.fn().mockReturnValue(''),
  } as unknown as IMemoryStore & { ltm: string };
}

const NO_SEMANTIC = undefined as unknown as SemanticMemorySearch;

function toolsWith(memory: IMemoryStore): ReturnType<typeof createMemoryTools> {
  return createMemoryTools({ agentId: 't1', agentName: 'T', memory, semanticSearch: NO_SEMANTIC });
}

describe('memory_stats（P1-1 记忆健康度）', () => {
  it('返回预算用量百分比与观测数', async () => {
    const mem = createStatefulMemory(
      [makeObs('o1', 'a'.repeat(50)), makeObs('o2', 'b'.repeat(50))],
      '## procedures\nstep\n',
    );
    const tools = toolsWith(mem);
    const tool = tools.find(t => t.name === 'memory_stats')!;
    const res = JSON.parse(await tool.execute({}));
    expect(res.status).toBe('ok');
    expect(res.observations.count).toBe(2);
    expect(res.budget.limit).toBeGreaterThan(0);
    expect(res.budget.usedPercent).toBeGreaterThanOrEqual(0);
    expect(res.curatedSections.count).toBe(1); // procedures
  });

  it('预算口径与 getMemoryHealth 完全一致（SSOT 对齐，审计 P-16）', async () => {
    // 回归：曾出现 memory_stats 自算一套（仅内容字符）而横幅/强制归档用文件大小，
    // 导致同一指标给出 95% vs 122% 的自相矛盾。预算必须只有一个来源。
    const mem = createStatefulMemory([makeObs('o1', 'x'.repeat(30))], '## a\n' + 'y'.repeat(200));
    const tools = toolsWith(mem);
    const tool = tools.find(t => t.name === 'memory_stats')!;
    const res = JSON.parse(await tool.execute({}));
    const h = mem.getMemoryHealth();
    expect(res.budget.totalChars).toBe(h.totalChars);
    expect(res.budget.limit).toBe(h.cap);
    expect(res.budget.usedPercent).toBe(h.percent);
    expect(res.archivedChars).toBe(h.archiveChars);
    expect(res.lastConsolidatedAt).toBe(h.lastConsolidatedAt);
  });

  it('超过 80% 预算时给出整理提示', async () => {
    const mem = createStatefulMemory([], '## big\n' + 'x'.repeat(14000));
    const tools = toolsWith(mem);
    const tool = tools.find(t => t.name === 'memory_stats')!;
    const res = JSON.parse(await tool.execute({}));
    expect(res.status).toBe('ok');
    expect(res.budget.usedPercent).toBeGreaterThan(80);
    expect(res.hint).toContain('memory_organize');
  });
});

describe('memory_organize（P1-1 观测 → 精选知识）', () => {
  it('按 query 合并匹配观测并归档（removeEntries 被调用）', async () => {
    const mem = createStatefulMemory(
      [
        makeObs('o1', 'user prefers dark mode'),
        makeObs('o2', 'unrelated topic'),
        makeObs('o3', 'preferences: use pnpm'),
      ],
      '## preferences\n- legacy\n',
    );
    const tools = toolsWith(mem);
    const tool = tools.find(t => t.name === 'memory_organize')!;
    const res = JSON.parse(await tool.execute({ target_section: 'preferences', query: 'prefer' }));
    expect(res.status).toBe('organized');
    expect(res.moved).toBeGreaterThanOrEqual(1); // o1, o3
    expect(res.archived).toBe(res.moved);
    expect(res.section).toBe('preferences');
    // 只留下 o2（不匹配）
    expect(mem.getObservations().map(e => e.id)).toEqual(['o2']);
    // 合并进 curated section（真实替换语义，legacy 被替换为 merged 内容）
    const section = mem.getLongTermSection('preferences');
    expect(section).toContain('dark mode');
    expect(section).toContain('pnpm');
  });

  it('target_section 缺失或为 _observations 时报错', async () => {
    const tools = toolsWith(createStatefulMemory([makeObs('o1', 'x')]));
    const tool = tools.find(t => t.name === 'memory_organize')!;
    const noTarget = JSON.parse(await tool.execute({}));
    expect(noTarget.status).toBe('error');
    const obsTarget = JSON.parse(await tool.execute({ target_section: '_observations' }));
    expect(obsTarget.status).toBe('error');
  });

  it('按 ids 精确合并（不靠 query）', async () => {
    const mem = createStatefulMemory([makeObs('o1', 'aaa'), makeObs('o2', 'bbb')]);
    const tools = toolsWith(mem);
    const tool = tools.find(t => t.name === 'memory_organize')!;
    const res = JSON.parse(await tool.execute({ target_section: 'notes', ids: ['o2'] }));
    expect(res.status).toBe('organized');
    expect(res.moved).toBe(1);
    expect(mem.getObservations().map(e => e.id)).toEqual(['o1']);
  });

  it('无匹配观测时不写库、不删条目', async () => {
    const mem = createStatefulMemory([makeObs('o1', 'zzz')]);
    const tools = toolsWith(mem);
    const tool = tools.find(t => t.name === 'memory_organize')!;
    const res = JSON.parse(await tool.execute({ target_section: 'notes', query: 'nomatch' }));
    expect(res.status).toBe('ok');
    expect(res.moved).toBe(0);
    expect(mem.addLongTermMemory).not.toHaveBeenCalled();
  });
});
