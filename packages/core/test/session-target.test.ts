import { describe, it, expect } from 'vitest';
import { resolveTarget, loopSessionId, isLoopSession, LOOP_SESSION_PREFIX, type SignalTargetInput } from '../src/session-target.js';

/**
 * M1 契约测试：`resolveTarget` 是「一条信号落哪条会话」的**唯一判定点**。
 *
 * 这里钉住三件事，每条都对着一类曾经真实发生过的故障：
 *   1. **有实体 → 确定会话**（防「凭空开一条会话 ⇒ agent 失忆」）
 *   2. **无实体 → null**（防「没有归属的信号被塞进谁都不认的会话 ⇒ Loop 永远无事可做」）
 *   3. **同输入 → 同字节输出**（防「同一语义两种拼装 ⇒ 缓存命中率腰斩」）
 */

const AGENT = 'agt_test';
const TS = 1_700_000_000_000;

/** 构造入参：只写关心的字段，其余留空。 */
function sig(over: Partial<SignalTargetInput>): SignalTargetInput {
  return { sourceType: 'system_event', agentId: AGENT, ts: TS, ...over };
}

describe('resolveTarget — 有归属的信号：会话 id 确定', () => {
  it('human_chat 由绑定层给会话，且算有归属', () => {
    const t = resolveTarget(sig({ sourceType: 'human_chat', channelSessionId: 'cs_abc' }));
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('human_chat');
    expect(t!.sessionId).toBe('cs_abc');
  });

  it('session_reply 落回原会话', () => {
    const t = resolveTarget(sig({ sourceType: 'session_reply', originSessionId: 'sess_origin' }));
    expect(t!.sessionId).toBe('sess_origin');
    expect(t!.kind).toBe('session_reply');
  });

  it('callback_result 落回发起会话', () => {
    const t = resolveTarget(sig({ sourceType: 'callback_result', originSessionId: 'sess_cb' }));
    expect(t!.sessionId).toBe('sess_cb');
    expect(t!.kind).toBe('callback');
  });

  it('task_status_update 有在飞登记 → 直接复用那条执行会话（不新开）', () => {
    const t = resolveTarget(sig({
      sourceType: 'task_status_update',
      intent: 'trigger_execution',
      taskId: 'tsk_1',
      round: 2,
      liveTaskSessionId: 'task_tsk_1_r2_live',
    }));
    expect(t!.kind).toBe('task_execution');
    expect(t!.sessionId).toBe('task_tsk_1_r2_live');
    expect(t!.entityId).toBe('task:tsk_1');
    expect(t!.taskId).toBe('tsk_1');
    expect(t!.round).toBe(2);
  });

  it('task_comment 有在飞登记 → 注入同一会话（同一件事排在自己后面就是死锁）', () => {
    const t = resolveTarget(sig({
      sourceType: 'task_comment',
      taskId: 'tsk_1',
      liveTaskSessionId: 'task_tsk_1_r1_live',
    }));
    expect(t!.kind).toBe('task_execution');
    expect(t!.sessionId).toBe('task_tsk_1_r1_live');
  });

  it('task_comment 无在飞登记 → 为这张任务开评论回合（不丢留言）', () => {
    const t = resolveTarget(sig({ sourceType: 'task_comment', taskId: 'tsk_9' }));
    expect(t!.kind).toBe('task_comment');
    expect(t!.sessionId).toBe(`comment_tsk_9_${TS}`);
    expect(t!.entityId).toBe('task:tsk_9');
  });

  it('review_request 的会话 id 与时间戳无关 —— 重试同一轮复用同一会话（缓存友好）', () => {
    const a = resolveTarget(sig({ sourceType: 'review_request', taskId: 'tsk_5', round: 3 }));
    const b = resolveTarget(sig({ sourceType: 'review_request', taskId: 'tsk_5', round: 3, ts: TS + 99_999 }));
    expect(a!.sessionId).toBe('review_agt_test_tsk_5_r3');
    expect(b!.sessionId).toBe(a!.sessionId);
  });

  it('review_request 缺 round 时省略轮次后缀（不编造轮次）', () => {
    const t = resolveTarget(sig({ sourceType: 'review_request', taskId: 'tsk_5' }));
    expect(t!.sessionId).toBe('review_agt_test_tsk_5');
  });

  it('mention 带 taskId → 落在该任务的评论会话（不是 sys_ 占位）', () => {
    const t = resolveTarget(sig({ sourceType: 'mention', taskId: 'tsk_7' }));
    expect(t!.kind).toBe('task_comment');
    expect(t!.sessionId).toBe(`comment_tsk_7_${TS}`);
    expect(t!.entityId).toBe('task:tsk_7');
  });

  it('requirement_update 带 requirementId → 需求会话', () => {
    const t = resolveTarget(sig({
      sourceType: 'requirement_update',
      intent: 'action_required',
      requirementId: 'req_1',
    }));
    expect(t!.kind).toBe('requirement');
    expect(t!.sessionId).toBe(`requirement_req_1_${TS}`);
    expect(t!.entityId).toBe('req:req_1');
  });

  it('requirement_update 信息性（非 action_required）仍给会话身份 —— 是否开回合由调用方按 intent 判', () => {
    // 「去向」与「要不要耗 LLM」是两件事，不能挤进同一个 null。
    const t = resolveTarget(sig({
      sourceType: 'requirement_update',
      intent: 'deliver',
      requirementId: 'req_2',
    }));
    expect(t).not.toBeNull();
    expect(t!.sessionId).toBe(`requirement_req_2_${TS}`);
  });

  it('requirement_comment → 需求评论会话', () => {
    const t = resolveTarget(sig({ sourceType: 'requirement_comment', requirementId: 'req_3' }));
    expect(t!.sessionId).toBe(`comment_req_3_${TS}`);
  });

  it('workflow_update 带事件名 → workflow 会话', () => {
    const t = resolveTarget(sig({
      sourceType: 'workflow_update',
      intent: 'action_required',
      workflowEvent: 'completed',
    }));
    expect(t!.kind).toBe('workflow');
    expect(t!.sessionId).toBe(`workflow_completed_${TS}`);
  });
});

describe('resolveTarget — a2a：会话身份按「对话」而不是「消息」绑定', () => {
  it('回复原会话优先于一切（in-session 委托继续在原线程）', () => {
    const t = resolveTarget(sig({
      sourceType: 'a2a_message',
      conversationId: 'conv_1',
      a2aOriginSessionId: 'sess_delegator',
      channelSessionId: 'cs_channel',
    }));
    expect(t!.sessionId).toBe('sess_delegator');
  });

  it('无原会话时用频道会话（同一任务经 DM 与群聊到达不分裂）', () => {
    const t = resolveTarget(sig({
      sourceType: 'a2a_message',
      conversationId: 'conv_1',
      channelSessionId: 'cs_channel',
    }));
    expect(t!.sessionId).toBe('cs_channel');
  });

  it('有对话身份 → 按对话 id 派生（多轮协作不失忆）', () => {
    const t = resolveTarget(sig({ sourceType: 'a2a_message', conversationId: 'conv_1' }));
    expect(t!.sessionId).toBe('a2a_agt_test_conv_1');
    expect(t!.entityId).toBe('a2a:conv_1');
  });

  it('随时间戳变化的 a2a 会话 id 是「同一对话不同会话」的历史病灶 —— 有对话身份时禁止再出现', () => {
    const a = resolveTarget(sig({ sourceType: 'a2a_message', conversationId: 'conv_1' }));
    const b = resolveTarget(sig({ sourceType: 'a2a_message', conversationId: 'conv_1', ts: TS + 5_000 }));
    expect(a!.sessionId).toBe(b!.sessionId);
  });
});

describe('resolveTarget — 无归属的信号：必须返回 null（交给 Loop）', () => {
  const unrouted: Array<[string, Partial<SignalTargetInput>]> = [
    ['mention 不带 taskId', { sourceType: 'mention' }],
    ['task_comment 不带 taskId', { sourceType: 'task_comment' }],
    ['task_status_update 不带 taskId', { sourceType: 'task_status_update', intent: 'trigger_execution' }],
    ['review_request 不带 taskId', { sourceType: 'review_request' }],
    ['requirement_update 不带 requirementId', { sourceType: 'requirement_update', intent: 'action_required' }],
    ['requirement_comment 不带 requirementId', { sourceType: 'requirement_comment' }],
    ['workflow_update 不带事件名', { sourceType: 'workflow_update', intent: 'action_required' }],
    ['a2a 无对话身份也无原会话也无频道', { sourceType: 'a2a_message' }],
    ['heartbeat 是物理巡逻', { sourceType: 'heartbeat' }],
  ];

  for (const [name, over] of unrouted) {
    it(name + ' → null', () => {
      expect(resolveTarget(sig(over))).toBeNull();
    });
  }
});

describe('resolveTarget — 平台内部信号：有会话但不绑定实体', () => {
  for (const t of ['system_event', 'daily_report', 'memory_consolidation'] as const) {
    it(`${t} → sys 会话（平台内部回合，不绑定实体）`, () => {
      const target = resolveTarget(sig({ sourceType: t }));
      expect(target).not.toBeNull();
      expect(target!.kind).toBe('system');
      expect(target!.sessionId).toBe(`sys_${AGENT}_${TS}`);
    });
  }
});

describe('loop session — 无主信号的唯一落点（M2/M3）', () => {
  it('loopSessionId 是每个 agent 一条、且与时间无关', () => {
    expect(loopSessionId('agt_x')).toBe(`${LOOP_SESSION_PREFIX}agt_x`);
    expect(loopSessionId('agt_x')).toBe(loopSessionId('agt_x'));
  });

  it('isLoopSession 只认前缀，不认 substring', () => {
    expect(isLoopSession(loopSessionId('agt_x'))).toBe(true);
    expect(isLoopSession('sys_agt_x_1700000000000')).toBe(false);
    expect(isLoopSession('comment_tsk_1_1700000000000')).toBe(false);
    expect(isLoopSession(undefined)).toBe(false);
  });

  it('无主信号在 resolveTarget 处全部返回 null —— 它们的落点是 loop，而不是各自新开一条', () => {
    // 这组 null 就是「Loop 要处理的东西」的完整定义；新增无主分支必须同时改这里。
    const unowned: Array<Partial<SignalTargetInput>> = [
      { sourceType: 'mention' },
      { sourceType: 'task_comment' },
      { sourceType: 'review_request' },
      { sourceType: 'requirement_update', intent: 'action_required' },
      { sourceType: 'requirement_comment' },
      { sourceType: 'workflow_update', intent: 'action_required' },
      { sourceType: 'a2a_message' },
      { sourceType: 'heartbeat' },
    ];
    for (const over of unowned) {
      expect(resolveTarget(sig(over)), `${over.sourceType} 应为无主`).toBeNull();
    }
  });

  it('有主信号绝不落 loop —— 否则真实实体工作会被拖进决策会话', () => {
    const owned: Array<Partial<SignalTargetInput>> = [
      { sourceType: 'task_comment', taskId: 'tsk_1' },
      { sourceType: 'review_request', taskId: 'tsk_1', round: 1 },
      { sourceType: 'requirement_comment', requirementId: 'req_1' },
      { sourceType: 'a2a_message', conversationId: 'conv_1' },
      { sourceType: 'human_chat' },
      { sourceType: 'system_event' },
    ];
    for (const over of owned) {
      const t = resolveTarget(sig(over));
      expect(t, `${over.sourceType} 应有主`).not.toBeNull();
      expect(isLoopSession(t!.sessionId), `${over.sourceType} 不应落 loop`).toBe(false);
    }
  });
});

describe('resolveTarget — 纯函数纪律', () => {
  it('同一输入调用两次 → 字节完全一致（可缓存的前提）', () => {
    const input = sig({ sourceType: 'task_comment', taskId: 'tsk_1' });
    expect(resolveTarget(input)).toEqual(resolveTarget(input));
  });

  it('不读挂钟：时间只来自入参，改 ts 只影响含 ts 的 id', () => {
    const base = sig({ sourceType: 'task_comment', taskId: 'tsk_1' });
    const later = { ...base, ts: base.ts + 60_000 };
    expect(resolveTarget(base)!.sessionId).toBe(`comment_tsk_1_${base.ts}`);
    expect(resolveTarget(later)!.sessionId).toBe(`comment_tsk_1_${later.ts}`);
  });

  it('不改写入参（无副作用）', () => {
    const input = sig({ sourceType: 'review_request', taskId: 'tsk_1', round: 1 });
    const snapshot = JSON.stringify(input);
    resolveTarget(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
