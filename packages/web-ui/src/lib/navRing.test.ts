import { describe, it, expect } from 'vitest';
import { NAV_RING, ringIndex, ringStep, ringDelta, scrollConsumesHorizontal, registerRingSubSource, currentRingSub, RING_SWIPE_THRESHOLD_PX } from './navRing.ts';
import { PAGE } from '../routes.ts';

describe('navRing: shape', () => {
  it('is a closed ring in the order the owner specified', () => {
    expect(NAV_RING.map(s => s.page)).toEqual([
      PAGE.HOME,
      PAGE.TEAM,
      PAGE.NOTIFICATIONS,
      PAGE.NOTIFICATIONS,
      PAGE.WORK,
      PAGE.WORK,
      PAGE.WORK,
      PAGE.WORK,
      PAGE.DELIVERABLES,
    ]);
    expect(NAV_RING.map(s => s.sub)).toEqual([
      undefined,
      'l1',
      'approvals',
      'notifications',
      'backlog',
      'kanban',
      'dag',
      'workflows',
      undefined,
    ]);
  });

  it('every step id is unique', () => {
    expect(new Set(NAV_RING.map(s => s.id)).size).toBe(NAV_RING.length);
  });
});

describe('navRing: where am I', () => {
  it('resolves a page that owns exactly one step', () => {
    expect(ringIndex(PAGE.HOME)).toBe(0);
    expect(ringIndex(PAGE.DELIVERABLES)).toBe(8);
  });

  it('resolves a page with several steps by its published sub-view', () => {
    expect(ringIndex(PAGE.WORK, 'backlog')).toBe(4);
    expect(ringIndex(PAGE.WORK, 'kanban')).toBe(5);
    expect(ringIndex(PAGE.WORK, 'dag')).toBe(6);
    expect(ringIndex(PAGE.WORK, 'workflows')).toBe(7);
    expect(ringIndex(PAGE.NOTIFICATIONS, 'approvals')).toBe(2);
    expect(ringIndex(PAGE.NOTIFICATIONS, 'notifications')).toBe(3);
  });

  it('falls back to the first step of the page when the sub-view is unknown', () => {
    expect(ringIndex(PAGE.WORK)).toBe(4);
    expect(ringIndex(PAGE.WORK, 'l1')).toBe(4);
  });

  it('reports -1 for pages that are not on the ring', () => {
    expect(ringIndex(PAGE.SETTINGS)).toBe(-1);
    expect(ringIndex(PAGE.SEARCH)).toBe(-1);
    expect(ringIndex(PAGE.STORE)).toBe(-1);
  });
});

describe('navRing: stepping', () => {
  it('walks the owner’s route forward', () => {
    expect(ringStep(PAGE.HOME, undefined, 1)?.page).toBe(PAGE.TEAM);
    expect(ringStep(PAGE.TEAM, 'l1', 1)?.sub).toBe('approvals');
    expect(ringStep(PAGE.NOTIFICATIONS, 'approvals', 1)?.sub).toBe('notifications');
    expect(ringStep(PAGE.NOTIFICATIONS, 'notifications', 1)?.sub).toBe('backlog');
    expect(ringStep(PAGE.WORK, 'backlog', 1)?.sub).toBe('kanban');
    expect(ringStep(PAGE.WORK, 'kanban', 1)?.sub).toBe('dag');
    expect(ringStep(PAGE.WORK, 'dag', 1)?.sub).toBe('workflows');
    expect(ringStep(PAGE.WORK, 'workflows', 1)?.page).toBe(PAGE.DELIVERABLES);
  });

  it('wraps: deliverables forward returns to the overview', () => {
    expect(ringStep(PAGE.DELIVERABLES, undefined, 1)?.page).toBe(PAGE.HOME);
  });

  it('wraps: the overview steps back to deliverables', () => {
    expect(ringStep(PAGE.HOME, undefined, -1)?.page).toBe(PAGE.DELIVERABLES);
  });

  it('steps back along the same route', () => {
    expect(ringStep(PAGE.TEAM, 'l1', -1)?.page).toBe(PAGE.HOME);
    expect(ringStep(PAGE.WORK, 'workflows', -1)?.sub).toBe('dag');
    expect(ringStep(PAGE.DELIVERABLES, undefined, -1)?.sub).toBe('workflows');
  });

  it('does nothing on pages outside the ring', () => {
    expect(ringStep(PAGE.SETTINGS, undefined, 1)).toBeNull();
    expect(ringStep(PAGE.SETTINGS, undefined, -1)).toBeNull();
  });
});

describe('navRing: gesture → direction', () => {
  it('finger travelling right→left advances, left→right steps back', () => {
    // Owner's definition: 向左滑 = press on the right edge, drag toward the left.
    expect(ringDelta(-80, 4)).toBe(1);
    expect(ringDelta(80, 4)).toBe(-1);
  });

  it('ignores gestures shorter than the threshold', () => {
    expect(ringDelta(RING_SWIPE_THRESHOLD_PX - 1, 0)).toBe(0);
    expect(ringDelta(-(RING_SWIPE_THRESHOLD_PX - 1), 0)).toBe(0);
  });

  it('ignores gestures that are mostly vertical', () => {
    expect(ringDelta(80, 200)).toBe(0);
    expect(ringDelta(-80, -200)).toBe(0);
  });
});

describe('navRing: live sub-view source', () => {
  it('reads the page’s current sub-view at call time, never a cached copy', () => {
    let tab: 'approvals' | 'notifications' = 'approvals';
    const unregister = registerRingSubSource(PAGE.NOTIFICATIONS, () => tab);
    expect(currentRingSub(PAGE.NOTIFICATIONS)).toBe('approvals');
    // the page changes its own state directly — the ring must see it immediately
    tab = 'notifications';
    expect(currentRingSub(PAGE.NOTIFICATIONS)).toBe('notifications');
    unregister();
    expect(currentRingSub(PAGE.NOTIFICATIONS)).toBeUndefined();
  });
});

describe('navRing: horizontal scrollers keep their gesture', () => {
  it('a container that can still scroll forward consumes the swipe', () => {
    // 0..1000 wide in a 300 viewport, sitting mid-way → can scroll further
    expect(scrollConsumesHorizontal(400, 300, 1000, true)).toBe(true);
  });

  it('at the forward edge the ring takes over', () => {
    expect(scrollConsumesHorizontal(700, 300, 1000, true)).toBe(false);
  });

  it('at the back edge the ring takes over', () => {
    expect(scrollConsumesHorizontal(0, 300, 1000, false)).toBe(false);
  });

  it('a container with nothing to scroll never consumes the swipe', () => {
    expect(scrollConsumesHorizontal(0, 300, 300, true)).toBe(false);
    expect(scrollConsumesHorizontal(0, 300, 300, false)).toBe(false);
  });
});
