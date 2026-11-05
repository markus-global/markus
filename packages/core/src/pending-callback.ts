/**
 * PendingCallbackRegistry — tracks async operations that should report results
 * back to the originating agent session via the Mailbox.
 *
 * Replaces the direct injectUserMessage pattern for background_exec completions,
 * ensuring results enter the attention loop properly.
 */

import { createLogger } from '@markus/shared';

const log = createLogger('pending-callback');

/** Kinds of async operation that report back through the mailbox. */
import { matchRestConditions, type WakeEvent } from './rest-wake.js';

export type CallbackType = 'background_exec' | 'wakeup' | 'a2a_reply' | 'rest';

/**
 * `rest` 的唤醒条件：**任一命中即唤醒**（OR，不是 AND）。
 *
 * 为什么是 OR：等待的语义是「有值得我回来处理的事」——任意一件发生就值得回来。
 * AND 语义会让 agent 在只满足部分条件时永远等下去，那比不挂起更糟。
 *
 * `timeout` 不是一种"轮询"，而是**有界性兑底**：没它，一个写错的 filter 能让会话
 * 永久静默，而人看不到任何信号。
 */
export type RestWakeCondition =
  | { kind: 'trigger'; threadRef?: string }
  | { kind: 'stage'; threadRef: string; stage: string }
  | { kind: 'timeout'; ms: number }
  | { kind: 'dependency'; taskId: string };

/**
 * How a resolved callback is delivered:
 * - `in_session`: re-enter the originating session (a `callback_result` mailbox item)
 *   so the agent continues where it left off — used for interactive/awaited work.
 * - `mailbox`: surface as a fresh `system_event` (a new attention cycle) — used for
 *   autonomous/background completions and scheduled wakeups.
 */
export type CallbackDelivery = 'in_session' | 'mailbox';

export interface PendingCallback {
  id: string;
  agentId: string;
  originSessionId: string;
  type: CallbackType;
  /** Delivery form on resolution. Defaults to `in_session` when omitted (legacy bg-exec). */
  deliveryMode?: CallbackDelivery;
  command?: string;
  /** Free-text reason/label (e.g. wakeup note, delegation goal). */
  note?: string;
  /** Correlates an external event to this callback (taskId / conversation_id). */
  correlationId?: string;
  /**
   * Scenario the callback was **registered from** (`AgentScenario` string).
   *
   * Replayed when the completion is delivered. Without it, every completion was
   * dispatched as `heartbeat` → **reflex pack** (see `REFLEX_CORE_TOOLS`, which has
   * no `file_write` / `file_edit` / `shell_execute` / `task_note` / `subtask_*`), and
   * the turn was told "your text output is NOT visible … end with `HEARTBEAT_OK`".
   * A background build launched from a task session therefore could not continue
   * the task on completion — it could only notify. Carrying the origin scenario
   * keeps `background_exec`'s documented contract ("continue other subtasks while
   * waiting") actually achievable.
   *
   * Kept as a loose `string` for the same decoupling reason as `type` above.
   */
  originScenario?: string;
  /** For scheduled wakeups: epoch ms at which the wakeup is due. */
  wakeAt?: number;
  /** For recurring wakeups: re-arm interval in ms after firing. */
  recurringMs?: number;
  /**
   * For `rest`: the conditions that should wake this session. `timeout` entries are
   * also folded into `wakeAt` at registration so the existing time sweep keeps working
   * without a second scheduler — one timer is enough.
   */
  restWakeOn?: RestWakeCondition[];
  /**
   * How many consecutive `rest` cycles this session has done. Used to enforce the
   * "must be bounded" rule: an agent that rests forever is just a busy-wait with
   * extra steps. Reset when the session does real work.
   */
  restStreak?: number;
  registeredAt: number;
  timeoutMs: number;
}

export interface CallbackResult {
  callbackId: string;
  originSessionId: string;
  type: CallbackType;
  deliveryMode: CallbackDelivery;
  success: boolean;
  summary: string;
  detail?: string;
}

/**
 * Storage-facing shape. Kept structurally loose (`type`/`deliveryMode` as strings)
 * so the storage package stays decoupled from core's union types; `setPersistence`
 * normalizes into `PendingCallback` on load.
 */
export interface PersistedCallback {
  id: string;
  agentId: string;
  originSessionId: string;
  type: string;
  deliveryMode?: string;
  command?: string;
  note?: string;
  correlationId?: string;
  originScenario?: string;
  wakeAt?: number;
  recurringMs?: number;
  restWakeOn?: RestWakeCondition[];
  restStreak?: number;
  registeredAt: number;
  timeoutMs: number;
}

export interface CallbackPersistence {
  save(cb: PersistedCallback): void;
  remove(id: string): void;
  loadAll(): PersistedCallback[];
}

export class PendingCallbackRegistry {
  private callbacks = new Map<string, PendingCallback>();
  private persistence?: CallbackPersistence;

  setPersistence(p: CallbackPersistence): void {
    this.persistence = p;
    for (const raw of p.loadAll()) {
      this.callbacks.set(raw.id, {
        ...raw,
        type: raw.type as CallbackType,
        deliveryMode: (raw.deliveryMode as CallbackDelivery | undefined) ?? 'in_session',
      });
    }
    if (this.callbacks.size > 0) {
      log.info('Restored pending callbacks from persistence', { count: this.callbacks.size });
    }
  }

  register(cb: PendingCallback): void {
    this.callbacks.set(cb.id, cb);
    this.persistence?.save(cb);
    log.debug('Registered pending callback', { id: cb.id, agentId: cb.agentId, type: cb.type });
  }

  resolve(id: string): PendingCallback | undefined {
    const cb = this.callbacks.get(id);
    if (cb) {
      this.callbacks.delete(id);
      this.persistence?.remove(id);
      log.debug('Resolved pending callback', { id, agentId: cb.agentId });
    }
    return cb;
  }

  getByAgentId(agentId: string): PendingCallback[] {
    return [...this.callbacks.values()].filter(cb => cb.agentId === agentId);
  }

  /** 所有类型为 rest 的等待者（跨 agent）——事件命中需要全局视角。 */
  getAllRests(): PendingCallback[] {
    return [...this.callbacks.values()].filter(cb => cb.type === 'rest');
  }

  /**
   * 取出被该事件命中的 rest 等待者（命中即 resolve，返回给调用方投递）。
   *
   * 为什么在这里而不是在调用方：匹配、取走、返回必须是一个原子动作。
   * 拆成「先查再删」会让两个并发事件同时命中同一个等待者，叫醒它两次。
   */
  takeRestMatches(event: WakeEvent): PendingCallback[] {
    const matched = matchRestConditions(this.getAllRests(), event);
    for (const m of matched) this.resolve(m.id);
    return matched;
  }

  /** Find a callback by its correlation id (conversation_id) for a specific agent. */
  findByCorrelation(agentId: string, correlationId: string): PendingCallback | undefined {
    for (const cb of this.callbacks.values()) {
      if (cb.agentId === agentId && cb.correlationId === correlationId) return cb;
    }
    return undefined;
  }

  /** Scheduled wakeups whose `wakeAt` is due (<= now). */
  getDueWakeups(now = Date.now()): PendingCallback[] {
    return [...this.callbacks.values()].filter(
      cb => cb.wakeAt !== undefined && cb.wakeAt <= now,
    );
  }

  /** Returns callbacks that have exceeded their timeout. */
  getTimedOut(now = Date.now()): PendingCallback[] {
    const timedOut: PendingCallback[] = [];
    for (const cb of this.callbacks.values()) {
      if (now - cb.registeredAt > cb.timeoutMs) {
        timedOut.push(cb);
      }
    }
    return timedOut;
  }

  /** Remove and return a timed-out callback for processing. */
  expireTimedOut(id: string): PendingCallback | undefined {
    const cb = this.callbacks.get(id);
    if (cb) {
      this.callbacks.delete(id);
      this.persistence?.remove(id);
      log.info('Expired timed-out callback', { id, agentId: cb.agentId, type: cb.type });
    }
    return cb;
  }

  get size(): number {
    return this.callbacks.size;
  }
}

/** Singleton registry shared across the process. */
export const pendingCallbackRegistry = new PendingCallbackRegistry();
