/**
 * `notify_user` 的上下文契约（2026-10-28 GEO策略主管 12 连发事故回归）。
 *
 * 事故见 `docs/architecture/notify-user-context-truth.md`。一句话根因：
 * 通知的处理函数把「通知载荷」当作 assistant 发言插进了
 * `assistant(toolCalls) → tool(回执)` 的**中间**，`sanitizeMessageSequence()`
 * 因此把整块 toolCalls 连回执一起丢弃 —— 模型永远看不到「已送达」，
 * 于是无限重发。
 *
 * 这里锁的是**生产侧的结构不变量**，不是某个实现细节：
 *   1. 通知正文不得作为 assistant 消息进入 agent 自己的会话；
 *   2. toolCalls 的下一条必须是它自己的回执（配对不被打断）；
 *   3. 经过 prepareMessages 打包后回执仍然存活（真正咬人的一条）；
 *   4. 回执携带真实送达信息，模型据此知道已经发过。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage, RoleTemplate } from '@markus/shared';

const MOCK_ROLE: RoleTemplate = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Test role for notify_user context tests',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

const TITLE = '需要一条产品口径：Free 层数量上限';
const BODY = '老板，Free 层的 Agent/Team/Project 数量上限是多少？';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-notify-context-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeRouter(responses: Array<Record<string, unknown>>) {
  let i = 0;
  return {
    chat: vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { usage: { inputTokens: 100, outputTokens: 50 }, ...r };
    }),
    chatStream: vi.fn(),
    getActiveModelContextWindow: () => 200_000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8_000,
    getModelContextWindow: () => 200_000,
    getModelMaxOutput: () => 8_000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
  } as unknown as import('../src/llm/router.js').LLMRouter;
}

function makeAgent(router: unknown) {
  return new Agent({
    config: {
      id: 'notify-context-agent',
      name: 'Notify Context Agent',
      role: 'worker',
      llmConfig: { provider: 'anthropic', model: 'test-model', apiKey: 'test' },
      createdAt: new Date().toISOString(),
    },
    role: MOCK_ROLE,
    llmRouter: router as import('../src/llm/router.js').LLMRouter,
    dataDir: tempDir,
  });
}

/** 跑一轮：模型先调 notify_user，再结束。返回该会话的原始消息。 */
async function runNotifyTurn(): Promise<LLMMessage[]> {
  const router = makeRouter([
    {
      content: '我把结论上报给老板。',
      finishReason: 'tool_use',
      toolCalls: [
        { id: 'tc_notify_1', name: 'notify_user', arguments: { title: TITLE, body: BODY } },
      ],
    },
    { content: '已上报。', finishReason: 'end_turn' },
  ]);
  const agent = makeAgent(router);
  await agent.handleMessage('把 Free 层口径的问题上报给老板');
  const sid = agent.getCurrentSessionId();
  expect(sid, 'turn produced no session').toBeTruthy();
  return [...agent.getMemory().getSession(sid!)!.messages];
}

const isToolMsg = (m: LLMMessage) => m.role === 'tool';

describe('notify_user 不在会话里伪造 assistant 发言', () => {
  it('通知正文不得以 assistant 消息进入 agent 自己的会话', async () => {
    const messages = await runNotifyTurn();

    const forged = messages.filter(
      m => m.role === 'assistant' && String(m.content ?? '').includes(BODY.slice(0, 12)),
    );
    expect(forged, '通知载荷被写成了「我说过的话」（载荷冒充结构）').toHaveLength(0);
  });

  it('toolCalls 的下一条必须是它自己的回执 —— 配对不被打断', async () => {
    const messages = await runNotifyTurn();

    const callIdx = messages.findIndex(
      m => m.role === 'assistant' && (m.toolCalls ?? []).some(tc => tc.name === 'notify_user'),
    );
    expect(callIdx, 'notify_user call not found in session').toBeGreaterThan(-1);

    const next = messages[callIdx + 1];
    expect(next, 'toolCalls 后面没有消息').toBeTruthy();
    expect(next!.role, 'toolCalls 与回执之间被插入了别的消息').toBe('tool');
    expect(isToolMsg(next!)).toBe(true);
    expect(String(next!.content)).toContain('Notification');
  });

  it('回执携带真实送达信息，模型据此知道「已经发过」', async () => {
    const messages = await runNotifyTurn();

    const receipt = messages.find(m => m.role === 'tool' && String(m.content).includes(TITLE));
    expect(receipt, '回执里没有标题 —— 模型无法确认发的是哪一条').toBeTruthy();
    const parsed = JSON.parse(String(receipt!.content)) as Record<string, unknown>;
    expect(parsed.status).toBe('ok');
    const n = parsed.notification as Record<string, unknown> | undefined;
    expect(n, '回执缺少 notification 送达块').toBeTruthy();
    expect(n!.id, '回执缺少送达 id').toBeTruthy();
    expect(n!.title).toBe(TITLE);
    expect(n!.deliveredAt, '回执缺少送达时间').toBeTruthy();
  });
});

describe('打包后的请求必须保住回执（被打包器丢弃的解药）', () => {
  const memoryStub = {
    serializeSlots: () => '',
    serializeSummary: () => '',
  } as never;

  const pack = (sessionMessages: LLMMessage[]) =>
    new ContextEngine().prepareMessages({
      systemPrompt: 'sys',
      sessionMessages,
      memory: memoryStub,
      sessionId: 'sess_notify_truth',
      modelContextWindow: 1_000_000,
      modelMaxOutput: 32_768,
    });

  it('真实一轮对话打包后，通知回执仍在请求里', async () => {
    const messages = await runNotifyTurn();
    const prepared = await pack(messages);

    const receipt = prepared.messages.find(
      m => m.role === 'tool' && String(m.content).includes(TITLE),
    );
    expect(receipt, '回执在打包阶段被丢掉了 —— 模型于是会重发').toBeTruthy();
  });

  it('回归样本：载荷插在配对中间时，配对与回执都会消失（这就是必须杜绝的顺序）', async () => {
    // 这是事故中的真实顺序，作为反例固化下来：一旦有人把载荷写回对话流，
    // 打包器就会按协议丢弃整块 —— 断言这个行为，才能说明「为什么必须删掉那行写入」。
    const buggy: LLMMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'notify_user', arguments: {} }],
      } as unknown as LLMMessage,
      { role: 'assistant', content: `${TITLE}\n\n${BODY}` },
      { role: 'tool', content: '{"status":"ok","message":"Notification sent to user."}', toolCallId: 'tc1' } as unknown as LLMMessage,
    ];
    const prepared = await pack(buggy);
    expect(
      prepared.messages.some(m => m.role === 'tool'),
      '打包器对孤立 tool 消息的处理变了 —— 请重新评估本文的根因推导',
    ).toBe(false);
  });
});
