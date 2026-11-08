import { describe, it, expect, beforeEach } from 'vitest';
import { requestHistoryModal, subscribeHistoryModal, __resetHistoryModalForTest } from './historyModal.ts';

describe('historyModal bus', () => {
  beforeEach(() => __resetHistoryModalForTest());

  it('delivers a request to a consumer that is already mounted', () => {
    let opened = 0;
    subscribeHistoryModal(() => { opened += 1; });
    requestHistoryModal();
    expect(opened).toBe(1);
  });

  it('holds a request until the consumer mounts, then delivers exactly once', () => {
    requestHistoryModal(); // 概览还没挂载（导航中）
    let opened = 0;
    subscribeHistoryModal(() => { opened += 1; });
    expect(opened).toBe(1);
    // 已经消费过，重新挂载（例如切页回来）不会再弹一次
    __resetHistoryModalForTest();
    let again = 0;
    subscribeHistoryModal(() => { again += 1; });
    expect(again).toBe(0);
  });

  it('fans out to every consumer of one request', () => {
    let a = 0;
    let b = 0;
    subscribeHistoryModal(() => { a += 1; });
    subscribeHistoryModal(() => { b += 1; });
    requestHistoryModal();
    expect([a, b]).toEqual([1, 1]);
  });

  it('stops notifying after unsubscribe', () => {
    let opened = 0;
    const unsub = subscribeHistoryModal(() => { opened += 1; });
    unsub();
    requestHistoryModal();
    expect(opened).toBe(0);
  });
});
