/**
 * P1-2 回归：并发上下文注入「分身共享工作记忆」快照。
 *
 * 方案（agent-self-management-redesign.md §三 P1-2）：notebook（NOTEBOOK.md/工作记忆）
 * 是 agent 级共享的——每个分身写的是同一份——但上下文默认不注入，分身之间互不知晓
 * （「我不知道另一个我在干嘛」）。并发模式下把最近更新条目注入 Concurrency Context 段。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'ctx-role',
  name: 'Context Test Role',
  description: 'Role for context engine tests',
  category: 'engineering',
  systemPrompt: 'You are a helpful engineering assistant.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-ctx-cc-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('P1-2 · 并发上下文注入分身共享工作记忆', () => {
  it('workerCount>1 且有 notebook 快照 → 注入「分身共享工作记忆」段（限量、截断）', async () => {
    const engine = new ContextEngine({ memorySearchTopK: 3 });
    const memory = new MemoryStore(tempDir);
    const now = Date.now();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_cc',
      agentName: 'CC Agent',
      role: MOCK_ROLE,
      memory,
      currentQuery: 'hi',
      concurrentContext: {
        enabled: true,
        workerId: 1,
        workerCount: 3,
        liveClaims: [],
        handoffs: [
          {
            workerId: 2,
            kind: 'done',
            entityKey: 'task:tsk_1',
            summary: '处理完成：xxx',
          },
        ],
        notebook: [
          {
            key: 'poly-brief',
            text: 'Polymarket 每日投资报告的口径与输出格式，09:00 执行。这是一段比较长的说明文字用于验证截断逻辑是否真的会生效并且不会把整个段落都灌进上下文里去。',
            updatedAt: now,
            managed: 'agent',
          },
          {
            key: 'old-note',
            text: '过时条目，应被 limit 排后或不显示',
            updatedAt: now - 1000 * 60 * 60 * 24, // 1 day ago
            managed: 'agent',
          },
        ],
      },
    });

    // 并发段在 volatile 尾部（不污染 stable/semiStable 前缀缓存）——
    // buildSystemPrompt 的 result.text 只含 stable+semiStable，volatile 单独在 result.volatile。
    expect(result.text).not.toContain('Concurrency Context');
    const v = result.volatile ?? '';
    expect(v).toContain('## Concurrency Context（并发上下文）');
    expect(v).toContain('分身共享工作记忆');
    expect(v).toContain('poly-brief');
    // 截断：text 长度不超过 ~140 字符
    const line = v.split('\n').find((l) => l.includes('poly-brief')) ?? '';
    expect(line.length).toBeLessThan(220);
  });

  it('workerCount<=1 → 不注入并发段（串行模式与旧行为一致）', async () => {
    const engine = new ContextEngine({ memorySearchTopK: 3 });
    const memory = new MemoryStore(tempDir);
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_cc',
      agentName: 'CC Agent',
      role: MOCK_ROLE,
      memory,
      currentQuery: 'hi',
      concurrentContext: {
        enabled: false,
        workerId: 1,
        workerCount: 1,
        liveClaims: [],
        handoffs: [],
        notebook: [{ key: 'k', text: 't', updatedAt: Date.now(), managed: 'agent' }],
      },
    });
    expect(result.text).not.toContain('Concurrency Context');
    expect(result.text).not.toContain('分身共享工作记忆');
  });

  it('notebook 为空 → 注入并发段但无快照子段', async () => {
    const engine = new ContextEngine({ memorySearchTopK: 3 });
    const memory = new MemoryStore(tempDir);
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_cc',
      agentName: 'CC Agent',
      role: MOCK_ROLE,
      memory,
      currentQuery: 'hi',
      concurrentContext: {
        enabled: true,
        workerId: 1,
        workerCount: 2,
        liveClaims: [],
        handoffs: [],
        notebook: [],
      },
    });
    expect(result.text).not.toContain('Concurrency Context');
    const v = result.volatile ?? '';
    expect(v).toContain('## Concurrency Context（并发上下文）');
    expect(v).not.toContain('分身共享工作记忆');
  });

  // ── 2026-11-17 真机事故回归：在途 = 实时状态，不是历史 ─────────────────────
  // 现场：同一对话串同时出现在「正在进行中」与「已完成」两处 —— 旧实现把
  // `handoffs` 里的 `declared` 当成「正在处理」，而 `done` 另起一段。分身读到
  // 「正在处理」就停手，向 Owner 宣称「由另一个 worker 处理」。
  it('交接历史里出现过的实体绝不得被渲染成「正在处理」', async () => {
    const engine = new ContextEngine({ memorySearchTopK: 3 });
    const memory = new MemoryStore(tempDir);
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_cc',
      agentName: 'CC Agent',
      role: MOCK_ROLE,
      memory,
      currentQuery: 'hi',
      concurrentContext: {
        enabled: true,
        workerId: 2,
        workerCount: 5,
        // 权威在途：无。但历史里既有 declared 也有 done（同一个实体）。
        liveClaims: [],
        handoffs: [
          { workerId: 1, kind: 'declared', entityKey: 'conv:cs_abc', summary: 'human_chat: "仍然很卡"' },
          { workerId: 1, kind: 'done', entityKey: 'conv:cs_abc', summary: '处理完成：human_chat: "仍然很卡"' },
        ],
      },
    });

    const v = result.volatile ?? '';
    // 必须声明「此刻无人占用」，且不能再出现旧的「正在进行中的其他分身」段
    expect(v).toContain('此刻真正被占用');
    expect(v).toContain('（无：');
    expect(v).not.toContain('正在进行中的其他分身');
    // 历史段只能说「过去」，且该实体只能出现在历史段里（不能又冒出一句「在途」）
    expect(v).toContain('交接历史');
    const inFlightSection = v.slice(v.indexOf('此刻真正被占用'), v.indexOf('交接历史'));
    expect(inFlightSection).not.toContain('conv:cs_abc');
  });

  it('实时 claim 才渲染为占用（worker/subject 均可见，且排除自己）', async () => {
    const engine = new ContextEngine({ memorySearchTopK: 3 });
    const memory = new MemoryStore(tempDir);
    const result = await engine.buildSystemPrompt({
      agentId: 'agt_cc',
      agentName: 'CC Agent',
      role: MOCK_ROLE,
      memory,
      currentQuery: 'hi',
      concurrentContext: {
        enabled: true,
        workerId: 2,
        workerCount: 5,
        liveClaims: [
          { workerId: 1, entityKeys: ['conv:cs_live', 'session:sess_1'], itemType: 'human_chat', startedAt: Date.now() },
        ],
        handoffs: [],
      },
    });

    const v = result.volatile ?? '';
    expect(v).toContain('worker 1 → conv:cs_live, session:sess_1（human_chat）');
    // 没有占用的两个反例都不应出现
    expect(v).not.toContain('（无：');
  });
});
