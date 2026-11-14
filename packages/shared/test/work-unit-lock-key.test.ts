import { describe, it, expect } from 'vitest';
import { sessionLockKeyOfContextRef, WORK_UNIT_REF } from '../src/work-unit.js';

/**
 * C7-B — 会话锁键的**单一来源**是 WorkUnit 台账的 `context_ref`。
 *
 * 这里钉两件事，缺一条这条改动就是净风险：
 *
 *   1. **等价性**：同一个记忆会话，新路径（`context_ref`）与旧路径（
 *      `session:${peekTurnSessionId(item)}`）必须给出**同一个键**。语义漂移是这次
 *      改动唯一真正的风险，只测新路径等于没测住。
 *   2. **fallback**：`context_ref` 不是记忆会话身份时（`cs_*` 库会话 id、`task_…`、
 *      空值）必须返回 `undefined`，让调用方回退旧路径。返回一个「看起来能用」的
 *      键会让互斥静默失效 —— 那是最坏的退步（2026-10-22 事故的形态）。
 */

/** 旧路径的键构造：`session:<memorySessionId>`（`Agent.sessionLockKey` 的历史实现）。 */
function legacySessionLockKey(memorySessionId: string | undefined): string | undefined {
  return memorySessionId ? `session:${memorySessionId}` : undefined;
}

describe('sessionLockKeyOfContextRef — C7-B 会话锁键派生', () => {
  it('等价性：记忆会话身份的两个派生路径给出同一个键', () => {
    const memorySessionId = 'sess_01HXAMPLE';
    expect(sessionLockKeyOfContextRef(memorySessionId)).toBe(legacySessionLockKey(memorySessionId));
    expect(sessionLockKeyOfContextRef(memorySessionId)).toBe('session:sess_01HXAMPLE');
  });

  it('库会话 id（cs_*）不是会话锁键 —— 必须让调用方 fallback', () => {
    // chat WU 的 context_ref 历史上是 cs_*；把它当锁键会和记忆会话键落在两个命名空间，
    // 「同一份会话」看起来是两把不同的键，互斥直接失效。
    expect(sessionLockKeyOfContextRef('cs_9809eb')).toBeUndefined();
  });

  it('task / delegation / a2a 的 context_ref 都不是会话锁键', () => {
    expect(sessionLockKeyOfContextRef('task_tsk_1_r1')).toBeUndefined();
    expect(sessionLockKeyOfContextRef(WORK_UNIT_REF.delegation('task_tsk_1_r1', 'a'))).toBeUndefined();
    expect(sessionLockKeyOfContextRef('a2a:chan:msg_1')).toBeUndefined();
  });

  it('空值返回 undefined（旧行 / 非 WU 链路）', () => {
    expect(sessionLockKeyOfContextRef(null)).toBeUndefined();
    expect(sessionLockKeyOfContextRef(undefined)).toBeUndefined();
    expect(sessionLockKeyOfContextRef('')).toBeUndefined();
  });
});
