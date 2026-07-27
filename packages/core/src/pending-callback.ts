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
export type CallbackType = 'background_exec' | 'wakeup' | 'a2a_reply';

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
  /** For scheduled wakeups: epoch ms at which the wakeup is due. */
  wakeAt?: number;
  /** For recurring wakeups: re-arm interval in ms after firing. */
  recurringMs?: number;
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
  wakeAt?: number;
  recurringMs?: number;
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
