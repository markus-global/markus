/**
 * C10-B —— 外部信号 ref 的唯一构造器（计划 §B，身份修订 post-0B）。
 *
 * 冻结约束：幂等 per messageId、入队前 ensure、恰好一个建造点。
 * 形状是卡内裁量（评审可否决）：`external:<source>:<encodeURIComponent(messageId)>`。
 * 为什么用 encodeURIComponent：外部 messageId 是任意字符串（RSS guid 常是 URL），
 * 单射编码保证「不同 messageId 绝不同 ref」（清洗式 sanitize 会碰撞 = 假幂等），
 * 且是 JS 全局函数 —— work-unit.ts 保持纯声明、零 import。
 *
 * 本文件在 base（37c817aa）上必须红：构造器尚不存在。
 */
import { describe, it, expect } from 'vitest';
import {
  WORK_UNIT_REF,
  entityKeysOfWorkUnitRef,
  sessionScopeKeyOfWorkUnitRef,
} from '../src/work-unit.js';

describe('C10-B：WORK_UNIT_REF.external 唯一构造器', () => {
  it('构造器存在且形状稳定：external:<source>:<encoded messageId>', () => {
    expect(typeof WORK_UNIT_REF.external).toBe('function');
    const ref = WORK_UNIT_REF.external('src_feed1', 'https://example.com/item?a=1&b=2');
    expect(ref).toBe(`external:src_feed1:${encodeURIComponent('https://example.com/item?a=1&b=2')}`);
  });

  it('幂等：同 (source, messageId) 永远同 ref（重复投递命中 uq_work_units_ref = 同一条活）', () => {
    const a = WORK_UNIT_REF.external('src_hook', 'msg-001');
    const b = WORK_UNIT_REF.external('src_hook', 'msg-001');
    expect(a).toBe(b);
  });

  it('单射：不同 messageId 绝不同 ref —— 含「清洗后会碰撞」的对抗样本', () => {
    // 若实现用「替换非法字符」式 sanitize，这两个会撞成同一个 ref（假幂等）。
    const a = WORK_UNIT_REF.external('src_x', 'a/b');
    const b = WORK_UNIT_REF.external('src_x', 'a?b');
    expect(a).not.toBe(b);
    const c = WORK_UNIT_REF.external('src_x', 'a b');
    const d = WORK_UNIT_REF.external('src_x', 'a+b');
    expect(c).not.toBe(d);
    // 不同 source 的同 messageId 也是不同事件（源是身份的一部分）。
    expect(WORK_UNIT_REF.external('src_1', 'm')).not.toBe(WORK_UNIT_REF.external('src_2', 'm'));
  });

  it('source 字符集 fail-closed：非法 source 必拒（可行动错误，不静默改写）', () => {
    for (const bad of ['', 'UPPER', 'has space', 'a:b', 'a/b', '-lead', 'a'.repeat(200)]) {
      expect(() => WORK_UNIT_REF.external(bad, 'm'), `source=${JSON.stringify(bad)}`).toThrow();
    }
    // 合法 source 不拒。
    expect(() => WORK_UNIT_REF.external('src_0-a', 'm')).not.toThrow();
  });

  it('messageId 为空必拒（幂等键不能是空串 —— 那会让所有无 id 事件撞成一条活）', () => {
    expect(() => WORK_UNIT_REF.external('src_x', '')).toThrow();
  });

  it('实体键派生：每个外部事件即实体（wu:<ref>），threadRef 永不参与去重/路由', () => {
    const ref = WORK_UNIT_REF.external('src_x', 'm-1');
    expect(entityKeysOfWorkUnitRef(ref)).toEqual([`wu:${ref}`]);
  });

  it('会话作用域：external ref 不声明会话身份（undefined → 调用方走既有路径，不猜）', () => {
    expect(sessionScopeKeyOfWorkUnitRef(WORK_UNIT_REF.external('src_x', 'm-1'))).toBeUndefined();
  });
});
