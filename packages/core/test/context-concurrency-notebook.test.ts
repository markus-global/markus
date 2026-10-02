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
        handoffs: [],
        notebook: [],
      },
    });
    expect(result.text).not.toContain('Concurrency Context');
    const v = result.volatile ?? '';
    expect(v).toContain('## Concurrency Context（并发上下文）');
    expect(v).not.toContain('分身共享工作记忆');
  });
});
