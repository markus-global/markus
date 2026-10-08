/**
 * H9 — 「Agent 引用了未安装的技能」必须结构化可见，而不是只丢一行日志。
 *
 * 回归背景（docs/records/PLATFORM-HARDENING-2026-10.md §7 H9）：创建/恢复 agent 的两处代码各自
 * 算了一遍 `config.skills.filter(s => !registry.get(s))`，然后**只 log.warn**。启动恢复
 * 几十个 agent 时刷屏、而界面上零可见——受影响的 agent 静默降级（相关工具从未注册），
 * 看起来一切正常。
 *
 * 本文件钉住：单一计算点 + 每个 agent 实例的状态存取。
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '../src/agent.js';
import {
  resolveMissingSkills,
  buildSkillWarnings,
  setAgentSkillWarnings,
  getAgentSkillWarnings,
  SKILL_WARNINGS_AVAILABLE_LIMIT,
} from '../src/skill-warnings.js';

/** Minimal registry stub — the real SkillRegistry is far heavier than the test needs. */
function registryOf(names: string[]) {
  return {
    get: (n: string): unknown => (names.includes(n) ? { name: n } : undefined),
    list: (): Array<{ name: string }> => names.map((n) => ({ name: n })),
  };
}

describe('resolveMissingSkills — 单一判定点', () => {
  it('没分配技能时恒为 []', () => {
    expect(resolveMissingSkills({ skills: [] }, registryOf(['a']))).toEqual([]);
    expect(resolveMissingSkills({}, registryOf(['a']))).toEqual([]);
    expect(resolveMissingSkills(undefined, registryOf(['a']))).toEqual([]);
    expect(resolveMissingSkills(null, registryOf(['a']))).toEqual([]);
  });

  it('只报 registry 不认识的**已分配**技能（不报 registry 里的其它技能）', () => {
    const r = resolveMissingSkills({ skills: ['a', 'gone', 'b'] }, registryOf(['a', 'b', 'unassigned']));
    expect(r).toEqual(['gone']);
  });

  it('registry 整个缺失时，全部已分配技能都算缺失（不能被静默隐藏）', () => {
    // A mis-wired manager IS a real degradation: the agent's skill tools never register.
    expect(resolveMissingSkills({ skills: ['a', 'b'] }, null)).toEqual(['a', 'b']);
    expect(resolveMissingSkills({ skills: ['a'] }, undefined)).toEqual(['a']);
  });
});

describe('buildSkillWarnings — 缺什么 + 有什么', () => {
  it('missing 与 available 一起给出，available 按上限截断以免撑爆 per-agent payload', () => {
    const many = Array.from({ length: SKILL_WARNINGS_AVAILABLE_LIMIT + 10 }, (_, i) => `s${i}`);
    const w = buildSkillWarnings({ skills: ['nope'] }, registryOf(many));
    expect(w.missing).toEqual(['nope']);
    expect(w.available).toHaveLength(SKILL_WARNINGS_AVAILABLE_LIMIT);
    expect(w.available[0]).toBe('s0');
  });

  it('registry 缺失时不编造 available', () => {
    expect(buildSkillWarnings({ skills: ['a'] }, null)).toEqual({ missing: ['a'], available: [] });
  });

  it('全都在册时 missing 为空（正常状态不产生噪音）', () => {
    expect(buildSkillWarnings({ skills: ['a'] }, registryOf(['a'])).missing).toEqual([]);
  });
});

describe('setAgentSkillWarnings / getAgentSkillWarnings —— 每 agent 实例存取', () => {
  it('按 agent 实例隔离，互不串味', () => {
    const a = {} as unknown as Agent;
    const b = {} as unknown as Agent;
    setAgentSkillWarnings(a, { missing: ['x'], available: ['y'] });
    expect(getAgentSkillWarnings(a)).toEqual({ missing: ['x'], available: ['y'] });
    expect(getAgentSkillWarnings(b)).toBeUndefined();
  });

  it('内部拷贝数组：调用方事后改自己的数组不会污染已存状态', () => {
    const a = {} as unknown as Agent;
    const warnings = { missing: ['x'], available: ['y'] };
    setAgentSkillWarnings(a, warnings);
    warnings.missing.push('injected-later');
    warnings.available.length = 0;
    expect(getAgentSkillWarnings(a)).toEqual({ missing: ['x'], available: ['y'] });
  });

  it('读回的副本被改也不会回写（无共享引用泄漏）', () => {
    const a = {} as unknown as Agent;
    setAgentSkillWarnings(a, { missing: ['x'], available: [] });
    getAgentSkillWarnings(a)!.missing.push('mutated');
    expect(getAgentSkillWarnings(a)!.missing).toEqual(['x']);
  });

  it('从未标记过的 agent 返回 undefined（调用方据此走默认值）', () => {
    expect(getAgentSkillWarnings({} as unknown as Agent)).toBeUndefined();
  });
});
