/**
 * worklog-entity —— 概览工作记录实体解析唯一写者的行为测试。
 *
 * 回归根因（2026-11-23）：飞书人类消息 work_unit_ref = `external:feishu:<messageId>`
 * （按消息的幂等键），旧解析器只反解 ref 形状 → 解不出会话 → null → 前端「历史记录」。
 * 修复：结构身份都没命中时，读入口**声明**的会话键（payload.extra.channelKey /
 * sessionHint）。本测试逐条钉死归属判据，并证伪「靠 sourceType/ref 蒙」的弱实现。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createWorklogEntityResolver,
  declaredConversationKey,
  imConversationLabel,
  type WorklogEntityDeps,
} from '../src/worklog-entity.js';

const FEISHU_KEY = 'im:bi_feishu_b12eeaf0db46:dm:oc_634b67fac6ec1b7aa5a0253f1c6245f1';

function makeDeps(overrides: Partial<WorklogEntityDeps> = {}): WorklogEntityDeps {
  return {
    agentId: 'agt_cto',
    taskTitle: vi.fn((id: string) => `任务-${id}`),
    requirementTitle: vi.fn((id: string) => `需求-${id}`),
    chatSessionTitle: vi.fn((id: string) => `会话-${id}`),
    ...overrides,
  };
}

/** 一条飞书入站人类消息（真实形状：external ref + extra.channelKey）。 */
function feishuItem(messageId: string, extra: Record<string, unknown> = { channelKey: FEISHU_KEY }) {
  return {
    sourceType: 'human_chat',
    workUnitRef: `external:feishu:${messageId}`,
    payload: { summary: 'hi', content: 'hi', extra: { scenario: 'chat', ...extra } },
    metadata: { senderId: 'ou_x' },
  };
}

describe('IM 人类会话 → channel 实体（核心修复）', () => {
  it('external ref + 声明的 channelKey → channel，id 是完整 channelKey，名字可读', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve(feishuItem('om_1'));
    expect(ent).not.toBeNull();
    expect(ent!.kind).toBe('channel');
    expect(ent!.id).toBe(FEISHU_KEY);
    expect(ent!.name).toBe('飞书私聊 · oc_634b67f…');
  });

  it('同一段对话的两条消息（不同 messageId）聚成同一个实体键 —— 不是每条一桶', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const a = resolve(feishuItem('om_1'));
    const b = resolve(feishuItem('om_2'));
    expect(`${a!.kind}:${a!.id}`).toBe(`${b!.kind}:${b!.id}`);
  });

  it('旧数据兼容：workUnitRef 为 NULL 但有 channelKey → 仍归 channel', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const item = feishuItem('om_1');
    delete (item as Record<string, unknown>).workUnitRef;
    const ent = resolve(item);
    expect(ent!.kind).toBe('channel');
    expect(ent!.id).toBe(FEISHU_KEY);
  });

  it('没有 channelKey 时退回 sessionHint（role=channel）', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve(feishuItem('om_1', { sessionHint: { kind: 'system', role: 'channel', key: FEISHU_KEY } }));
    expect(ent!.kind).toBe('channel');
    expect(ent!.id).toBe(FEISHU_KEY);
  });

  it('【证伪】只有 external ref + human_chat、没有任何会话声明 → 仍归 null（证明靠声明而非 sourceType/ref）', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve(feishuItem('om_1', {}));
    expect(ent).toBeNull();
  });

  it('【证伪】sessionHint 是 memory 型（非 channel）→ 不当会话键', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve(feishuItem('om_1', { sessionHint: { kind: 'memory', memorySessionId: 'sess_x' } }));
    expect(ent).toBeNull();
  });
});

describe('结构身份优先 —— IM 分支不得劫持', () => {
  it('载荷带 taskId（即使也有 channelKey）→ task', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const item = feishuItem('om_1');
    (item.payload as Record<string, unknown>).taskId = 'tsk_abc';
    const ent = resolve(item);
    expect(ent!.kind).toBe('task');
    expect(ent!.id).toBe('tsk_abc');
  });

  it('web 聊天 session ref → channel sid（原行为不变），名字取自实体表', () => {
    const deps = makeDeps();
    const resolve = createWorklogEntityResolver(deps);
    const ent = resolve({ sourceType: 'human_chat', workUnitRef: 'session:cs_xyz:r7', payload: {} });
    expect(ent!.kind).toBe('channel');
    expect(ent!.id).toBe('cs_xyz');
    expect(ent!.name).toBe('会话-cs_xyz');
    expect(deps.chatSessionTitle).toHaveBeenCalledWith('cs_xyz');
  });

  it('a2a DM ref → channel（原行为不变）', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve({ sourceType: 'a2a_message', workUnitRef: 'a2a:dm:a2a:agt_x:agt_y', payload: {} });
    expect(ent!.kind).toBe('channel');
    expect(ent!.id).toBe('dm:a2a:agt_x:agt_y');
  });

  it('loopWake → 决策循环（原行为不变）', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve({ sourceType: 'system_event', workUnitRef: null, payload: { extra: { loopWake: true } } });
    expect(ent!.kind).toBe('channel');
    expect(ent!.id).toBe('loop_agt_cto');
  });

  it('requirement 载荷 → requirement', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve({ sourceType: 'requirement_comment', payload: { requirementId: 'req_1' } });
    expect(ent!.kind).toBe('requirement');
    expect(ent!.id).toBe('req_1');
  });

  it('delegation ref → 递归到父任务实体', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    const ent = resolve({ sourceType: 'delegation', workUnitRef: 'delegation:task_tsk_parent_r1#hash', payload: {} });
    expect(ent!.kind).toBe('task');
    expect(ent!.id).toBe('tsk_parent');
  });

  it('无结构、无声明 → null（不猜）', () => {
    const resolve = createWorklogEntityResolver(makeDeps());
    expect(resolve({ sourceType: 'callback_result', payload: {} })).toBeNull();
  });
});

describe('declaredConversationKey —— 读声明的取舍', () => {
  it('channelKey 优先于 sessionHint', () => {
    expect(declaredConversationKey({ channelKey: 'im:a:dm:c', sessionHint: { role: 'channel', key: 'im:other' } }))
      .toBe('im:a:dm:c');
  });
  it('空 channelKey 退回 sessionHint', () => {
    expect(declaredConversationKey({ channelKey: '  ', sessionHint: { role: 'channel', key: 'im:a:dm:c' } }))
      .toBe('im:a:dm:c');
  });
  it('非 channel 的 sessionHint 不算', () => {
    expect(declaredConversationKey({ sessionHint: { role: 'memory', key: 'x' } })).toBe('');
  });
  it('什么都没有 → 空串', () => {
    expect(declaredConversationKey({})).toBe('');
  });
});

describe('imConversationLabel —— 仅显示美化，不动身份', () => {
  it('飞书 DM → 飞书私聊 · 短 chatId', () => {
    expect(imConversationLabel(FEISHU_KEY)).toBe('飞书私聊 · oc_634b67f…');
  });
  it('飞书群聊 → 飞书群聊', () => {
    expect(imConversationLabel('im:bi_feishu_b1:group:oc_group123456789')).toBe('飞书群聊 · oc_group12…');
  });
  it('未知平台 → IM 前缀（不猜平台名）', () => {
    expect(imConversationLabel('im:bi_mystery_b1:dm:chat1')).toBe('IM私聊 · chat1');
  });
  it('非 im 形状 / 段数不足 → undefined（退回短 id 标签）', () => {
    expect(imConversationLabel('cs_xyz')).toBeUndefined();
    expect(imConversationLabel('im:bot:dm')).toBeUndefined();
  });
});
