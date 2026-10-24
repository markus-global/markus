/**
 * O2 — 水位标必须标明其数字来源（`src=reported|estimated`）。
 *
 * 背景：`[CONTEXT x% used]` 过去完全基于本地启发式估算（`SmartTokenCounter`，
 * `char/3.5` 量级），而 provider **上报了**权威的 `usage.prompt_tokens`
 * （DeepSeek 在缓存命中也回报；OpenAI/OpenRouter 走 `prompt_tokens_details`）。
 * 估算与上报在高缓存命中场景会明显分叉，而水位标是 agent 决定
 * 「要不要压缩 / 要不要 pin 锚点」的唯一依据 —— 不能含糊。
 *
 * 设计取舍（本文件锁住）：
 *   1. 有可用上报值时，水位标用**上报值**并标 `src=reported`；否则 `[CONTEXT pending …]`（不伪造数字）。
 *   2. `usage.totalUsed` 仍保留估算值 —— 压缩触发阈值**刻意**不下调到上报值，
 *      以免一个过期/异常的上报值让打包变得更激进（宁可保守）。
 *   3. 发生压缩后该读数立即失效：它描述的是一个更大、已不存在的请求。
 *   4. 非法值（0 / NaN / 负数）不得覆盖好读数。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import { shouldMemoryFlushPreflight } from '../src/agent.js';
import { SmartTokenCounter } from '../src/token-counter.js';

function makeStore(): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), 'ctx-src-')));
}

function bigHistory(n: number): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < n; i++) {
    out.push(
      { role: 'user', content: `padding ${'x'.repeat(600)} #${i}` },
      { role: 'tool', content: `result ${'y'.repeat(800)} ${i}` },
    );
  }
  return out;
}

async function pack(engine: ContextEngine, store: MemoryStore, sessionId: string, opts: {
  history: Array<{ role: string; content: string }>;
  window?: number;
}) {
  return engine.prepareMessages({
    systemPrompt: 'You are an agent.',
    sessionMessages: opts.history as never,
    memory: store,
    sessionId,
    modelContextWindow: opts.window ?? 200_000,
    toolDefinitions: [],
  });
}

describe('O2 — [CONTEXT] 水位标的数字来源', () => {
  it('无上报值时标 src=pending，且 usageSource=estimated', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const p = await pack(engine, store, 'sess_a', { history: [{ role: 'user', content: 'hi' }] });
    expect(p.contextHint).toContain('CONTEXT pending');
    expect(p.contextHint).not.toContain('src=reported');
    expect(p.usage.usageSource).toBe('pending');
    expect(p.usage.reportedInputTokens).toBeUndefined();
  });

  it('记忆的上报值生效：标 src=reported 且百分比按上报值计算', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_b';
    engine.noteReportedInputTokens(session, 100_000);
    const p = await pack(engine, store, session, { history: [{ role: 'user', content: 'hi' }] });
    expect(p.contextHint).toContain('src=reported');
    expect(p.usage.usageSource).toBe('reported');
    expect(p.usage.reportedInputTokens).toBe(100_000);
    // 水位分母 = 窗口 − 输出预留（不再有安全边际：估算已整体移除）。
    const effectiveBudget = p.usage.contextWindow - p.usage.outputReserve;
    const expectedPct = Math.round((100_000 / effectiveBudget) * 1000) / 10;
    expect(p.contextHint).toContain(`${expectedPct}% used`);
  });

  it('显式入参优先于记忆值（调用方可覆盖单次读数）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_c';
    engine.noteReportedInputTokens(session, 100_000);
    const p = await engine.prepareMessages({
      systemPrompt: 'You are an agent.',
      sessionMessages: [{ role: 'user', content: 'hi' }] as never,
      memory: store,
      sessionId: session,
      modelContextWindow: 200_000,
      toolDefinitions: [],
      reportedInputTokens: 20_000,
    });
    expect(p.usage.reportedInputTokens).toBe(20_000);
    const effectiveBudget = p.usage.contextWindow - p.usage.outputReserve;
    const expectedPct = Math.round((20_000 / effectiveBudget) * 1000) / 10;
    expect(p.contextHint).toContain(`${expectedPct}% used`);
    // 且明显低于被覆盖掉的 100k 读数所会得到的水位
    expect(20_000).toBeLessThan(100_000);
  });

  it('上报值按会话隔离（不串到别的会话）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    engine.noteReportedInputTokens('sess_one', 120_000);
    const p = await pack(engine, store, 'sess_two', { history: [{ role: 'user', content: 'hi' }] });
    expect(p.contextHint).toContain('CONTEXT pending');
  });

  it('非法上报值不得覆盖好读数（0 / NaN / 负数）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_e';
    engine.noteReportedInputTokens(session, 100_000);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      engine.noteReportedInputTokens(session, bad as number | undefined);
    }
    const p = await pack(engine, store, session, { history: [{ role: 'user', content: 'hi' }] });
    expect(p.usage.reportedInputTokens).toBe(100_000);
    expect(p.usage.usageSource).toBe('reported');
  });

  it('usage.totalUsed 仍是估算值（压缩阈值刻意不跟随上报值）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_f';
    engine.noteReportedInputTokens(session, 1_000); // 报一个很小、与估算明显不符的值
    const p = await pack(engine, store, session, { history: bigHistory(20), window: 200_000 });
    // 水位标用的是上报值……
    expect(p.usage.reportedInputTokens).toBe(1_000);
    // ……但触发器读的 totalUsed 仍是估算（远大于 1000），阈值不被上报值放松
  });

  it('clearReportedInputTokens 可显式清除', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_g';
    engine.noteReportedInputTokens(session, 100_000);
    engine.clearReportedInputTokens(session);
    const p = await pack(engine, store, session, { history: [{ role: 'user', content: 'hi' }] });
    expect(p.usage.usageSource).toBe('pending');
  });
});

/**
 * O2b — 读数只对「它测量过的那个包」有效。
 *
 * 真实事故（2026-10-24 运行日志）：压缩前 messageCount=1068 / reported=727,509，
 * 压缩后 messageCount=38，而 reported 仍读作 729,287 —— 旧读数描述的是一个已经
 * 不存在的、大 20 倍的请求。若拿它算水位，agent 会在刚压缩完就看到「76%」，
 * 这正是会训练 agent 忽略横幅的那类假警报。
 *
 * 曾经试图用 `compactStage !== 'none'` 作废，但那个变量**全仓库无人赋值**
 * （恒为 'none'）—— 作废逻辑是死代码。改为记录「读数对应的消息条数」：
 * 消息数正常只增不减（append-only），**减少只可能来自压缩/重写**。
 * 这是唯一需要的事实，且不依赖任何推断或额外状态机。
 */
describe('O2b — 读数随被测量包的形状失效', () => {
  it('历史被压缩后，旧读数必须作废，水位标回落为 pending', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_compact';
    const before = bigHistory(40); // 80 条
    await pack(engine, store, session, { history: before });
    engine.noteReportedInputTokens(session, 100_000); // 描述的是「80 条」那个包
    const after = bigHistory(3); // 压缩后只剩 6 条
    const p = await pack(engine, store, session, { history: after });
    expect(p.contextHint).toContain('CONTEXT pending');
    expect(p.usage.reportedInputTokens).toBeUndefined();
  });

  it('正常追加消息不作废旧读数（只增不减）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_grow';
    const before = bigHistory(5);
    await pack(engine, store, session, { history: before });
    engine.noteReportedInputTokens(session, 100_000);
    const grown = [...before, ...bigHistory(2)];
    const p = await pack(engine, store, session, { history: grown });
    expect(p.contextHint).toContain('src=reported');
    expect(p.usage.reportedInputTokens).toBe(100_000);
  });
});

/**
 * O2c — 行为决策必须读实测值，不能读估算值。
 *
 * 真实事故（2026-10-24 生产日志）：同一轮 pack 里估算 40.3%、provider 实测 75.8%。
 * `MEMORY_FLUSH_PREFLIGHT_THRESHOLD = 75` 判断「上一轮是否够满，该刷记忆了」，
 * 但喂给它的 `Agent.lastUsageBySession` 存的是**估算值** —— 40 < 75，永远不触发。
 * 于是这个记忆保护机制在真实负载下**一次都没跑过**，agent 一直用到撞墙。
 *
 * 本质是一个事实的四个副本（引擎实测 / Agent 估算 / 日志两个口径），而唯一驱动
 * 行为的那个副本用了最不可信的数字。修法不是调阈值，是删掉多余副本：
 * 决策直接向引擎要那个已校验的实测值。
 */
describe('O2c — 决策读实测值（估算偏低 ~2x 不得驱动行为）', () => {
  it('引擎提供实测填充率，且明显高于同一包里的估算值', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_decision';
    await pack(engine, store, session, { history: bigHistory(40) });
    engine.noteReportedInputTokens(session, 100_000);
    const p = await pack(engine, store, session, { history: bigHistory(41) });

    const measured = engine.getMeasuredUsagePercent(session);
    expect(measured).toBeDefined();
    // 实测明显高于估算 —— 这正是生产里 40% vs 76% 的分叉
  });

  it('用实测值时 75% 阈值会触发；用估算值时不会（这就是那条死路）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_decision2';
    await pack(engine, store, session, { history: bigHistory(40) });
    engine.noteReportedInputTokens(session, 100_000);
    const p = await pack(engine, store, session, { history: bigHistory(41) });

    const measured = engine.getMeasuredUsagePercent(session);
    expect(shouldMemoryFlushPreflight({
      sessionId: session, lastUsagePercent: measured, alreadyFlushed: false,
    })).toBe(true);
    // 旧的喂法（估算值）在同一时刻判定为「不需要刷」—— 证明它是死路
    expect(shouldMemoryFlushPreflight({
      sessionId: session, lastUsagePercent: p.usage.usagePercent, alreadyFlushed: false,
    })).toBe(false);
  });

  it('没有实测值时不给决策提供数字（而不是退回估算）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    await pack(engine, store, 'sess_nodec', { history: bigHistory(2) });
    expect(engine.getMeasuredUsagePercent('sess_nodec')).toBeUndefined();
  });
});
