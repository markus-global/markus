import { describe, it, expect } from 'vitest';
import { shouldContinueToolLoop, turnContinuationKind } from '../src/agent.js';
import { mapUpstreamFinishReason, createSSEAccumulator } from '../src/llm/provider-helpers.js';

/**
 * P2 回归：finish-reason 诚实化（问题 A 的直接机制）。
 *
 * 现象（老板 2026-10-06）：大模型接口不稳定导致流式输出中断，这次回复就结束了，
 * 用户看到半截状态，需手动继续/重试。
 *
 * 根因：全链路 `FINISH_REASON_MAP[...] ?? 'end_turn'`（provider-helpers /
 * anthropic / google / ollama / openai-codex），且 `createSSEAccumulator` 默认
 * `finishReason: 'end_turn'`——一个「没有任何 finish_reason 就断掉」的流被**静默
 * 当成模型说完了**。系统再也分不清「模型真的说完了」与「流断了」。
 *
 * 修复不变量：
 *  - 未知 / 缺失 finish_reason ⇒ `incomplete`（**绝不**谎报 `end_turn`）；
 *  - `incomplete` 不是 turn 终点 ⇒ 工具循环继续（同一会话续跑，有界）。
 */
describe('finish-reason 诚实化（P2）', () => {
  it('未知/缺失 finish_reason → incomplete（绝不谎报 end_turn）', () => {
    expect(mapUpstreamFinishReason('stop')).toBe('end_turn');
    expect(mapUpstreamFinishReason('tool_calls')).toBe('tool_use');
    expect(mapUpstreamFinishReason('length')).toBe('max_tokens');
    expect(mapUpstreamFinishReason(undefined)).toBe('incomplete');
    expect(mapUpstreamFinishReason(null)).toBe('incomplete');
    expect(mapUpstreamFinishReason('')).toBe('incomplete');
    expect(mapUpstreamFinishReason('some_brand_new_reason')).toBe('incomplete');
  });

  it('SSE accumulator：无 finish_reason 结束 → incomplete（断流不当正常结束）', () => {
    const acc = createSSEAccumulator();
    acc.feed({ choices: [{ delta: { content: '半截回复' } }] });
    expect(acc.state.content).toBe('半截回复');
    expect(acc.state.finishReason).toBe('incomplete');

    // 有真实 finish_reason 时照常映射
    const acc2 = createSSEAccumulator();
    acc2.feed({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] });
    expect(acc2.state.finishReason).toBe('end_turn');
  });

  it('incomplete ⇒ 工具循环必须继续（不能当 turn 结束）', () => {
    expect(turnContinuationKind({ finishReason: 'incomplete' })).toBe('text');
    expect(shouldContinueToolLoop({ finishReason: 'incomplete' })).toBe(true);
  });

  it('end_turn / endTurnRequested 仍是终点（不回归）', () => {
    expect(turnContinuationKind({ finishReason: 'end_turn' })).toBe('done');
    expect(shouldContinueToolLoop({ finishReason: 'end_turn' })).toBe(false);
    expect(shouldContinueToolLoop({ finishReason: 'incomplete' }, { endTurnRequested: true })).toBe(false);
  });

  it('tool_use / max_tokens 语义不变', () => {
    expect(turnContinuationKind({ finishReason: 'tool_use', toolCalls: [{}] })).toBe('tools');
    expect(turnContinuationKind({ finishReason: 'max_tokens' })).toBe('text');
  });

  it('取消/用户停止是终态：incomplete 也必须 done（不许取消后继续跑）', () => {
    // 被取消的流没有真实 finish_reason ⇒ 会判为 incomplete；若不拦截，取消后
    // 会继续花一次 LLM 往返（并发取消隔离用例卡死的真实根因）。
    expect(turnContinuationKind({ finishReason: 'incomplete' }, { cancelled: true })).toBe('done');
    expect(shouldContinueToolLoop({ finishReason: 'incomplete' }, { cancelled: true })).toBe(false);
    // 取消优先于「继续」；未取消时 incomplete 照旧继续。
    expect(turnContinuationKind({ finishReason: 'incomplete' }, { cancelled: false })).toBe('text');
  });
});
