/**
 * 浏览器侧终态判据的守卫。
 *
 * 跨构建边界的漂移测试在 `packages/shared/test/terminal-status-mirror.test.ts`；
 * 这里只钉住本包自己的语义，免得 web-ui 的 CI 与 shared 的 CI 互相掩盖问题。
 */
import { describe, it, expect } from 'vitest';
import { isTerminal, TERMINAL_STATUSES } from '../src/lib/taskStatus';

describe('web-ui terminal predicate', () => {
  it('never classifies live work as finished', () => {
    for (const live of ['pending', 'in_progress', 'blocked', 'review']) {
      expect(isTerminal(live)).toBe(false);
    }
  });

  it('classifies the five finished statuses as terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      'archived',
      'cancelled',
      'completed',
      'failed',
      'rejected',
    ]);
  });

  it('treats an unknown status as unfinished, not as finished', () => {
    expect(isTerminal('accepted')).toBe(false);
    expect(isTerminal(undefined)).toBe(false);
  });
});
