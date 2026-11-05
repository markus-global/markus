/**
 * 跨构建边界的契约测试：浏览器侧的终态投影必须等于服务端的唯一常量。
 *
 * `packages/web-ui` 不能运行时 import `@markus/shared`（浏览器包体不该拖进
 * fs/crypto 这类 node 侧依赖），所以 UI 侧保留一份纯数据投影
 * （`packages/web-ui/src/lib/taskStatus.ts`）。同一约束下 `mailboxTypeMeta.ts`
 * 已经踩过坑：手维护的镜像悄悄漂移，两个类型整类消失而没人发现。
 *
 * 这里的规则与那次一致：**写入者仍然只有一个**（shared 的 `TERMINAL_STATUSES`）。
 * web-ui 的文件是投影，不是第二个定义 —— 两边不一致时红的是本测试，不是用户界面。
 */
import { describe, it, expect } from 'vitest';
import {
  TERMINAL_STATUSES,
  isTerminal,
  type ItemStatus,
} from '../src/types/task.js';
import {
  TERMINAL_STATUSES as UI_TERMINAL_STATUSES,
  TERMINAL_REQUIREMENT_STATUSES as UI_TERMINAL_REQUIREMENT_STATUSES,
  isTerminal as uiIsTerminal,
} from '../../web-ui/src/lib/taskStatus.js';
import { TERMINAL_REQUIREMENT_STATUSES } from '../src/types/requirement.js';
import {
  HIDDEN_BY_DEFAULT_STATUSES,
  isHiddenByDefault,
} from '../../web-ui/src/lib/boardFilters.js';

const ALL_STATUSES: ItemStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'archived',
];

describe('browser projection of the terminal predicate', () => {
  it('mirrors exactly the server set', () => {
    expect([...UI_TERMINAL_STATUSES].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  it('answers identically for every status, plus the legacy junk strings', () => {
    const drift = [...ALL_STATUSES, 'accepted', '', 'pending_approval'].filter(
      (s) => uiIsTerminal(s) !== isTerminal(s),
    );
    expect(drift).toEqual([]);
  });

  it('mirrors the requirement-terminal projection too — a different question on the same enum', () => {
    expect([...UI_TERMINAL_REQUIREMENT_STATUSES].sort())
      .toEqual([...TERMINAL_REQUIREMENT_STATUSES].sort());
    // 需求不会「执行失败」—— 若有人把两个集合合并，这条会红。
    expect(UI_TERMINAL_REQUIREMENT_STATUSES.has('failed')).toBe(false);
  });
});

describe('board visibility is a different question than "is it terminal"', () => {
  it('hides only the three statuses that are closed for good — completed/failed stay visible', () => {
    expect([...HIDDEN_BY_DEFAULT_STATUSES].sort()).toEqual(['archived', 'cancelled', 'rejected']);
    expect(isHiddenByDefault('completed')).toBe(false);
    expect(isHiddenByDefault('failed')).toBe(false);
  });

  it('the two sets must never be merged', () => {
    // 合并的后果不是重构，是用户可见的行为变更：已完成任务会从默认看板消失
    // （必须打开「显示已关闭」才看得到）。而且「默认是否隐藏」与「是否结束」
    // 会变成一个问题一个答案 —— 正是本次审计要消灭的那种形状。
    expect([...HIDDEN_BY_DEFAULT_STATUSES].sort()).not.toEqual([...TERMINAL_STATUSES].sort());
  });

  it('the view set is nevertheless a strict subset of terminal — it may only hide finished work', () => {
    for (const s of HIDDEN_BY_DEFAULT_STATUSES) {
      expect(isTerminal(s)).toBe(true);
    }
  });
});
