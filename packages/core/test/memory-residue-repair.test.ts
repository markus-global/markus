/**
 * H21 — `residue-repair.ts` 纯函数单元测试。
 * 规则要能脱离文件系统直接验证：唯一才回填、歧义/找不到不猜、meta 行不阻断、幂等。
 */
import { describe, it, expect } from 'vitest';
import {
  indexArchiveBodies,
  healStubLines,
  accumulateResidue,
  isArchiveStub,
} from '../src/memory/residue-repair.js';

const STUB = '_[archived → knowledge-archive.md；正文已无损归档，可用 memory_search 检索]_';

describe('indexArchiveBodies', () => {
  it('解析 `## name` → 正文；忽略两个区域标记与空正文', () => {
    const idx = indexArchiveBodies([
      '# Knowledge Archive',
      '## procedures',
      'body-a',
      '## _observations',
      'ignored',
      '## _session_fragments',
      'ignored',
      '## empty',
      '',
      '## procedures',
      'body-b',
    ].join('\n'));
    expect(idx.get('procedures')).toEqual(['body-a', 'body-b']);
    expect(idx.has('_observations')).toBe(false);
    expect(idx.has('_session_fragments')).toBe(false);
    expect(idx.has('empty')).toBe(false);
  });

  it('空归档 → 空索引', () => {
    expect(indexArchiveBodies('').size).toBe(0);
  });
});

describe('healStubLines', () => {
  it('唯一名 → 存根被替换', () => {
    const bodies = new Map([['现象', ['REAL_BODY']]]);
    const { text, result } = healStubLines(['## 现象', STUB].join('\n'), bodies);
    expect(text).toBe('## 现象\nREAL_BODY');
    expect(result.repaired).toBe(1);
  });

  it('重名（歧义）→ 不动并上报候选数', () => {
    const bodies = new Map([['验证', ['A', 'B', 'C']]]);
    const { text, result } = healStubLines(['## 验证', STUB].join('\n'), bodies);
    expect(text).toContain(STUB);
    expect(result.repaired).toBe(0);
    expect(result.ambiguous).toEqual([{ name: '验证', candidates: 3 }]);
  });

  it('找不到名 → 不动并记录', () => {
    const bodies = new Map([['其他', ['X']]]);
    const { text, result } = healStubLines(['## 缺失', STUB].join('\n'), bodies);
    expect(text).toContain(STUB);
    expect(result.notFound).toEqual(['缺失']);
  });

  it('标题与存根之间隔着 meta 注释行 → 仍能定位标题', () => {
    const bodies = new Map([['路由', ['ROUTE']]]);
    const { text } = healStubLines(['### 路由', '<!-- type: note -->', STUB].join('\n'), bodies);
    expect(text).toContain('ROUTE');
  });

  it('多个存根 → 各自独立判定', () => {
    const bodies = new Map([['A', ['BODY_A']], ['B', ['x', 'y']]]);
    const { text, result } = healStubLines(['## A', STUB, '', '## B', STUB].join('\n'), bodies);
    expect(text).toContain('BODY_A');
    expect(result.repaired).toBe(1);
    expect(result.ambiguous).toEqual([{ name: 'B', candidates: 2 }]);
  });

  it('幂等：修完再跑一次 → 0 修复', () => {
    const bodies = new Map([['现象', ['REAL']]]);
    const once = healStubLines(['## 现象', STUB].join('\n'), bodies).text;
    const twice = healStubLines(once, bodies);
    expect(twice.result.repaired).toBe(0);
    expect(twice.text).toBe(once);
  });

  it('无存根 / 无归档 → 原样返回（快速路径）', () => {
    const t = '## A\nplain';
    expect(healStubLines(t, new Map([['A', ['x']]])).text).toBe(t);
    expect(healStubLines(`## A\n${STUB}`, new Map()).text).toBe(`## A\n${STUB}`);
  });

  it('isArchiveStub 只在指针行判定为真', () => {
    expect(isArchiveStub(STUB)).toBe(true);
    expect(isArchiveStub('## 现象')).toBe(false);
    expect(isArchiveStub('正文里提到 _[archived → x]_ 的句子')).toBe(false);
  });
});

describe('accumulateResidue', () => {
  it('聚合去重，歧义取最大候选数', () => {
    const acc = { ambiguous: new Map<string, number>(), notFound: new Set<string>() };
    accumulateResidue(acc, { repaired: 0, ambiguous: [{ name: '验证', candidates: 2 }], notFound: ['x'] });
    accumulateResidue(acc, { repaired: 0, ambiguous: [{ name: '验证', candidates: 5 }], notFound: ['x', 'y'] });
    expect(acc.ambiguous.get('验证')).toBe(5);
    expect([...acc.notFound].sort()).toEqual(['x', 'y']);
  });
});
