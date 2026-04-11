import {
  createLogger,
  generateId,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPayload,
  type MailboxItemMetadata,
  type MailboxItemStatus,
  type MailboxPriority,
  MAILBOX_TYPE_REGISTRY,
} from '@markus/shared';
import type { EventBus } from './events.js';

const log = createLogger('mailbox');

/** Derived from the centralised MAILBOX_TYPE_REGISTRY in @markus/shared. */
const DEFAULT_PRIORITY: Record<MailboxItemType, MailboxPriority> = Object.fromEntries(
  Object.entries(MAILBOX_TYPE_REGISTRY).map(([k, v]) => [k, v.defaultPriority]),
) as Record<MailboxItemType, MailboxPriority>;

export interface EnqueueOptions {
  priority?: MailboxPriority;
  metadata?: MailboxItemMetadata;
}

export interface MailboxPersistence {
  save(item: MailboxItem): void;
  updateStatus(itemId: string, status: MailboxItemStatus, extra?: Partial<MailboxItem>): void;
}

/**
 * Priority queue mailbox for an individual agent.
 * Items are ordered by priority (lower number = higher priority), then by arrival time (FIFO).
 * Emits 'mailbox:new-item' on the EventBus whenever a new item is enqueued,
 * which the AttentionController listens to for event-driven interrupts.
 */
export class AgentMailbox {
  private queue: MailboxItem[] = [];
  private readonly agentId: string;
  private readonly eventBus: EventBus;
  private persistence?: MailboxPersistence;
  private idleResolve?: () => void;

  constructor(agentId: string, eventBus: EventBus, persistence?: MailboxPersistence) {
    this.agentId = agentId;
    this.eventBus = eventBus;
    this.persistence = persistence;
  }

  setPersistence(p: MailboxPersistence): void {
    this.persistence = p;
  }

  /**
   * Add an item to the mailbox. Returns the item ID.
   * Emits 'mailbox:new-item' so the AttentionController can react.
   */
  enqueue(
    sourceType: MailboxItemType,
    payload: MailboxPayload,
    options?: EnqueueOptions,
  ): MailboxItem {
    const item: MailboxItem = {
      id: generateId('mbx'),
      agentId: this.agentId,
      sourceType,
      priority: options?.priority ?? DEFAULT_PRIORITY[sourceType],
      status: 'queued',
      payload,
      metadata: options?.metadata,
      queuedAt: new Date().toISOString(),
    };

    this.insertSorted(item);
    this.persistence?.save(item);

    log.debug('Mailbox enqueue', {
      agentId: this.agentId,
      itemId: item.id,
      type: sourceType,
      priority: item.priority,
      summary: payload.summary.slice(0, 80),
      depth: this.queue.length,
    });

    this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item });

    if (this.idleResolve) {
      const resolve = this.idleResolve;
      this.idleResolve = undefined;
      resolve();
    }

    return item;
  }

  /**
   * Remove and return the highest-priority item.
   * Returns undefined if the queue is empty.
   */
  dequeue(): MailboxItem | undefined {
    const item = this.queue.shift();
    if (item) {
      item.status = 'processing';
      item.startedAt = new Date().toISOString();
      this.persistence?.updateStatus(item.id, 'processing', { startedAt: item.startedAt });
    }
    return item;
  }

  /**
   * Block until an item is available, then dequeue it.
   */
  async dequeueAsync(): Promise<MailboxItem> {
    const item = this.dequeue();
    if (item) return item;

    await new Promise<void>(resolve => {
      this.idleResolve = resolve;
    });

    return this.dequeue()!;
  }

  /**
   * Peek at the highest-priority item without removing it.
   */
  peek(): MailboxItem | undefined {
    return this.queue[0];
  }

  /**
   * Check if there are any pending items with priority <= threshold.
   */
  hasItemAbovePriority(threshold: MailboxPriority): boolean {
    return this.queue.length > 0 && this.queue[0].priority <= threshold;
  }

  /**
   * Get all items currently in the queue (snapshot, not live reference).
   */
  getQueuedItems(): MailboxItem[] {
    return [...this.queue];
  }

  /**
   * Mark an item as completed.
   */
  complete(itemId: string): void {
    const now = new Date().toISOString();
    this.persistence?.updateStatus(itemId, 'completed', { completedAt: now });
  }

  /**
   * Mark an item as deferred with a reason. The item is removed from the active queue.
   */
  defer(itemId: string, until?: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;

    const [item] = this.queue.splice(idx, 1);
    item.status = 'deferred';
    item.deferredUntil = until;
    this.persistence?.updateStatus(item.id, 'deferred', { deferredUntil: until });
    return item;
  }

  /**
   * Mark an item as merged into another item.
   */
  merge(itemId: string, intoItemId: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;

    const [item] = this.queue.splice(idx, 1);
    item.status = 'merged';
    item.mergedInto = intoItemId;
    this.persistence?.updateStatus(item.id, 'merged', { mergedInto: intoItemId });
    return item;
  }

  /**
   * Drop an item from the queue.
   */
  drop(itemId: string): MailboxItem | undefined {
    const idx = this.queue.findIndex(i => i.id === itemId);
    if (idx === -1) return undefined;

    const [item] = this.queue.splice(idx, 1);
    item.status = 'dropped';
    this.persistence?.updateStatus(item.id, 'dropped');
    return item;
  }

  /**
   * Re-enqueue a deferred item back into the active queue.
   */
  resurface(item: MailboxItem): void {
    item.status = 'queued';
    item.deferredUntil = undefined;
    this.insertSorted(item);
    this.persistence?.updateStatus(item.id, 'queued');
    this.eventBus.emit('mailbox:new-item', { agentId: this.agentId, item });

    if (this.idleResolve) {
      const resolve = this.idleResolve;
      this.idleResolve = undefined;
      resolve();
    }
  }

  get depth(): number {
    return this.queue.length;
  }

  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Check for items with the same taskId already in the queue (for dedup).
   */
  findByTaskId(taskId: string): MailboxItem | undefined {
    return this.queue.find(
      i => i.payload.taskId === taskId || i.metadata?.taskId === taskId,
    );
  }

  /**
   * Cancel the idle wait (used during shutdown).
   */
  cancelWait(): void {
    if (this.idleResolve) {
      this.idleResolve();
      this.idleResolve = undefined;
    }
  }

  /**
   * Insert item into the queue maintaining priority + FIFO order.
   */
  private insertSorted(item: MailboxItem): void {
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > item.priority) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, item);
  }
}
