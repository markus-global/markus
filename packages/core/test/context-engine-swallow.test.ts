/**
 * 取数路径吞错的 **prompt 侧**守卫：「没读到」不得被渲染成「确实没有」。
 *
 * 审计 §3 的判据：`catch` 里返回空集合，等于对用户陈述一个你不知道的事实。
 * 在 prompt 组装这里，那句假话叫 `No tasks on the board.` —— agent 读到它，
 * 就会自认手上没活，然后在心跳里「确认无事可做」。用户看到的是一份安静的错误报告。
 *
 * 这组断言为什么**会咬人**：
 *   - 把 `FetchResult` 的 error 分支删掉（退回裸数组 / 只判 `items.length > 0`）→
 *     error 态落进 `No tasks on the board.` 分支 → 第一条用例红；
 *   - 把两态折叠成「空就是没有」（`state` 读取处改成恒真）→ 第一、二条一起红。
 * 改坏 → `npx tsc -b` 重建 → 红 → 复原 → 重建 → 绿（报告 §5 有实录）。
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
  id: 'ctx-swallow-role',
  name: 'Swallow Test Role',
  description: 'Role for the fetch-swallow guard',
  category: 'engineering',
  systemPrompt: 'You are a helpful engineering assistant.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-ctx-swallow-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeEngine() {
  return new ContextEngine({ memorySearchTopK: 3 });
}

describe('Task board —— 「读失败」与「没有任务」是两件事', () => {
  it('error 态：prompt 必须说出失败，且不得渲染「No tasks on the board.」', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'Agent',
      role: MOCK_ROLE,
      memory,
      assignedTasks: { state: 'error', items: [], message: 'database is locked' },
      scenario: 'task_execution',
    });

    expect(result.volatile).toContain('read FAILED');
    // 带上原因，让 agent 知道这是可诊断的失败，不是「没事」。
    expect(result.volatile).toContain('database is locked');
    // 关键反向断言：不许把「没读到」渲染成「确实没有」。
    expect(result.volatile).not.toContain('No tasks on the board.');
  });

  it('ok 且 0 条：这时才允许说「No tasks on the board.」（确认两态没被折叠）', async () => {
    const memory = new MemoryStore(tempDir);
    const engine = makeEngine();

    const result = await engine.buildSystemPrompt({
      agentId: 'agt_1',
      agentName: 'Agent',
      role: MOCK_ROLE,
      memory,
      assignedTasks: { state: 'ok', items: [] },
      scenario: 'task_execution',
    });

    expect(result.volatile).toContain('No tasks on the board.');
    expect(result.volatile ?? '').not.toContain('read FAILED');
  });
});
