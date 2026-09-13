/**
 * 接线契约测试（wiring contracts）—— 审计 P1-9 / P1-10 / P0-1 的**接线**层守卫。
 * ---------------------------------------------------------------------------
 * 为什么需要它：P1-9/P1-10 的上一版修复只测了「新 API 自身行为」
 * （例如 `createTokenCounter()` 返回独立实例），但**接线**（agent/agent-manager
 * 是否真的调用它）没有任何断言 → 把 `agent.ts` / `agent-manager.ts` 里的接线调用
 * 删掉，测试依然全绿。这正是 QA round 3 的退回项 M3。
 *
 * 本文件对「接线调用点」做源码级断言 + 行为级断言双保险：
 *   A. 行为级：`wireAgentEventForwarding`（agent-manager.ts 真实调用的同一函数）
 *      跨 bus 可达 —— 已有 `agent-event-forwarding.test.ts` 覆盖，这里补「接线函数
 *      确实被 forwardAgentEvents 调用」。
 *   B. 源码级：直接断言接线调用出现在正确的方法体内。校验方式用「方法切片」而非
 *      全文件 contains，避免「别处偶然多写一次」造成假绿。
 *
 * 结论：回退 `agent.ts`（流式激活 / ContextEngine 计数器注入）或
 * `agent-manager.ts`（事件转发 / initTokenCounter 接线）中的任一接线，本文件必红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = process.cwd();
const AGENT_SRC = readFileSync(resolve(REPO_ROOT, 'packages/core/src/agent.ts'), 'utf-8');
const AGENT_MANAGER_SRC = readFileSync(resolve(REPO_ROOT, 'packages/core/src/agent-manager.ts'), 'utf-8');

/**
 * 截取一个类方法（以 2 空格缩进的类成员为单位）的方法体文本。
 *
 * 用「下一个同缩进类成员签名」作为右边界，避免大括号计数被模板串 / 注释里的
 * 花括号干扰（agent.ts 的流式方法体近 4k 行，花括号计数不安全）。
 */
function classMethodSlice(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`未找到方法签名：${signature}`);
  const after = src.slice(start + signature.length);
  // 下一个类成员：行首恰好 2 空格 + 可选修饰符 + 标识符 + '(' 或 '<'
  const next = after.match(/\n {2}(?:(?:private|public|protected|static|async|get|set)\s+)*[A-Za-z_$][\w$]*\s*[(<]/);
  return next && next.index !== undefined ? after.slice(0, next.index) : after;
}

describe('接线契约 · P1-9 token 计数器（源码级，M3）', () => {
  it('流式主路径 handleMessageStream 必须调用 activateTokenCounterForModel()', () => {
    const body = classMethodSlice(AGENT_SRC, 'async handleMessageStream');
    expect(body).toContain('await this.activateTokenCounterForModel();');
  });

  it('非流式路径 handleMessage 也必须调用 activateTokenCounterForModel()', () => {
    const body = classMethodSlice(AGENT_SRC, 'async handleMessage(');
    expect(body).toContain('await this.activateTokenCounterForModel();');
  });

  it('任务执行路径 _executeTaskInternal 也必须激活模型', () => {
    const body = classMethodSlice(AGENT_SRC, 'private async _executeTaskInternal(');
    expect(body).toContain('await this.activateTokenCounterForModel();');
  });

  it('Agent 构造时把 per-agent 计数器注入 ContextEngine（否则预算计数回退启发式）', () => {
    // M2 修订：不能是 `new ContextEngine()`（无 config → 进程级单例 → activeModel 恒 ''）。
    expect(AGENT_SRC).toMatch(/new ContextEngine\(\{\s*tokenCounter:\s*this\.tokenCounter\s*\}\)/);
    expect(AGENT_SRC).not.toMatch(/this\.contextEngine = new ContextEngine\(\);/);
  });
});

describe('接线契约 · P1-10 Anthropic 计数接线（源码级，M3）', () => {
  it('AgentManager 启动期调用 initTokenCounter()（生产路径接线）', () => {
    expect(AGENT_MANAGER_SRC).toContain('initTokenCounter(');
    // 断言位于构造函数上下文中（构造器内），而非仅导入。
    const ctorBody = classMethodSlice(AGENT_MANAGER_SRC, 'constructor(');
    expect(ctorBody).toContain('initTokenCounter(');
  });
});

describe('接线契约 · P0-1 事件转发接线（源码级，M3）', () => {
  it('AgentManager.forwardAgentEvents 必须调用 wireAgentEventForwarding()', () => {
    const body = classMethodSlice(AGENT_MANAGER_SRC, 'private forwardAgentEvents(');
    expect(body).toContain('wireAgentEventForwarding(');
  });

  it('转发实现使用模块级白名单 AGENT_FORWARDED_EVENTS（唯一真相源）', () => {
    expect(AGENT_MANAGER_SRC).toMatch(/wireAgentEventForwarding\(agent\.getEventBus\(\),\s*this\.eventBus\)/);
    expect(AGENT_MANAGER_SRC).toContain('export const AGENT_FORWARDED_EVENTS');
  });
});
