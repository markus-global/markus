import {
  shouldEnterDeepSleep,
  nextDeepSleepIntervalMs,
  resetIdleOnWake,
} from '../src/deep-sleep.js';
import { DEEP_SLEEP_IDLE_HEARTBEATS, MAX_HEARTBEAT_INTERVAL_MS } from '@markus/shared';

describe('deep sleep (STATE-MACHINES / AGENT-RUNTIME)', () => {
  it('A-deep-sleep-skip: enters when idle streak and org quiet', () => {
    expect(
      shouldEnterDeepSleep({
        consecutiveIdleHeartbeats: DEEP_SLEEP_IDLE_HEARTBEATS,
        hasActiveTasks: false,
        hasPendingReviews: false,
        hasHumanOrTaskMailbox: false,
      }),
    ).toBe(true);
  });

  it('does not sleep with active work or mailbox pressure', () => {
    expect(
      shouldEnterDeepSleep({
        consecutiveIdleHeartbeats: 10,
        hasActiveTasks: true,
        hasPendingReviews: false,
        hasHumanOrTaskMailbox: false,
      }),
    ).toBe(false);
    expect(
      shouldEnterDeepSleep({
        consecutiveIdleHeartbeats: 10,
        hasActiveTasks: false,
        hasPendingReviews: false,
        hasHumanOrTaskMailbox: true,
      }),
    ).toBe(false);
  });

  it('A-deep-sleep-wake: resetIdleOnWake clears streak', () => {
    expect(resetIdleOnWake()).toBe(0);
  });

  it('extends interval up to 24h', () => {
    expect(nextDeepSleepIntervalMs(6 * 3600_000)).toBe(12 * 3600_000);
    expect(nextDeepSleepIntervalMs(20 * 3600_000)).toBe(MAX_HEARTBEAT_INTERVAL_MS);
  });
});
