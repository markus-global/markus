/**
 * C10-0G —— 纪元本地化契约守卫（取代 C10-0B 哨兵协议测试，哨兵测试随哨兵机制死）。
 *
 * Owner 裁决（2026-11-22）：每日审计机制不进产品；真库审计只以 Owner 本地实例的
 * 定时任务存在。纪元因此不再是产品常量（产品纪元常量与缺省解析器已删除，
 * 名字在下方断言里运行时拼接，保全文 grep 干净），而是**部署参数**：
 *   ① 模块不得再导出纪元常量 / 缺省解析器（复活 → 本测试红）；
 *   ② makeIdentityGates 必须显式传纪元 —— 缺省 / null / undefined / 空串一律拒
 *      （fail closed，绝不静默绿，绝不 now() 兜底）；
 *   ③ 显式纪元是唯一 lower bound：调用方传什么就是什么（本地化语义，无第二来源）；
 *   ④ 不可解析的纪元必须拒。
 * 处置决议记录现在是历史档案 + dated 更正注，产品代码不再读它 ——
 * 「常量与记录同源」的旧断言随产品常量一起死。
 */
import { describe, it, expect } from 'vitest';
import * as identityAudit from '../src/identity-audit.js';
import { makeIdentityGates, type IdentityGateOptions } from '../src/identity-audit.js';

const EPOCH_A = '2026-11-22T12:18:34.000Z';
const EPOCH_B = '2026-11-15T00:00:00.000Z';
// 已删符号的名字运行时拼接：本文件是「缺席断言」，不是残留。
const DEAD_CONSTANT = 'IDENTITY_FIX_' + 'EPOCH';
const DEAD_RESOLVER = 'resolveIdentityFix' + 'Epoch';

describe('C10-0G：纪元本地化契约', () => {
  it('模块不得导出产品纪元常量或缺省解析器（复活必须红）', () => {
    expect(Object.keys(identityAudit)).not.toContain(DEAD_CONSTANT);
    expect(Object.keys(identityAudit)).not.toContain(DEAD_RESOLVER);
  });

  it('缺纪元必拒：无参 / null / undefined / 空串都抛（绝不静默绿，绝不 now() 兜底）', () => {
    // 无参调用：epoch 是必填参数，类型上就不该允许；这里同时咬运行时行为。
    expect(() => (makeIdentityGates as unknown as () => unknown)()).toThrow(/epoch-unset|显式/);
    expect(() => makeIdentityGates({ epoch: null } as unknown as IdentityGateOptions)).toThrow(/epoch-unset|显式/);
    expect(() => makeIdentityGates({ epoch: undefined } as unknown as IdentityGateOptions)).toThrow(/epoch-unset|显式/);
    expect(() => makeIdentityGates({ epoch: '' })).toThrow(/epoch-unset|显式/);
  });

  it('不可解析的纪元必须拒', () => {
    expect(() => makeIdentityGates({ epoch: 'not-a-timestamp' })).toThrow(/可解析/);
  });

  it('显式纪元是唯一 lower bound（本地化：调用方的纪元被尊重，无第二来源）', () => {
    const gatesA = makeIdentityGates({ epoch: EPOCH_A });
    const gatesB = makeIdentityGates({ epoch: EPOCH_B });
    expect(gatesA.length).toBeGreaterThanOrEqual(12);
    for (const id of [1, 2, 5, 11]) {
      const a = gatesA.find(g => g.id === id)!;
      const b = gatesB.find(g => g.id === id)!;
      expect(a.sql, `判据 ${id} 必须用调用方传入的纪元`).toContain(EPOCH_A);
      expect(a.sql, `判据 ${id} 不得混入另一个纪元（第二来源）`).not.toContain(EPOCH_B);
      expect(b.sql).toContain(EPOCH_B);
    }
  });
});
