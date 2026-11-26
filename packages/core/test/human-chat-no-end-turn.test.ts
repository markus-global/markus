import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolSelector } from '../src/tool-selector.js';
import { Agent } from '../src/agent.js';
import { createSessionWorkspace, sessionWorkspaceStore } from '../src/session-workspace.js';
import type { RoleTemplate } from '@markus/shared';
import type { LLMRouter } from '../src/llm/router.js';

/**
 * Owner 2026-11-18：「human chat 应该只能 finish reason 是 stop，不应该允许用 end_turn」。
 *
 * 为什么这是对的（不是口味问题）：人类对话里，回复文本**就是交付物**；`end_turn` 的语义是
 * 「这一轮不发送任何消息」。在 A2A 里那是有意义的（防审犯式来回），在人类对话里等于
 * 「用户看到一片空白」—— 2026-11-18 真机就发生过：答完某事连续三次 end_turn 收尾，
 * Owner 侧什么都没有。
 *
 * 两道闸，缺一不可：
 *   ① 工具面：`human_chat` 回合**根本不提供** end_turn（模型无从选择）；
 *   ② 执行侧：模型从历史里学到 end_turn 也会自己吐出来（幻觉工具名，2026-11-17 真机见过），
 *      所以 runTool 必须拒绝并给出可行动的替代。
 */

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-no-endturn-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE: RoleTemplate = {
  id: 'no-endturn-role',
  name: 'No EndTurn Role',
  description: 'Role for human-chat end_turn tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

function makeToolMap(names: string[]) {
  const map = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
  for (const name of names) {
    map.set(name, { name, description: `Description for ${name}`, inputSchema: { type: 'object', properties: {} } });
  }
  return map;
}

const TOOLS = ['agent_send_message', 'task_list', 'end_turn', 'notify_user', 'open_right_panel'];

describe('① 工具面：human_chat 不提供 end_turn', () => {
  it('humanFacing=true → end_turn 不在工具面里（其余工具不受影响）', () => {
    const selector = new ToolSelector();
    const selected = selector.selectTools({
      allTools: makeToolMap(TOOLS),
      userMessage: '给我讲讲这个 bug',
      pack: 'converse',
      isChat: true,
      humanFacing: true,
    });
    const names = selected.map(t => t.name);
    expect(names).not.toContain('end_turn');
    // 反例：别的工具没被顺手削掉（证明不是整包失效）
    expect(names).toContain('agent_send_message');
  });

  it('humanFacing=false（A2A / 心跳 / loop）→ end_turn 仍然提供', () => {
    const selector = new ToolSelector();
    const selected = selector.selectTools({
      allTools: makeToolMap(TOOLS),
      userMessage: 'status?',
      pack: 'converse',
      scenario: 'a2a',
      humanFacing: false,
    });
    expect(selected.map(t => t.name)).toContain('end_turn');
  });
});

describe('② 执行侧：人类对话里幻觉调用 end_turn 不被采信', () => {
  function makeAgent(): Agent {
    const router = {
      chat: async () => ({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
      chatStream: async () => ({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
      getActiveModelContextWindow: () => 200000,
      getActiveModelName: () => 'test-model',
      getActiveModelMaxOutput: () => 8000,
      getModelContextWindow: () => 200000,
      getModelMaxOutput: () => 8000,
      getModelCost: () => undefined,
      isCompactionSupported: () => true,
      modelSupportsVision: () => false,
      listProviders: () => ['test'],
      getProvider: () => undefined,
      getDefaultProvider: () => 'test',
      defaultProviderName: 'test',
    } as unknown as LLMRouter;

    return new Agent({
      config: {
        id: 'no-endturn-agent',
        name: 'No EndTurn Agent',
        role: 'worker',
        llmConfig: { provider: 'anthropic', model: 'test-model', apiKey: 'test' },
        createdAt: new Date().toISOString(),
      },
      role: MOCK_ROLE,
      llmRouter: router,
      dataDir: tempDir,
    });
  }

  type Private = {
    runTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, onOutput?: unknown, sessionId?: string) => Promise<string>;
    endTurnRequested: boolean;
  };

  it('human 回合调用 end_turn → 返回 error，且 endTurnRequested 保持 false', async () => {
    const agent = makeAgent() as unknown as Private;
    const ws = createSessionWorkspace(2);
    ws.humanFacing = true;

    const out = await sessionWorkspaceStore.run(ws, () =>
      agent.runTool({ id: 't1', name: 'end_turn', arguments: { reason: 'nothing to add' } }, undefined, 'sess_x'),
    );

    expect(out).toContain('error');
    expect(out.toLowerCase()).toContain('not available');
    // 关键：没有把回合标成「已结束」——否则 reply 会被清空、用户看到空白。
    // 状态必须**在同一个工作区里**读：它是 per-workspace 事实，在外面读到的
    // 是 rootWorkspace（测试自己踩过这个坑）。
    const requested = sessionWorkspaceStore.run(ws, () => agent.endTurnRequested);
    expect(requested).toBe(false);
  });

  it('非 human 回合（A2A）调用 end_turn → 正常生效', async () => {
    const agent = makeAgent() as unknown as Private;
    const ws = createSessionWorkspace(3);
    ws.humanFacing = false;

    const out = await sessionWorkspaceStore.run(ws, () =>
      agent.runTool({ id: 't2', name: 'end_turn', arguments: { reason: 'loop closed' } }, undefined, 'sess_y'),
    );

    expect(out).toContain('ended');
    const requested = sessionWorkspaceStore.run(ws, () => agent.endTurnRequested);
    expect(requested).toBe(true);
  });
});
