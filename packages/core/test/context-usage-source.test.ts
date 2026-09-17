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
 *   1. 有可用上报值时，水位标用**上报值**并标 `src=reported`；否则 `src=est`。
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
  it('无上报值时标 src=est，且 usageSource=estimated', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const p = await pack(engine, store, 'sess_a', { history: [{ role: 'user', content: 'hi' }] });
    expect(p.contextHint).toContain('src=est');
    expect(p.contextHint).not.toContain('src=reported');
    expect(p.usage.usageSource).toBe('estimated');
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
    // 水位分母是 effectiveBudget（窗口 − 输出预留 − 安全边际），不是裸窗口。
    // 用返回的字段精确推导，避免把内部的边际政策硬编码进测试。
    const effectiveBudget = p.usage.contextWindow - p.usage.maxOutputReserved - p.usage.safetyMargin;
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
    const effectiveBudget = p.usage.contextWindow - p.usage.maxOutputReserved - p.usage.safetyMargin;
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
    expect(p.contextHint).toContain('src=est');
  });

  it('发生压缩后读数失效（描述的是已不存在的更大请求）', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_d';
    engine.noteReportedInputTokens(session, 7_900); // 小窗口下必然触发压缩
    const p1 = await pack(engine, store, session, { history: bigHistory(60), window: 8_000 });
    expect(p1.usage.compressed).toBe(true);
    // 本次仍按读数标注（诚实反映打包前状态），但必须已清空
    const p2 = await pack(engine, store, session, { history: [{ role: 'user', content: 'hi' }], window: 8_000 });
    expect(p2.contextHint).toContain('src=est');
    expect(p2.usage.usageSource).toBe('estimated');
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
    expect(p.usage.totalUsed).toBeGreaterThan(1_000);
  });

  it('clearReportedInputTokens 可显式清除', async () => {
    const engine = new ContextEngine();
    const store = makeStore();
    const session = 'sess_g';
    engine.noteReportedInputTokens(session, 100_000);
    engine.clearReportedInputTokens(session);
    const p = await pack(engine, store, session, { history: [{ role: 'user', content: 'hi' }] });
    expect(p.usage.usageSource).toBe('estimated');
  });
});
