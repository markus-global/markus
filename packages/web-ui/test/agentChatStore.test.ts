/**
 * agentChatStore 单测 —— 验证 ChatPanel 按 agent 隔离主会话状态的容器语义：
 * 1. 不同 agent 状态互不污染（并行流式输出的隔离保证）。
 * 2. updateField 函数式更新正确、返回完整状态。
 * 3. getOrCreate / has / set / delete 基础行为。
 */
import { describe, it, expect } from 'vitest';
import { createAgentChatStore, type AgentChatStore } from '../src/hooks/agentChatStore.ts';

interface FakeBuffer {
  messages: string[];
  sessionId: string | null;
  sending: boolean;
}

const blank = (): FakeBuffer => ({ messages: [], sessionId: null, sending: false });

describe('createAgentChatStore', () => {
  it('isolation: 更新 agent A 不污染 agent B', () => {
    const store = createAgentChatStore<FakeBuffer>(blank);
    store.getOrCreate('agentA');
    store.getOrCreate('agentB');

    // agentA 追加一条消息并标记流式进行中
    store.updateField('agentA', 'messages', prev => [...prev, 'hello']);
    store.updateField('agentA', 'sending', true);

    // agentB 不受影响
    expect(store.get('agentB')).toEqual({ messages: [], sessionId: null, sending: false });
    // agentA 已更新
    expect(store.get('agentA')?.messages).toEqual(['hello']);
    expect(store.get('agentA')?.sending).toBe(true);
  });

  it('两个 agent 可各自并行持有独立会话与流状态', () => {
    const store = createAgentChatStore<FakeBuffer>(blank);
    store.updateField('agentA', 'sessionId', 'sess_a');
    store.updateField('agentB', 'sessionId', 'sess_b');
    store.updateField('agentA', 'sending', true); // A 仍在流式输出
    store.updateField('agentB', 'messages', prev => [...prev, 'B partial']);

    expect(store.get('agentA')?.sessionId).toBe('sess_a');
    expect(store.get('agentA')?.sending).toBe(true);
    expect(store.get('agentB')?.sessionId).toBe('sess_b');
    expect(store.get('agentB')?.messages).toEqual(['B partial']);
  });

  it('updateField 支持函数式更新并返回变更后的完整状态', () => {
    const store = createAgentChatStore<FakeBuffer>(blank);
    const next = store.updateField('agentA', 'sessionId', 'sess');
    expect(next).toEqual({ messages: [], sessionId: 'sess', sending: false });
    // 函数式
    const next2 = store.updateField('agentA', 'messages', prev => [...prev, 'a']);
    expect(next2.messages).toEqual(['a']);
  });

  it('has / get 对未初始化的 agent 返回正确', () => {
    const store = createAgentChatStore<FakeBuffer>(blank);
    expect(store.has('nope')).toBe(false);
    expect(store.get('nope')).toBeUndefined();
  });

  it('getOrCreate 幂等：重复调用返回同一状态，不覆盖已有数据', () => {
    const store = createAgentChatStore<FakeBuffer>(blank);
    store.updateField('agentA', 'messages', prev => [...prev, 'keep']);
    const again = store.getOrCreate('agentA');
    expect(again.messages).toEqual(['keep']);
  });

  it('set / delete 行为', () => {
    const store = createAgentChatStore<FakeBuffer>(blank);
    store.set('agentA', { messages: ['x'], sessionId: 's', sending: false });
    expect(store.get('agentA')?.messages).toEqual(['x']);
    expect(store.delete('agentA')).toBe(true);
    expect(store.delete('agentA')).toBe(false);
    expect(store.has('agentA')).toBe(false);
  });
});
