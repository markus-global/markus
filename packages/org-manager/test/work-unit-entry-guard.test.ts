/**
 * C7-B 结构性守卫：**每一个聊天派发点都必须带上本轮 WU 身份**。
 *
 * 为什么需要这条测试（不是洁癖）：
 * 2026-11-14 一天之内，同一个事实（"这一轮有 WU 身份"）在三轮修复里被漏了三次 ——
 * 先漏 `start.ts` 之外的桌面启动路径，再漏 `openChatTurnWorkUnit` 的时序（入队后回填），
 * 最后漏掉 Web UI 团队聊天真正走的 `POST /agents/:id/message`（`/api/message` 改了，
 * 它没改）。每一次都是"改了一个入口，漏了另一个入口"，而线上表现完全一样：
 * `work_units` 不写、日志也不报错。
 *
 * 判据：**派发点数量是可能增长的，所以断言必须遍历派发点，而不是逐条写死**。
 * 这里用源码结构断言（与 C3 的 transition-bypass 守卫同口径）：每个
 * `agent.sendMessage(`（带 senderInfo 的真实聊天回合）与 `new SSEHandler(` 之后
 * 必须出现 `workUnitRef`。新增入口若忘了带身份，这条测试立刻红。
 *
 * 为什么不写成行为测试：这些是"每个调用点都得传一个参数"的存在性约束，
 * 行为测试只能覆盖它驱动的那些路径 —— 而漏掉的恰恰是新路径。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/api-server.ts', import.meta.url), 'utf8');
const WINDOW = 2600;

function windowsAfter(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const m of SRC.matchAll(pattern)) {
    const i = m.index ?? 0;
    out.push(SRC.slice(i, i + WINDOW));
  }
  return out;
}

describe('C7-B：聊天派发点必须携带本轮 WorkUnit 身份', () => {
  it('每个 new SSEHandler( 之后都必须传 workUnitRef', () => {
    const sites = windowsAfter(/new SSEHandler\(/g);
    expect(sites.length).toBeGreaterThan(0);
    const missing = sites.filter(w => !w.includes('workUnitRef'));
    expect(missing).toHaveLength(0);
  });

  it('每个真实聊天回合的 agent.sendMessage( 之后都必须传 workUnitRef', () => {
    // 只认"真实聊天回合"：内部提示注入（heartbeat / dream）不传 senderInfo，
    // 它们不是用户回合，也不该有 WU 身份。
    const sites = windowsAfter(/agent\.sendMessage\(/g).filter(w => w.includes('senderInfo'));
    expect(sites.length).toBeGreaterThan(0);
    const missing = sites.filter(w => !w.includes('workUnitRef'));
    expect(missing).toHaveLength(0);
  });

  it('SSEHandler 必须把 workUnitRef 透传给 sendMessageStream', () => {
    const sse = readFileSync(new URL('../src/sse-handler.ts', import.meta.url), 'utf8');
    const call = sse.slice(sse.indexOf('agent.sendMessageStream('));
    expect(call).toContain('workUnitRef');
  });
});
