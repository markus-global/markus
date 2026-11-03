import { describe, it, expect } from 'vitest';
import { looksLikeRef, matchesThreadQuery } from './threadSearch.ts';

/**
 * 全局流页的语义守门：**检索，不是目录**。
 *
 * 这一组测试直接对应 B4 的判据「全局页不再是主视图」：
 * 检索面的定义是「没有查询就没有结果」，所以 `matchesThreadQuery('')` 必须是 false，
 * 空查询时页面不渲染任何流。如果哪天有人把这一页改回列表，改的不会是这两个函数，
 * 而是页面本身 —— 页面级断言在 `pages/ThreadView.test.tsx`。
 */
describe('looksLikeRef —— 哪些输入是「流标识」而不是搜索词', () => {
  it('平台内置 id 前缀直接认（大小写不敏感）', () => {
    expect(looksLikeRef('tsk_abc123')).toBe(true);
    expect(looksLikeRef('tkt_abc123')).toBe(true);
    expect(looksLikeRef('TSK_abc')).toBe(true);
    expect(looksLikeRef('cs_1b4bab83e4e7431d')).toBe(true);
    expect(looksLikeRef('a2a_agtA__agtB')).toBe(true);
  });

  it('外部资源键按结构识别（前缀 + 冒号 + 非空局部名），不靠白名单枚举', () => {
    expect(looksLikeRef('gh:acme/repo')).toBe(true);
    expect(looksLikeRef('xhs:brand_01')).toBe(true);
    expect(looksLikeRef('agent:agt_x')).toBe(true);
  });

  it('自然语言、带空格、空串都不是 ref', () => {
    expect(looksLikeRef('登录超时')).toBe(false);
    expect(looksLikeRef('fix login timeout')).toBe(false);
    expect(looksLikeRef('')).toBe(false);
    expect(looksLikeRef('   ')).toBe(false);
    expect(looksLikeRef(':nothing')).toBe(false);
    expect(looksLikeRef('trailing:')).toBe(false);
  });
});

describe('matchesThreadQuery —— 标题 / ref / 详情命中', () => {
  const row = { ref: 'tsk_abc', title: '修登录超时', detail: 'CI 失败后重跑通过' };

  it('大小写不敏感地命中标题与 ref', () => {
    expect(matchesThreadQuery(row, '登录')).toBe(true);
    expect(matchesThreadQuery(row, 'TSK_ABC')).toBe(true);
    expect(matchesThreadQuery(row, 'ci 失败')).toBe(true);
  });

  it('空查询不命中任何东西 —— 检索面没有「默认全部」', () => {
    expect(matchesThreadQuery(row, '')).toBe(false);
    expect(matchesThreadQuery(row, '   ')).toBe(false);
  });

  it('不命中就是不命中（不做模糊猜测）', () => {
    expect(matchesThreadQuery(row, '支付')).toBe(false);
  });
});
