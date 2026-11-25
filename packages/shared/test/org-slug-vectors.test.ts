/**
 * 跨仓 slug 契约（markus 侧断言）。
 *
 * 分工：hub 负责**生成**（`sanitizeOrgSlug`），markus 负责**校验与寻址**
 * （`checkOrgSlug`）。两个仓库无法共享代码，只能共享数据 —— 本测试就是那半边
 * 契约：hub 声称会产出的每一个 slug，都必须能被本机的地址规则接受。
 *
 * 判据（缺一不可，任一条被改坏都会红）：
 *  1. hub 向量表里每个 `expected` 都通过 `checkOrgSlug`；
 *  2. 每个 `expected` 都不超 `MAX_ORG_SLUG_LENGTH`；
 *  3. 冲突消解（含 29/30 字符长 base）的结果同样通过；
 *  4. 反面样本（旧实现会产出的不可寻址形态）确实被拒绝 —— 否则本测试只是在
 *     验证「校验器什么都放行」，等于没测。
 */
import { describe, it, expect } from 'vitest';
import { checkOrgSlug, MAX_ORG_SLUG_LENGTH } from '../src/address.js';
import { ORG_SLUG_VECTORS, ORG_SLUG_SUFFIX_VECTORS } from '../src/org-slug-vectors.js';

describe('跨仓 slug 契约（markus 侧：hub 的产出必须可寻址）', () => {
  it('hub 声称会产出的每个 slug，都能通过本机地址规则', () => {
    const rejected = ORG_SLUG_VECTORS.map((v) => ({
      expected: v.expected,
      why: v.why,
      check: checkOrgSlug(v.expected),
    })).filter((v) => v.check.ok !== true);
    expect(rejected).toEqual([]);
  });

  it('每个 expected 都不超地址 org 段上限（30）', () => {
    for (const v of ORG_SLUG_VECTORS) {
      expect(v.expected.length).toBeLessThanOrEqual(MAX_ORG_SLUG_LENGTH);
    }
  });

  it('冲突消解的结果同样可寻址（含 29/30 字符长 base）', () => {
    const rejected = ORG_SLUG_SUFFIX_VECTORS.map((v) => ({
      expected: v.expected,
      len: v.expected.length,
      check: checkOrgSlug(v.expected),
    })).filter((v) => v.check.ok !== true);
    expect(rejected).toEqual([]);

    for (const v of ORG_SLUG_SUFFIX_VECTORS) {
      expect(v.expected.length).toBeLessThanOrEqual(MAX_ORG_SLUG_LENGTH);
    }
  });

  it('反面样本确实被拒绝 —— 证明校验器不是什么都放行', () => {
    // 旧 hub 路径用原始用户名当 slug，产出的正是这些形态：唯一，但不可寻址。
    const mustReject = [
      'org_default', // 下划线
      'AcmeCorp', // 大写
      'a'.repeat(31), // 超 30 字符
      '', // 空
    ];
    for (const bad of mustReject) {
      expect(checkOrgSlug(bad).ok).toBe(false);
    }
  });

  it('已知差异（不是 bug）：markus 校验器允许数字开头，hub 生成器不允许', () => {
    // hub 用 ITEM_SLUG_RE = /^[a-z]/ 生成，而 markus 的 checkOrgSlug 不要求首字符为
    // 字母。实测（2026-11-25）确认 `1password` 在本机被接受、在 hub 会回落成 `org`。
    //
    // 方向是安全的：hub 产出的必然能过 markus 校验；反向那些形态 hub 永不生成，且
    // 本地占位恒为 `local-<hash>`（字母开头），所以不会出现「markus 接受、hub 不
    // 认识」的可用地址。
    //
    // 把它钉成契约而不是放任：任何一侧收紧/放宽首字符规则，这里会先红。
    expect(checkOrgSlug('1password').ok).toBe(true);
  });
});
