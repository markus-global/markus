/**
 * Heartbeat deep sleep — AGENT-RUNTIME §8 / STATE-MACHINES deep-sleep Spec
 */
import {
  DEEP_SLEEP_IDLE_HEARTBEATS,
  MAX_HEARTBEAT_INTERVAL_MS,
} from '@markus/shared';

export function shouldEnterDeepSleep(opts: {
  consecutiveIdleHeartbeats: number;
  hasActiveTasks: boolean;
  hasPendingReviews: boolean;
  hasHumanOrTaskMailbox: boolean;
  threshold?: number;
}): boolean {
  const n = opts.threshold ?? DEEP_SLEEP_IDLE_HEARTBEATS;
  if (opts.consecutiveIdleHeartbeats < n) return false;
  if (opts.hasActiveTasks) return false;
  if (opts.hasPendingReviews) return false;
  if (opts.hasHumanOrTaskMailbox) return false;
  return true;
}

/** Double interval, capped at MAX_HEARTBEAT_INTERVAL_MS (24h). */
export function nextDeepSleepIntervalMs(currentMs: number): number {
  const cur = Number.isFinite(currentMs) && currentMs > 0 ? currentMs : 6 * 60 * 60 * 1000;
  return Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.max(cur * 2, cur));
}

export function resetIdleOnWake(): number {
  return 0;
}
