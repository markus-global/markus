/**
 * 通知时间显示的回归护栏。
 *
 * 用户报障：审阅通知的弹窗只有标题和正文，看不到「这条通知是什么时候产生的」→ 对时效没有感知。
 * 需求：既要**具体时间**，也要**友好形式**（xx分钟前 / xx小时前 / xx天前）。
 *
 * 之前「相对时间」在代码里被重复实现了 5 次（NotificationBell.timeAgo、Deliverables/Work/Home/
 * AgentProfile 各一份），本次收敛成唯一实现 lib/timeAgo.ts，任何入口都调它。
 */
import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { timeAgo, formatExactTime, formatNotificationTime } from '../src/lib/timeAgo.ts';

/** 假 t：模拟 i18next 的 key / count 插值，断言「选了哪个 key」。 */
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts && 'count' in opts ? `${key}:${opts.count}` : key) as unknown as TFunction;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('timeAgo —— 友好相对时间', () => {
  it('不到 1 分钟 → 刚刚', () => {
    expect(timeAgo(ago(30_000), t)).toBe('common:time.now');
  });

  it('分钟级', () => {
    expect(timeAgo(ago(5 * MIN), t)).toBe('common:time.minutesAgo:5');
    expect(timeAgo(ago(59 * MIN), t)).toBe('common:time.minutesAgo:59');
  });

  it('小时级（60 分钟进位）', () => {
    expect(timeAgo(ago(60 * MIN), t)).toBe('common:time.hoursAgo:1');
    expect(timeAgo(ago(3 * HOUR + 20 * MIN), t)).toBe('common:time.hoursAgo:3');
  });

  it('天级（24 小时进位）', () => {
    expect(timeAgo(ago(DAY), t)).toBe('common:time.daysAgo:1');
    expect(timeAgo(ago(5 * DAY + HOUR), t)).toBe('common:time.daysAgo:5');
  });

  it('非法 / 空时间 → 空串（不能吐出 "NaN 分钟前"）', () => {
    expect(timeAgo('not-a-date', t)).toBe('');
    expect(timeAgo('', t)).toBe('');
  });
});

describe('formatExactTime —— 具体时间', () => {
  it('按语言本地化，含年份', () => {
    const s = formatExactTime('2026-10-08T05:20:15.601Z', 'en-US');
    expect(s).toContain('2026');
  });

  it('非法 / 空 → 空串', () => {
    expect(formatExactTime('bad', 'en-US')).toBe('');
    expect(formatExactTime('', 'en-US')).toBe('');
  });
});

describe('formatNotificationTime —— 一次性给全「相对 + 具体」', () => {
  it('两者都要有', () => {
    const iso = ago(3 * HOUR);
    const { relative, absolute } = formatNotificationTime(iso, t, 'en-US');
    expect(relative).toBe('common:time.hoursAgo:3');
    expect(absolute).toContain('2026');
  });
});
