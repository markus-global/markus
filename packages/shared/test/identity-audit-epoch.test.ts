/**
 * C10-0B §3.4 —— 产品纪元的**哨兵协议守卫**（CTO 裁决 A + 补口①②③④）。
 *
 * 咬住的约束：
 *   ① 纪元常量与处置决议记录**同源**：常量里的值必须就是记录里定值的那个。
 *      变异「有人预置计划时刻」（往常量塞一个不在记录里的时间）→ 本测试红。
 *      定值 commit 必须同时改常量 + 记录（补口②），否则红。
 *   ② 哨兵期（null）不得静默绿：makeIdentityGates 对 null 抛错（fail closed），
 *      resolveIdentityFixEpoch 绝不用 Date.now() 兜底。
 *      变异「把哨兵改成静默通过 / now() 兜底」→ 本测试红。
 *   ③ 三态可区分：null 是独立状态，不是某个时间字符串。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IDENTITY_FIX_EPOCH,
  resolveIdentityFixEpoch,
  makeIdentityGates,
} from '../src/identity-audit.js';

const RECORD_PATH = fileURLToPath(
  new URL('../../../docs/records/identity-backlog-disposition-2026-11-22.md', import.meta.url),
);

/** 处置决议记录里的定值标记（唯一权威出处）。`unset` = 哨兵期。 */
function recordedFinalEpoch(): string | null {
  const text = readFileSync(RECORD_PATH, 'utf-8');
  const m = text.match(/^FINAL_EPOCH:\s*(\S+)\s*$/m);
  if (!m) {
    throw new Error(`处置决议记录缺少 FINAL_EPOCH 标记：${RECORD_PATH}`);
  }
  return m[1] === 'unset' ? null : m[1]!;
}

describe('C10-0B：产品纪元哨兵协议', () => {
  it('纪元常量与处置决议记录同源（预置计划时刻变异必须红）', () => {
    const recorded = recordedFinalEpoch();
    expect(
      IDENTITY_FIX_EPOCH,
      '常量必须就是处置决议记录里定值的那个时刻；哨兵期两边都是 null/unset。' +
      '往常量里塞一个记录里没有的时刻 = 预置计划时刻（赌重启准时），必须红。',
    ).toBe(recorded);
    if (IDENTITY_FIX_EPOCH !== null) {
      expect(Number.isNaN(Date.parse(IDENTITY_FIX_EPOCH)), '定值必须是可解析的时间').toBe(false);
    }
  });

  it('哨兵期 fail closed：null 纪元不得建门禁（绝不静默绿）', () => {
    expect(() => makeIdentityGates({ epoch: null })).toThrow(/epoch-unset|未定值/);
  });

  it('resolveIdentityFixEpoch 绝不用 now() 兜底', () => {
    expect(resolveIdentityFixEpoch(null), '显式 null 保持 null（哨兵语义）').toBeNull();
    expect(resolveIdentityFixEpoch('2026-11-15T00:00:00.000Z'), '显式注入优先').toBe('2026-11-15T00:00:00.000Z');
    // 缺省读产品常量：哨兵期必须得到 null，而不是一个「现在」的时间戳。
    expect(resolveIdentityFixEpoch()).toBe(IDENTITY_FIX_EPOCH);
    if (IDENTITY_FIX_EPOCH === null) {
      expect(resolveIdentityFixEpoch(), '哨兵期缺省解析必须是 null，不得兜底成 now()').toBeNull();
    }
  });

  it('已定值时门禁可建且带纪元下界（定值后哨兵测试仍绿）', () => {
    const epoch = IDENTITY_FIX_EPOCH ?? '2026-11-15T00:00:00.000Z';
    const gates = makeIdentityGates({ epoch });
    const g11 = gates.find(g => g.id === 11)!;
    expect(g11.sql).toContain(epoch);
    expect(gates.length).toBeGreaterThanOrEqual(12);
  });
});