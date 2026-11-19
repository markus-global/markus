/**
 * Heartbeat **state fingerprint** and active-hours helpers.
 *
 * The scheduler class that used to live here is gone (forever-loop M6): the periodic
 * patrol is no longer a scheduler object owning a timer. Sleep is `rest`, and the
 * single clock (`AgentClock`) owns the only timers.
 */

export interface HeartbeatActiveHours {
  start: string;   // "08:00"
  end: string;     // "22:00"
  timezone?: string;
}

export interface HeartbeatConfig {
  intervalMs: number;
  enabled: boolean;
  activeHours?: HeartbeatActiveHours;
}

/**
 * C1: minutes-since-midnight for `date` **in a specific IANA timezone**.
 * Falls back to the host-local clock when no timezone is given or the timezone
 * is invalid. Pure and side-effect-free so active-hours logic is testable and
 * consistent regardless of where the process runs.
 */
export function minutesOfDayInTimeZone(date: Date, timeZone?: string): number {
  if (!timeZone) return date.getHours() * 60 + date.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    let h = 0;
    let m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = parseInt(p.value, 10) % 24; // '24' → 0 at midnight
      else if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    return h * 60 + m;
  } catch {
    // Invalid timezone id — degrade to local time rather than throwing in a timer.
    return date.getHours() * 60 + date.getMinutes();
  }
}

/**
 * C1: whether `now` falls inside the configured active-hours window, evaluated in
 * `activeHours.timezone` (not the host's local timezone). Handles windows that wrap
 * past midnight (e.g. 22:00–06:00). Pure so it can be unit-tested across timezones.
 */
export function isWithinActiveHours(activeHours: HeartbeatActiveHours, now: Date = new Date()): boolean {
  const [startH, startM] = activeHours.start.split(':').map(Number);
  const [endH, endM] = activeHours.end.split(':').map(Number);
  const current = minutesOfDayInTimeZone(now, activeHours.timezone);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  if (startMin <= endMin) {
    return current >= startMin && current < endMin;
  }
  // Wraps midnight (e.g. 22:00 - 06:00)
  return current >= startMin || current < endMin;
}

/**
 * 重构 2：心跳巡检状态指纹（纯函数，可确定性单测）。
 *
 * 编码「与 LLM 巡检相关的 agent 状态」—— 队列内容 + 活跃任务。仅当指纹变化时
 * 才值得运行一次心跳 LLM 巡检；指纹不变 → skip（只写时间戳落库，不空转 LLM）。
 *
 * 维度设计（对照 docs/agent-liveness-redesign.md §三.2「LLM 巡检只在有实际变化时发生」）：
 *   · 队列签名：**内容（sourceType + item id）**而非深度 —— 同一邮件一直挂着不构成
 *     「状态变化」；新邮件到达（新 id）才触发。修复旧实现「队列深度相同即 skip /
 *     队列深度变化即巡检」的双向误判：同一邮件挂一天不空转 LLM，新邮件却立刻感知。
 *   · 活跃任务签名：任务开始/结束 → 巡检一次；任务集稳定 → 不巡检（任务会话自己
 *     在做 LLM 工作，心跳不需要重复巡检）。
 *
 * 特意**不含** lastHeartbeat 时间戳（skip 也会写它 → 含则指纹恒变化 → 永远巡检）。
 */
export function heartbeatStateFingerprint(
  queued: Array<{ sourceType: string; id: string }>,
  activeTaskIds: Iterable<string>,
): string {
  const queue = queued
    .filter(i => i.sourceType !== 'heartbeat')
    .map(i => `${i.sourceType}:${i.id}`)
    .sort()
    .join(',');
  const tasks = [...activeTaskIds].sort().join(',');
  return `q:[${queue}]|t:[${tasks}]`;
}
