/**
 * 筛选片的两个断言面（都会咬人）：
 *  ① **取值域**：片必须包含退信两态、不含已删除的 `dropped`
 *     —— 把 `bounced` 从数组里删掉，本文件立刻红；
 *  ② **接线**：每个片都必须有**三语言**文案，且翻译键与片 key 完全对齐
 *     —— 漏加一条 locale，UI 上会显示原始键名（`agent:profilePage.mind.statusFilters.bounced`）。
 *     这类缺陷只有渲染才看得见，用数据对账比渲染整页便宜，也更早失败。
 *
 * 用 JSON import 而不是 `readFileSync(process.cwd()…)`：vitest 的 cwd 随运行方式变化
 * （根目录 / 包目录都出现过），路径漂移会让本测试以「文件不存在」而不是「断言失败」
 * 的方式红 —— 那种红不指向缺陷。
 */
import { describe, it, expect } from 'vitest';
import { MAILBOX_STATUS_FILTERS, statusFilterParam } from './mailboxStatusFilters.ts';
import zhAgent from '../locales/zh-CN/agent.json';
import enAgent from '../locales/en/agent.json';
import esAgent from '../locales/es/agent.json';

const LOCALIZED = [
  ['zh-CN', zhAgent],
  ['en', enAgent],
  ['es', esAgent],
] as const;

function statusFilterLabels(json: unknown): Record<string, string> {
  return (json as {
    profilePage: { mind: { statusFilters: Record<string, string> } };
  }).profilePage.mind.statusFilters;
}

describe('MAILBOX_STATUS_FILTERS —— 取值域与投递状态机一致', () => {
  const keys = MAILBOX_STATUS_FILTERS.map((f) => f.key);

  it('包含退信两态（bounced / catch_all）—— 退信行在 UI 上必须可筛', () => {
    expect(keys).toContain('bounced');
    expect(keys).toContain('catch_all');
  });

  it('不含已删除的 dropped 终态（历史行读路径已归一为 bounced）', () => {
    expect(keys as string[]).not.toContain('dropped');
  });

  it('以 all 开头，且没有重复片', () => {
    expect(keys[0]).toBe('all');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个非 all 片都带状态点颜色（否则片与片看起来一样）', () => {
    for (const f of MAILBOX_STATUS_FILTERS) {
      if (f.key === 'all') expect(f.dot).toBe('');
      else expect(f.dot.length).toBeGreaterThan(0);
    }
  });
});

describe('三语言文案 —— 筛选片 key 与 locale 键严格对齐', () => {
  for (const [locale, json] of LOCALIZED) {
    it(`${locale}: 每个片的 key 都有文案，且没有多余的孤儿键`, () => {
      const labels = statusFilterLabels(json);
      const filterKeys = MAILBOX_STATUS_FILTERS.map((f) => f.key).sort();

      // 片 → 文案：缺一条就是 UI 上显示原始键名
      for (const key of filterKeys) {
        expect(typeof labels[key], `${locale} 缺少 statusFilters.${key}`).toBe('string');
        expect(labels[key]!.length).toBeGreaterThan(0);
      }
      // 文案 → 片：孤儿键意味着「有人改了状态域但没同步筛选片」
      expect(Object.keys(labels).sort()).toEqual(filterKeys);
      expect(labels).not.toHaveProperty('dropped');
    });
  }
});

describe('statusFilterParam —— all 不是状态', () => {
  it('all / 空 → undefined（不把 "all" 当 status 传给 API）', () => {
    expect(statusFilterParam('all')).toBeUndefined();
    expect(statusFilterParam(undefined)).toBeUndefined();
    expect(statusFilterParam('')).toBeUndefined();
  });

  it('真实状态原样透传', () => {
    expect(statusFilterParam('bounced')).toBe('bounced');
    expect(statusFilterParam('catch_all')).toBe('catch_all');
  });
});
