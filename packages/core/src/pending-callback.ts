/**
 * PendingCallbackRegistry — tracks async operations that should report results
 * back to the originating agent session via the Mailbox.
 *
 * Replaces the direct injectUserMessage pattern for background_exec completions,
 * ensuring results enter the attention loop properly.
 */

import { createLogger } from '@markus/shared';

const log = createLogger('pending-callback');

export interface PendingCallback {
  id: string;
  agentId: string;
  originSessionId: string;
  type: 'background_exec';
  command?: string;
  registeredAt: number;
  timeoutMs: number;
}

export interface CallbackResult {
  callbackId: string;
  originSessionId: string;
  type: 'background_exec';
  success: boolean;
  summary: string;
  detail?: string;
}

export interface CallbackPersistence {
  save(cb: PendingCallback): void;
  remove(id: string): void;
  loadAll(): PendingCallback[];
}

export class PendingCallbackRegistry {
  private callbacks = new Map<string, PendingCallback>();
  private persistence?: CallbackPersistence;

  setPersistence(p: CallbackPersistence): void {
    this.persistence = p;
    for (const cb of p.loadAll()) {
      this.callbacks.set(cb.id, cb);
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
