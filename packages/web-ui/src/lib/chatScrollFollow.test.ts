import { describe, expect, it } from 'vitest';
import {
  AT_BOTTOM_EPSILON,
  GESTURE_WINDOW_MS,
  SETTLE_MAX_FRAMES,
  SMOOTH_JUMP_MS,
  canFollow,
  decideScrollFollow,
  distanceFromBottom,
  gestureTakesOver,
  isAtBottom,
  isScrollable,
  keyDirection,
  maxScrollTop,
  touchDirection,
  wheelDirection,
  type ScrollFollowInput,
} from './chatScrollFollow.ts';

/** A scrollable container sitting exactly at the bottom. */
function atBottom(overrides: Partial<ScrollFollowInput> = {}): ScrollFollowInput {
  return {
    takeover: false,
    gestureActive: false,
    gestureDirection: 'none',
    scrollable: true,
    distance: 0,
    deltaScrollTop: 0,
    programmatic: false,
    ...overrides,
  };
}

describe('geometry helpers', () => {
  const el = { scrollTop: 400, scrollHeight: 1000, clientHeight: 500 };

  it('computes the scrollable range', () => {
    expect(maxScrollTop(el)).toBe(500);
    expect(distanceFromBottom(el)).toBe(100);
    expect(isScrollable(el)).toBe(true);
  });

  it('never reports a negative range (content shorter than the viewport)', () => {
    const short = { scrollTop: 0, scrollHeight: 300, clientHeight: 500 };
    expect(maxScrollTop(short)).toBe(0);
    // A partly-scrolled short container must not look "100px from the bottom".
    expect(distanceFromBottom(short)).toBe(0);
    expect(isScrollable(short)).toBe(false);
  });

  it('treats a 1px slack gap as still at the bottom', () => {
    expect(isAtBottom({ scrollTop: 499, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isAtBottom({ scrollTop: 500 - AT_BOTTOM_EPSILON - 1, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
  });
});

describe('gesture classification', () => {
  it('reads a wheel up as a takeover gesture and a wheel down as a re-arm', () => {
    expect(wheelDirection(0, -40)).toBe('up');
    expect(wheelDirection(0, 40)).toBe('down');
    expect(wheelDirection(0, 0)).toBe('none');
  });

  it('ignores horizontal-dominant wheel deltas (sideways swipe over a code block)', () => {
    expect(wheelDirection(-60, -5)).toBe('none');
    expect(wheelDirection(60, 40)).toBe('none');
  });

  it('maps the scrolling keys', () => {
    expect(keyDirection('ArrowUp')).toBe('up');
    expect(keyDirection('PageUp')).toBe('up');
    expect(keyDirection('Home')).toBe('up');
    expect(keyDirection('ArrowDown')).toBe('down');
    expect(keyDirection('End')).toBe('down');
    expect(keyDirection('a')).toBe('none');
  });

  it('maps a finger moving down the screen to scrolling content up', () => {
    expect(touchDirection(100, 140)).toBe('up');
    expect(touchDirection(140, 100)).toBe('down');
    expect(touchDirection(100, 100)).toBe('none');
    expect(touchDirection(null, 140)).toBe('none');
  });

  it('only hands over on an upward gesture while the content can scroll', () => {
    expect(gestureTakesOver('up', true)).toBe(true);
    expect(gestureTakesOver('up', false)).toBe(false);
    expect(gestureTakesOver('down', true)).toBe(false);
    expect(gestureTakesOver('none', true)).toBe(false);
  });
});

describe('canFollow', () => {
  it('follows only when the user neither took over nor is mid-gesture', () => {
    expect(canFollow({ takeover: false, gestureActive: false })).toBe(true);
    expect(canFollow({ takeover: true, gestureActive: false })).toBe(false);
    expect(canFollow({ takeover: false, gestureActive: true })).toBe(false);
    expect(canFollow({ takeover: true, gestureActive: true })).toBe(false);
  });
});

describe('decideScrollFollow — the anti-jitter contract', () => {
  it('keeps following while the user has not gestured', () => {
    expect(decideScrollFollow(atBottom())).toBe('follow');
    // Content growth pushing the viewport "below the fold" is NOT a user action.
    expect(decideScrollFollow(atBottom({ distance: 300 }))).toBe('follow');
    // Our own snap-to-bottom must not be mistaken for anything either.
    expect(decideScrollFollow(atBottom({ programmatic: true, deltaScrollTop: 120 }))).toBe('follow');
  });

  it('hands over on the first upward wheel, long before the position looks "far"', () => {
    // The regression this guards: while a reply streams, the content grows every
    // frame, so a 5px scroll-up keeps `distance` tiny for many frames. A
    // position-based rule kept re-claiming the viewport.
    expect(decideScrollFollow(atBottom({ gestureActive: true, gestureDirection: 'up', distance: 5 })))
      .toBe('handover');
  });

  it('hands over on an upward scrollTop delta when the gesture direction is unknown (scrollbar drag)', () => {
    expect(decideScrollFollow(atBottom({ gestureActive: true, deltaScrollTop: -9, programmatic: false })))
      .toBe('handover');
  });

  it('does not hand over on small or programmatic deltas', () => {
    expect(decideScrollFollow(atBottom({ gestureActive: true, deltaScrollTop: -2 }))).toBe('follow');
    expect(decideScrollFollow(atBottom({ deltaScrollTop: -200, programmatic: true }))).toBe('follow');
    expect(decideScrollFollow(atBottom({ deltaScrollTop: 40 }))).toBe('follow');
  });

  it('stays pinned while the user is away from the bottom', () => {
    expect(decideScrollFollow(atBottom({ takeover: true, distance: 400 }))).toBe('hold');
    // Even at the bottom, a leftover *upward* gesture must not re-arm follow.
    expect(decideScrollFollow(atBottom({ takeover: true, gestureDirection: 'up' }))).toBe('hold');
  });

  it('resumes once the user genuinely returns to the bottom', () => {
    expect(decideScrollFollow(atBottom({ takeover: true, gestureDirection: 'down' }))).toBe('resume');
    expect(decideScrollFollow(atBottom({ takeover: true, gestureDirection: 'none' }))).toBe('resume');
    // …but not while still a visible gap away.
    expect(decideScrollFollow(atBottom({ takeover: true, gestureDirection: 'down', distance: 40 }))).toBe('hold');
  });

  it('never pins, and re-arms, when the content is too short to scroll', () => {
    // A wheel gesture over content that cannot scroll must not silently disable
    // follow — otherwise the first long message arrives with follow dead.
    expect(decideScrollFollow(atBottom({ scrollable: false, gestureActive: true, gestureDirection: 'up' })))
      .toBe('follow');
    expect(decideScrollFollow(atBottom({ scrollable: false, takeover: true, distance: 900 }))).toBe('resume');
  });
});

describe('policy constants', () => {
  it('keeps the settle loop and the timing windows bounded', () => {
    // These are hand-tuned UX windows; the tests pin the *bounds* that keep them
    // sane, not an ordering between them (the smooth-jump guard is deliberately
    // shorter than the gesture window — a jump should hand back to instant
    // follow sooner than a gesture releases its freeze).
    expect(SETTLE_MAX_FRAMES).toBeGreaterThan(1);
    expect(SETTLE_MAX_FRAMES).toBeLessThanOrEqual(10);
    expect(GESTURE_WINDOW_MS).toBeGreaterThan(100);
    expect(GESTURE_WINDOW_MS).toBeLessThan(1000);
    expect(SMOOTH_JUMP_MS).toBeGreaterThan(0);
    expect(SMOOTH_JUMP_MS).toBeLessThan(1000);
  });
});
