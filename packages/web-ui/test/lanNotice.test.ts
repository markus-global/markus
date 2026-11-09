import { describe, it, expect, beforeEach } from 'vitest';
import {
  shouldShowLanNotice,
  acknowledgeLanNotice,
  isLanNoticeAcknowledged,
  __resetLanNoticeForTests,
} from '../src/lib/lanNotice.ts';

describe('lanNotice', () => {
  beforeEach(() => __resetLanNoticeForTests());

  it('shows the notice on a fresh install (exposed, never acknowledged)', () => {
    expect(shouldShowLanNotice(true, '0.0.0.0')).toBe(true);
  });

  it('never shows when not exposed', () => {
    expect(shouldShowLanNotice(false, '127.0.0.1')).toBe(false);
  });

  // 这条是本次修复的靶心：用户手动关闭过，就不该在下次启动再被提醒一遍。
  it('stays silent on every later start after the user dismissed it', () => {
    acknowledgeLanNotice('0.0.0.0');
    // 模拟若干次重启（新进程 = 内存状态清空，只剩 localStorage）
    expect(shouldShowLanNotice(true, '0.0.0.0')).toBe(false);
    expect(shouldShowLanNotice(true, '0.0.0.0')).toBe(false);
  });

  it('re-notifies when the exposed address actually changes', () => {
    acknowledgeLanNotice('0.0.0.0');
    // 新的暴露事实 → 用户还没对这件事表态过
    expect(shouldShowLanNotice(true, '192.168.1.10')).toBe(true);
  });

  it('acknowledgement is scoped per host, not a global mute', () => {
    acknowledgeLanNotice('192.168.1.10');
    expect(isLanNoticeAcknowledged('192.168.1.10')).toBe(true);
    expect(isLanNoticeAcknowledged('0.0.0.0')).toBe(false);
  });
});
