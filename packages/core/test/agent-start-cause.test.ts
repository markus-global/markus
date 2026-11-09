import { describe, it, expect } from 'vitest';
import {
  AgentStoppedByHumanError,
  HUMAN_STOP_MEANING,
  decideStart,
  type StartCause,
} from '../src/agent-start-cause.js';

/**
 * 判据契约（S0）的行为测试。
 *
 * 守的不是「某几行代码」，而是 Owner 2026-11-08 定的规则：
 * **停止之后，除非人类手动启动、或 Agent 自己发了审批等人回答，否则不得自行启动。**
 *
 * 同时守住反方向的过度纠正：**崩掉的（未被人类停止的）仍然可以被 Agent 拉回来。**
 * 只测「该拒的都拒」会让下一次重构顺手把自愈能力删掉。
 */

const ALL_CAUSES: StartCause[] = [
  'human', 'boot', 'creation', 'agent-a2a', 'agent-tool', 'system-resume-all', 'team-start', 'unattributed',
];

/** 允许启动「人类停掉的」agent 的原因（S0 左列）。 */
const MAY_START_HUMAN_STOPPED = new Set<StartCause>(['human', 'creation']);

describe('decideStart — 被人类停掉的 agent', () => {
  for (const cause of ALL_CAUSES) {
    const expected = MAY_START_HUMAN_STOPPED.has(cause);
    it(`${cause} → ${expected ? '允许' : '拒绝'}`, () => {
      const d = decideStart({ cause, stoppedByHuman: true });
      expect(d.allowed).toBe(expected);
    });
  }

  it('拒绝时给出机器可读的原因码，而不是一句字符串', () => {
    const d = decideStart({ cause: 'agent-a2a', stoppedByHuman: true });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('AGENT_STOPPED_BY_HUMAN');
  });

  it('force（人类在 UI 二次确认后的显式覆盖）可以启动，并且会清掉人停标记', () => {
    const d = decideStart({ cause: 'system-resume-all', stoppedByHuman: true, force: true });
    expect(d).toEqual({ allowed: true, clearsHumanStop: true });
  });
});

describe('decideStart — 没被人类停掉的 agent（崩溃 / 未启动）', () => {
  for (const cause of ALL_CAUSES) {
    it(`${cause} → 允许（自愈能力必须保留）`, () => {
      const d = decideStart({ cause, stoppedByHuman: false });
      expect(d.allowed).toBe(true);
    });
  }

  it('只有 human / creation 会主动去清「人停标记」，其余路径不碰它', () => {
    for (const cause of ALL_CAUSES) {
      const d = decideStart({ cause, stoppedByHuman: false });
      expect(d.allowed).toBe(true);
      if (!d.allowed) continue;
      expect(d.clearsHumanStop).toBe(cause === 'human' || cause === 'creation');
    }
  });
});

describe('AgentStoppedByHumanError — 越界要带可行动提示', () => {
  it('带 code / agentId / cause，且告诉 Agent 下一步该做什么', () => {
    const err = new AgentStoppedByHumanError('agt_1', 'agent-tool');
    expect(err.code).toBe('AGENT_STOPPED_BY_HUMAN');
    expect(err.agentId).toBe('agt_1');
    expect(err.cause).toBe('agent-tool');
    expect(err.message).toContain('stopped by the human');
    // 不能只报错不给出路：否则 Agent 只会重试同一条被拒绝的路径。
    expect(err.message).toContain('request_user_input');
  });

  it('instanceof Error（跨模块 catch 依赖这一点）', () => {
    expect(new AgentStoppedByHumanError('a', 'agent-a2a')).toBeInstanceOf(Error);
  });
});

describe('HUMAN_STOP_MEANING — 停止按钮与提示共用一句', () => {
  it('非空且说明「只有人类启动才会恢复」', () => {
    expect(HUMAN_STOP_MEANING.length).toBeGreaterThan(20);
    expect(HUMAN_STOP_MEANING).toMatch(/human/i);
  });
});
