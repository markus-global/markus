import {
  createLogger,
  generateId,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPriority,
  type AttentionState,
  type AttentionDecision,
  type DecisionType,
  type DecisionContext,
  type AgentMindState,
  type TriageContext,
  type TriageResult,
  type DeliberationResult,
  MailboxPriorityLevel,
  MAILBOX_TYPE_REGISTRY,
  MAILBOX_ITEM_MAX_RETRIES,
  COMPLETION_MARKER,
  PRIORITY_LABELS,
  TRIAGE_PROMPT_MAX_ITEMS,
  MAILBOX_PROCESSING_TIMEOUT_MS,
  MAILBOX_COALESCE_WINDOW_MS,
  APPROVAL_WAIT_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_DRIFT_THRESHOLD_MS,
  TRIAGE_ITEM_CONTENT_CHARS,
  TRIAGE_MAX_TOOL_ITERATIONS,
  TRIAGE_ALLOWED_TOOLS,
  TRIAGE_BACKLOG_THRESHOLD,
} from '@markus/shared';
import type { EventBus } from './events.js';
import type { AgentMailbox } from './mailbox.js';

// ─── Abnormal Completion Detection ──────────────────────────────────────────

/**
 * Check whether a mailbox-item reply was completed normally.
 *
 * For LLM-invoking items the agent is instructed to end its reply with
 * `COMPLETION_MARKER`.  If the marker is absent the model either crashed
 * or output garbage (e.g. raw XML tool calls) — we should retry.
 *
 * However, intentional interruptions (preemption, user cancellation) are
 * NOT abnormal and must never be retried:
 *  - Preempted items return '[preempted]' — the scheduler will re-trigger
 *    background scenarios naturally.
 *  - User-facing chats (human_chat, a2a_message) already streamed a
 *    (partial) response to the caller; re-processing the same input would
 *    produce a *different* reply, which is confusing.
 *
 * Returns a reason string when abnormal, `undefined` when the reply is OK.
 */
export function detectAbnormalCompletion(
  reply: string | void,
  item: MailboxItem,
): string | undefined {
  const registry = MAILBOX_TYPE_REGISTRY[item.sourceType];
  if (!registry?.invokesLLM) return undefined;

  // Intentional preemption (pause) or cancellation by the attention controller
  // — a higher-priority item arrived and this one was interrupted on purpose.
  if (reply === '[preempted]' || reply === '[cancelled]') return undefined;

  if (reply === undefined || reply === '') {
    return 'empty reply from LLM-invoking item';
  }

  if (!reply.includes(COMPLETION_MARKER)) {
    return 'completion marker missing from reply';
  }

  return undefined;
}

const log = createLogger('attention');

/**
 * Callback interface for the AttentionController to delegate actual work
 * back to the Agent. The Agent implements this to process mailbox items
 * using its existing handleMessage / executeTask / handleHeartbeat paths.
 */
export interface AttentionDelegate {
  processMailboxItem(item: MailboxItem, batchItems?: MailboxItem[], batchContext?: string): Promise<string | void>;
  onDecisionMade(decision: AttentionDecision): void;
  onFocusChanged(item: MailboxItem | undefined): void;
  evaluateInterrupt(
    currentItem: MailboxItem,
    newItem: MailboxItem,
  ): Promise<DecisionType>;
  getTriageContext?(): Promise<TriageContext>;
  onTriageCompleted?(result: TriageResult | null): void;
  /** Full-session deliberation: the agent reasons over all queued items as itself. */
  performDeliberation?(headItem: MailboxItem, allItems: MailboxItem[]): Promise<DeliberationResult | null>;
  onDeliberationCompleted?(result: DeliberationResult | null): void;
  /** Apply memory updates from deliberation (working + longterm). */
  applyMemoryUpdates?(updates: Array<{ type: 'working' | 'longterm'; key: string; content: string }>): void;
}

export interface DecisionPersistence {
  save(decision: AttentionDecision): void;
}

/**
 * Lightweight LLM judge for ambiguous attention decisions.
 * Receives a structured prompt and returns a DecisionType string.
 */
export type LLMDecisionJudge = (prompt: string) => Promise<DecisionType>;

/**
 * LLM judge for triage decisions — holistic assessment of all queued items.
 * Returns a raw JSON string that the caller parses into a TriageResult.
 * Separate from LLMDecisionJudge because triage is N-item → structured JSON,
 * while interrupt decisions are 2-item → single word.
 */
export type TriageJudge = (prompt: string) => Promise<string>;

/**
 * Extended triage function that supports tool use during deliberation.
 * When set, performTriage uses a mini tool loop for read-only context gathering.
 */
export type TriageChatFn = (messages: Array<{ role: string; content: string; toolCalls?: any[]; toolCallId?: string; reasoningContent?: string }>, tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) => Promise<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; reasoningContent?: string }>;

/**
 * Event-driven attention controller for a single agent.
 *
 * The controller manages the agent's cognitive focus:
 * - When idle and a new mail arrives → immediately dequeue and process
 * - When focused and a new mail arrives → register an interrupt signal
 *   that is serviced at the next safe yield point in the tool loop
 * - The agent (via the delegate) decides whether to continue, preempt,
 *   merge, defer, or delegate
 *
 * There is NO polling. The agent's focus is broken only when an external
 * event (new mail) demands attention.
 */
export class AttentionController {
  private state: AttentionState = 'idle';
  private currentFocus: MailboxItem | undefined;
  private interruptSignal = false;
  private pendingInterruptItem: MailboxItem | undefined;
  private criticalInterruptResolve?: () => void;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private readonly agentId: string;
  private readonly mailbox: AgentMailbox;
  private readonly eventBus: EventBus;
  private delegate?: AttentionDelegate;
  private decisionPersistence?: DecisionPersistence;
  private llmJudge?: LLMDecisionJudge;
  private triageJudge?: TriageJudge;
  private triageToolHandlers?: Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> }>;
  private triageChatFn?: TriageChatFn;
  private lastTriageResult?: TriageResult & { timestamp: string };
  /** True while a full-session deliberation is in progress (suppresses yield points). */
  private isDeliberating = false;
  /** Set to true when a human_chat arrives during deliberation, causing early abort. */
  private deliberationAbortSignal = false;
  /** Tracks whether the last yield-point decision was 'cancel' vs 'preempt'. */
  private lastYieldDecision?: DecisionType;
  private unsubscribeNewItem?: () => void;
  private decisions: AttentionDecision[] = [];
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private watchdogLastTick = Date.now();
  private processingStartedAt?: number;
  private waitingForHumanApproval = false;

  private static readonly MAX_RECENT_DECISIONS = 50;

  /** True while the runLoop's while-body is executing; false after the loop exits. */
  private loopAlive = false;

  constructor(
    agentId: string,
    mailbox: AgentMailbox,
    eventBus: EventBus,
  ) {
    this.agentId = agentId;
    this.mailbox = mailbox;
    this.eventBus = eventBus;
  }

  setDelegate(delegate: AttentionDelegate): void {
    this.delegate = delegate;
  }

  setDecisionPersistence(p: DecisionPersistence): void {
    this.decisionPersistence = p;
  }

  setWaitingForApproval(waiting: boolean): void {
    this.waitingForHumanApproval = waiting;
  }

  /**
   * Start the attention loop. Listens for mailbox events and processes items.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.unsubscribeNewItem = this.eventBus.on(
      'mailbox:new-item',
      (payload: unknown) => {
        const { agentId } = payload as { agentId: string; item: MailboxItem };
        if (agentId !== this.agentId) return;
        this.onNewMail();
      },
    );

    this.startWatchdog();
    this.launchLoop();
    log.info('Attention controller started', { agentId: this.agentId });
  }

  /**
   * Launch (or re-launch) the runLoop with auto-restart on unexpected exit.
   * If the loop exits while `this.running` is true, it restarts after a
   * brief delay — defense-in-depth against exceptions that escape the
   * outer try-catch inside the loop body.
   */
  private launchLoop(): void {
    this.loopPromise = this.runLoop().catch(err => {
      if (this.running) {
        log.error('Attention loop exited unexpectedly — restarting in 2 s', {
          agentId: this.agentId,
          error: String(err),
          stack: (err as Error)?.stack,
        });
        setTimeout(() => {
          if (this.running) this.launchLoop();
        }, 2000);
      }
    });
  }

  /**
   * Stop the attention loop.
   */
  stop(): void {
    this.running = false;
    this.unsubscribeNewItem?.();
    this.unsubscribeNewItem = undefined;
    this.stopWatchdog();
    this.mailbox.cancelWait();
    log.info('Attention controller stopped', { agentId: this.agentId });
  }

  // ─── Sleep Watchdog ──────────────────────────────────────────────────────

  private startWatchdog(): void {
    this.watchdogLastTick = Date.now();
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.watchdogLastTick;
      this.watchdogLastTick = now;

      if (elapsed > WATCHDOG_INTERVAL_MS + WATCHDOG_DRIFT_THRESHOLD_MS) {
        const focusedId = this.currentFocus?.id;
        const processingFor = this.processingStartedAt
          ? Math.round((now - this.processingStartedAt) / 1000)
          : 0;
        log.warn('System sleep/wake detected', {
          agentId: this.agentId,
          driftMs: elapsed,
          state: this.state,
          focusedItemId: focusedId,
          processingForSec: processingFor,
        });
      }

      // Self-heal: if the loop died while we're still supposed to be running,
      // restart it.  The outer try-catch + launchLoop auto-restart should
      // prevent this, but this is a last-resort safety net.
      if (this.running && !this.loopAlive) {
        log.error('Watchdog: attention loop is dead — restarting', {
          agentId: this.agentId,
          state: this.state,
          queueDepth: this.mailbox.depth,
        });
        this.launchLoop();
      }

      // Self-heal: if nothing is being processed in memory but the DB has
      // items stuck in 'processing' status, mark them as completed.
      // This catches edge cases where complete()/requeue()/defer() failed
      // silently or the process was interrupted between activity end and
      // status update.  Also triggers during 'deciding' (triage/deliberation)
      // because no item is actively being processed at that point either.
      if (this.running && !this.currentFocus && (this.state === 'idle' || this.state === 'deciding')) {
        try {
          const cleaned = this.mailbox.cleanStaleProcessing();
          if (cleaned > 0) {
            log.warn('Watchdog: cleaned stale processing items from DB', {
              agentId: this.agentId,
              cleaned,
            });
          }
        } catch { /* best-effort */ }
      }
    }, WATCHDOG_INTERVAL_MS);

    if (this.watchdogTimer && typeof this.watchdogTimer === 'object' && 'unref' in this.watchdogTimer) {
      this.watchdogTimer.unref();
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Main attention loop. Blocks on mailbox when idle, processes one item
   * at a time, then returns to idle.
   *
   * Triage phase: after dequeuing the head item, if additional items remain
   * in the queue AND a TriageJudge is configured, perform LLM-driven
   * deliberation to decide which item to process first.
   */
  private async runLoop(): Promise<void> {
    this.loopAlive = true;
    try {
      while (this.running) {
        try {
          this.setState('idle');
          this.currentFocus = undefined;
          this.delegate?.onFocusChanged(undefined);

          // Resurface deferred items that are due before waiting for new work
          try { this.mailbox.resurfaceDue(); } catch { /* best-effort */ }

          let item: MailboxItem;
          try {
            item = await this.mailbox.dequeueAsync();
          } catch {
            // MailboxCancelledError (or any error) while not running → clean exit
            if (!this.running) break;
            continue;
          }

          if (!this.running) {
            // Re-enqueue so items are not lost on shutdown.
            // human_chat is NOT re-enqueued: its SSE stream is stale after
            // restart and replaying would duplicate the response. The user
            // can resend.
            // Direct a2a_message with a live responsePromise is also dropped
            // (the promise is stale after restart). Group chat a2a_messages
            // (no responsePromise) ARE re-enqueued to avoid silent message loss.
            const hasLiveCallback = item.sourceType === 'a2a_message' && !!item.metadata?.responsePromise;
            if (item.sourceType !== 'human_chat' && !hasLiveCallback) {
              try {
                this.mailbox.enqueue(item.sourceType, item.payload, {
                  priority: item.priority,
                  metadata: item.metadata,
                });
              } catch (err) {
                log.warn('Failed to re-enqueue item on shutdown', { itemId: item.id, error: String(err) });
              }
            }
            break;
          }

          // Everything from triage through processing is wrapped in try-catch
          // so a single failure never kills the loop permanently.  On crash the
          // dequeued item is requeued and processing continues with the next item.
          try {
            // Mark as deciding so onNewMail sets interrupt signals for urgent items
            // (state was 'idle' during dequeueAsync; without this, human_chat arriving
            // during pre-triage or deliberation would be silently ignored).
            this.setState('deciding');

            // Fast-path: user messages (human_chat) are always highest priority —
            // skip pre-triage cleanup and deliberation to process them immediately.
            const isUserMessage = AttentionController.USER_INTERACTION_TYPES.has(item.sourceType);

            // Coalescing window: for non-user items with pending queue items,
            // pause briefly to let burst messages (rapid-fire group chat) arrive
            // and merge via enqueue-time dedup. Skip when queue is empty (no burst).
            if (!isUserMessage && MAILBOX_COALESCE_WINDOW_MS > 0 && this.mailbox.depth > 0) {
              await new Promise(r => setTimeout(r, MAILBOX_COALESCE_WINDOW_MS));
            }

            // Pre-triage cleanup: drop stale informational items, then consolidate
            // items sharing the same task/requirement into single rich-context items.
            if (this.mailbox.depth > 0 && !isUserMessage) {
              this.mailbox.putBack(item);

              // 1. Purge stale informational items (old heartbeats, status updates, etc.)
              const purged = this.mailbox.purgeStaleItems();
              if (purged > 0) {
                log.info('Pre-triage stale purge', { agentId: this.agentId, purged });
              }

              // 2. Consolidate items by entity (task/requirement)
              const consolidated = this.mailbox.consolidateByEntity();
              const reHead = this.mailbox.dequeue();
              if (reHead) {
                item = reHead;
              }
              if (consolidated > 0) {
                log.info('Pre-triage consolidation reduced queue', {
                  agentId: this.agentId,
                  merged: consolidated,
                  remainingDepth: this.mailbox.depth,
                });
              }
            }

            // Triage: LLM deliberation is only needed when:
            // 1. Multiple distinct items remain after consolidation
            // 2. Priority alone can't decide — the head item shares its priority
            //    with at least one other queued item (ambiguous ordering)
            // 3. A TriageJudge OR delegate.performDeliberation is configured
            // When priorities clearly separate items, the priority queue already
            // produces the right order — no LLM call needed.
            let triaged = false;
            let deliberationAttempted = false;
            if (this.mailbox.depth > 0 && !isUserMessage && this.needsLLMTriage(item) && (this.delegate?.performDeliberation || this.triageJudge)) {
              // Prefer full-session deliberation over mini triage loop
              if (this.delegate?.performDeliberation) {
                deliberationAttempted = true;
                const allItems = [item, ...this.mailbox.getQueuedItems()];
                this.isDeliberating = true;
                this.deliberationAbortSignal = false;
                try {
                  const deliberationResult = await this.delegate.performDeliberation(item, allItems);
                  if (this.deliberationAbortSignal) {
                    // A human_chat arrived during deliberation — discard result,
                    // put item back so the user message gets processed first.
                    log.info('Deliberation aborted: human_chat arrived', { agentId: this.agentId });
                    this.mailbox.putBack(item);
                    const userItem = this.mailbox.dequeue();
                    if (userItem) {
                      item = userItem;
                    }
                  } else if (deliberationResult) {
                    triaged = true;
                    item = this.applyDeliberationResult(item, deliberationResult);
                  }
                } finally {
                  this.isDeliberating = false;
                  this.deliberationAbortSignal = false;
                }
              } else {
                deliberationAttempted = true;
                const triageResult = await this.performTriage(item);
                if (triageResult) {
                  triaged = true;
                  item = this.applyTriageResult(item, triageResult);
                }
              }
            }

            if (!triaged) {
              if (deliberationAttempted) {
                log.warn('Deliberation failed — falling back to head-item processing', {
                  agentId: this.agentId,
                  itemId: item.id,
                  type: item.sourceType,
                  queueDepth: this.mailbox.depth,
                });
              }
              const decision = this.recordDecision('pick', item, `Idle, processing ${item.sourceType}`);
              this.delegate?.onDecisionMade(decision);
            }

            await this.processFocusedItem(item);
          } catch (err) {
            log.error('Attention loop iteration failed — requeueing item and continuing', {
              agentId: this.agentId,
              itemId: item.id,
              type: item.sourceType,
              error: String(err),
            });
            this.isDeliberating = false;
            this.currentFocus = undefined;
            this.interruptSignal = false;
            this.pendingInterruptItem = undefined;
            this.lastYieldDecision = undefined;
            try { this.mailbox.requeue(item); } catch { /* item may already be back in queue */ }
          }
        } catch (outerErr) {
          // Outermost safety net: catches exceptions from setState('idle'),
          // onFocusChanged(undefined), or any other path not covered by the
          // inner try-catch blocks.  Without this, a single throw from an
          // eventBus listener or delegate callback kills the loop permanently.
          log.error('Attention loop: unhandled error at iteration boundary — recovering', {
            agentId: this.agentId,
            error: String(outerErr),
            stack: (outerErr as Error)?.stack,
          });
          this.isDeliberating = false;
          this.currentFocus = undefined;
          this.interruptSignal = false;
          this.pendingInterruptItem = undefined;
          this.lastYieldDecision = undefined;
          // Brief delay to prevent tight error loops on persistent failures
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } finally {
      this.loopAlive = false;
    }
  }

  /**
   * Process a single mailbox item with full focus.
   * After processing, validates the result; if the LLM produced an abnormal
   * reply (e.g. raw XML tool-call markup), the item is requeued for retry
   * up to `MAILBOX_ITEM_MAX_RETRIES` times.
   */
  private async processFocusedItem(item: MailboxItem): Promise<void> {
    this.setState('focused');
    this.currentFocus = item;
    this.interruptSignal = false;
    this.pendingInterruptItem = undefined;
    this.criticalInterruptResolve = undefined;
    this.lastYieldDecision = undefined;
    this.processingStartedAt = Date.now();
    this.delegate?.onFocusChanged(item);

    // Capture and reset batch state set by applyDeliberationResult
    const batchItems = this.pendingBatchItems.length > 0 ? [...this.pendingBatchItems] : undefined;
    const batchContext = this.pendingBatchContext;
    this.pendingBatchItems = [];
    this.pendingBatchContext = undefined;

    let reply: string | void = undefined;
    let timedOut = false;
    try {
      // The delegate's processMailboxItem makes LLM calls and shell commands,
      // each of which has its own transport-level timeout. This outer timeout
      // is a generous backstop — by the time it fires, all underlying I/O has
      // surely completed or failed, so requeuing is safe.
      const processing = this.delegate?.processMailboxItem(item, batchItems, batchContext);
      const backstopMs = this.waitingForHumanApproval ? APPROVAL_WAIT_TIMEOUT_MS : MAILBOX_PROCESSING_TIMEOUT_MS;
      const backstop = new Promise<undefined>(resolve =>
        setTimeout(() => resolve(undefined), backstopMs),
      );
      const result = await Promise.race([
        processing?.then(r => ({ done: true as const, reply: r })),
        backstop.then(() => ({ done: false as const, reply: undefined })),
      ]);
      if (result?.done) {
        reply = result.reply;
      } else {
        timedOut = true;
        log.error('Processing exceeded backstop timeout — requeueing', {
          agentId: this.agentId,
          itemId: item.id,
          type: item.sourceType,
          timeoutMs: backstopMs,
        });
      }
    } catch (err) {
      log.warn('Error processing mailbox item', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
        error: String(err),
      });
    }

    this.processingStartedAt = undefined;

    let statusResolved = false;
    if (timedOut) {
      this.mailbox.requeue(item);
      statusResolved = true;
    } else if (reply === '[cancelled]' || this.lastYieldDecision === 'cancel') {
      // Permanently cancelled by an explicit cancel decision — the new incoming
      // message contradicts or revokes this work.  Drop the item; it will NOT
      // be resumed.
      log.info('Item cancelled — dropping permanently', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
      });
      this.mailbox.complete(item.id);
      statusResolved = true;
    } else if (reply === '[preempted]' || this.lastYieldDecision === 'preempt') {
      // Paused by a higher-priority item — defer so it can be resumed later.
      // The session context is preserved by sessionId in the payload, so when
      // the item resurfaces the agent continues where it left off.
      log.info('Item preempted (paused) — deferring for later resumption', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
      });
      this.mailbox.deferDequeued(item);
      statusResolved = true;
    } else if (!this.running) {
      // Agent was stopped/paused during processing — requeue so the item
      // is not lost and will be picked up when the agent resumes.
      log.info('Agent stopped during processing — requeueing item', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
      });
      this.mailbox.requeue(item);
      statusResolved = true;
    } else {
      const abnormalReason = detectAbnormalCompletion(reply, item);
      const retries = item.retryCount ?? 0;

      if (abnormalReason && retries < MAILBOX_ITEM_MAX_RETRIES) {
        log.warn('Abnormal completion detected, requeueing for retry', {
          agentId: this.agentId,
          itemId: item.id,
          type: item.sourceType,
          retryCount: retries + 1,
          reason: abnormalReason,
        });
        this.mailbox.requeue(item);
      } else {
        if (abnormalReason) {
          log.error('Abnormal completion persisted after max retries, completing anyway', {
            agentId: this.agentId,
            itemId: item.id,
            type: item.sourceType,
            retryCount: retries,
            reason: abnormalReason,
          });
        }
        this.mailbox.complete(item.id);
      }
      statusResolved = true;
    }

    // Safety net: if no branch above resolved the item status (should never
    // happen, but guards against future code changes), force-complete so the
    // item doesn't stay stuck as 'processing' in the DB forever.
    if (!statusResolved) {
      log.error('processFocusedItem: no status branch matched — force-completing', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
        reply: typeof reply === 'string' ? reply.slice(0, 100) : String(reply),
      });
      this.mailbox.complete(item.id);
    }

    // Complete batch items that were processed together with the primary item.
    // If the primary was preempted/cancelled/timed-out, batch items are requeued.
    if (batchItems && batchItems.length > 0) {
      const wasSuccessful = !timedOut && reply !== '[cancelled]' && reply !== '[preempted]'
        && this.lastYieldDecision !== 'cancel' && this.lastYieldDecision !== 'preempt';
      for (const bi of batchItems) {
        if (wasSuccessful) {
          this.mailbox.complete(bi.id);
        } else {
          this.mailbox.requeue(bi);
        }
      }
    }

    this.currentFocus = undefined;
    this.interruptSignal = false;
    this.pendingInterruptItem = undefined;
  }

  /**
   * Called when new mail arrives. If idle, the loop handles it via dequeueAsync.
   * If focused, registers an interrupt signal for the next yield point.
   * For critical user messages, also fires the critical-interrupt promise so that
   * long-running tool execution can be aborted early.
   */
  private onNewMail(): void {
    if (this.state === 'idle') {
      return;
    }

    if (this.state === 'focused' || this.state === 'deciding') {
      this.interruptSignal = true;
      const peeked = this.mailbox.peek();
      if (peeked) {
        this.pendingInterruptItem = peeked;

        // If a human_chat arrives during deliberation, signal early abort
        if (this.isDeliberating && AttentionController.USER_INTERACTION_TYPES.has(peeked.sourceType)) {
          this.deliberationAbortSignal = true;
        }

        const wouldPreempt = this.currentFocus
          ? this.heuristicDecision(this.currentFocus, peeked) === 'preempt'
          : false;
        if (wouldPreempt && this.criticalInterruptResolve) {
          this.criticalInterruptResolve();
          this.criticalInterruptResolve = undefined;
        }
      }
    }
  }

  /**
   * Returns a promise that resolves when a preemption-worthy interrupt arrives.
   * Used by the agent to race long-running tool calls against critical interrupts.
   * The promise is single-use; call again to get a fresh one.
   */
  waitForPreemptionSignal(): Promise<void> {
    return new Promise<void>(resolve => {
      this.criticalInterruptResolve = resolve;
    });
  }

  /**
   * Discard the current critical-interrupt promise (e.g. when a tool finishes
   * normally before any interrupt arrived).
   */
  clearPreemptionSignal(): void {
    this.criticalInterruptResolve = undefined;
  }

  /**
   * Clear the lastYieldDecision flag set by checkYieldPoint().
   * Used by processing code that handles preemption internally (e.g. task
   * execution delegates resumption to TaskService) so the attention loop
   * completes the item normally instead of deferring it.
   */
  clearLastYieldDecision(): void {
    this.lastYieldDecision = undefined;
  }

  /** True if a human_chat arrived during deliberation, signalling early abort. */
  get shouldAbortDeliberation(): boolean {
    return this.deliberationAbortSignal;
  }

  /**
   * Called from the Agent's tool loop at safe yield points (between LLM turns).
   * If an interrupt signal is pending, evaluates whether to continue or switch.
   *
   * Returns the decision type so the caller knows what to do:
   * - 'continue' → keep working on current task
   * - 'preempt' → caller should save state and return '[preempted]'; item is deferred for later resumption
   * - 'cancel' → caller should abort and return '[cancelled]'; item is permanently dropped
   * - 'merge' → item was absorbed into current work (caller may inject into session)
   */
  async checkYieldPoint(): Promise<{
    decision: DecisionType;
    item?: MailboxItem;
    reasoning?: string;
  }> {
    // Deliberation is mostly atomic, but critical user messages (human_chat)
    // must still be able to preempt — users should never wait for deliberation.
    if (this.isDeliberating) {
      if (!this.interruptSignal) return { decision: 'continue' };
      const peeked = this.pendingInterruptItem ?? this.mailbox.peek();
      if (!peeked || !AttentionController.USER_INTERACTION_TYPES.has(peeked.sourceType)) {
        return { decision: 'continue' };
      }
      // Fall through to evaluate the user interrupt normally
    }

    if (!this.interruptSignal || !this.currentFocus) {
      return { decision: 'continue' };
    }

    this.interruptSignal = false;
    const newItem = this.pendingInterruptItem ?? this.mailbox.peek();
    this.pendingInterruptItem = undefined;

    if (!newItem) {
      return { decision: 'continue' };
    }

    this.setState('deciding');

    let decisionType: DecisionType;
    try {
      decisionType = this.delegate
        ? await this.delegate.evaluateInterrupt(this.currentFocus, newItem)
        : this.heuristicDecision(this.currentFocus, newItem);
    } catch {
      decisionType = this.heuristicDecision(this.currentFocus, newItem);
    }

    this.setState('focused');

    const reasoning = this.formatDecisionReasoning(decisionType, this.currentFocus, newItem);
    const decision = this.recordDecision(decisionType, newItem, reasoning);
    this.delegate?.onDecisionMade(decision);

    if (decisionType === 'merge') {
      const merged = this.mailbox.merge(newItem.id, this.currentFocus.id);
      return { decision: 'merge', item: merged ?? newItem, reasoning };
    }

    if (decisionType === 'defer') {
      this.mailbox.defer(newItem.id);
      return { decision: 'defer', item: newItem, reasoning };
    }

    if (decisionType === 'preempt') {
      this.lastYieldDecision = 'preempt';
      return { decision: 'preempt', item: newItem, reasoning };
    }

    if (decisionType === 'cancel') {
      this.lastYieldDecision = 'cancel';
      return { decision: 'cancel', item: newItem, reasoning };
    }

    return { decision: 'continue', reasoning };
  }

  /**
   * Set a lightweight LLM judge for ambiguous decisions where heuristics
   * fall back to 'continue'.  The judge receives a structured prompt and
   * returns a decision type.  This is intentionally optional — the system
   * works fully on heuristics alone.
   */
  setLLMJudge(judge: LLMDecisionJudge | undefined): void {
    this.llmJudge = judge;
  }

  setTriageJudge(judge: TriageJudge | undefined): void {
    this.triageJudge = judge;
  }

  /**
   * Set read-only tools available during triage deliberation.
   * These let the LLM gather context (task_list, team_list, etc.) before deciding.
   */
  setTriageTools(tools: Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> }> | undefined): void {
    this.triageToolHandlers = tools;
  }

  setTriageChatFn(fn: TriageChatFn | undefined): void {
    this.triageChatFn = fn;
  }

  /**
   * Fast heuristic decision when no LLM judgment is available.
   * Rules are evaluated top-to-bottom; first match wins.
   */
  /** Types that are unconditionally from a human user — always highest priority. */
  private static readonly USER_INTERACTION_TYPES: Set<MailboxItemType> = new Set([
    'human_chat',
  ]);

  /** Peer interaction types that preempt background work but not human chat. */
  private static readonly PEER_INTERACTION_TYPES: Set<MailboxItemType> = new Set([
    'a2a_message',
  ]);

  heuristicDecision(currentItem: MailboxItem, newItem: MailboxItem): DecisionType {
    const isNewUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(newItem.sourceType);
    const isCurrentUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(currentItem.sourceType);

    // R0: Same-user follow-up during active chat → merge (inject into session)
    // This lets the user send multiple messages without each one preempting the previous.
    // Skip merge when the current stream is being cancelled (user aborted) —
    // the new message should be processed as a fresh turn after cancellation.
    if (
      newItem.sourceType === 'human_chat' &&
      currentItem.sourceType === 'human_chat' &&
      newItem.metadata?.senderId &&
      newItem.metadata.senderId === currentItem.metadata?.senderId &&
      !(currentItem.payload.extra?.cancelToken as { cancelled?: boolean } | undefined)?.cancelled
    ) {
      return 'merge';
    }

    // R1: User chat/comments ALWAYS preempt non-user work — users are top priority
    if (isNewUserInteraction && !isCurrentUserInteraction) {
      return 'preempt';
    }

    // R1.5: Peer interactions preempt background work (heartbeat, scheduled) but not human chat
    if (
      AttentionController.PEER_INTERACTION_TYPES.has(newItem.sourceType) &&
      !isCurrentUserInteraction &&
      !AttentionController.PEER_INTERACTION_TYPES.has(currentItem.sourceType)
    ) {
      return 'preempt';
    }

    // R2: Comments on the currently focused task → merge into context
    if (
      newItem.sourceType === 'task_comment' &&
      newItem.payload.taskId &&
      currentItem.payload.taskId === newItem.payload.taskId
    ) {
      return 'merge';
    }

    // R3: Requirement update/comment on the focused requirement → merge
    if (
      (newItem.sourceType === 'requirement_update' || newItem.sourceType === 'requirement_comment') &&
      newItem.payload.requirementId &&
      currentItem.payload.requirementId === newItem.payload.requirementId
    ) {
      return 'merge';
    }

    // R4: System-critical events (priority 0) preempt lower-priority work
    if (
      newItem.priority <= MailboxPriorityLevel.critical &&
      currentItem.priority > MailboxPriorityLevel.critical
    ) {
      return 'preempt';
    }

    // R5: (Removed — task_status_update is now informational and auto-completed)

    // R6: Strictly higher priority (lower number) → preempt
    if (newItem.priority < currentItem.priority) {
      return 'preempt';
    }

    // R7: Human chat always preempts background work (system category from registry)
    const bgTypes = (Object.entries(MAILBOX_TYPE_REGISTRY) as [MailboxItemType, typeof MAILBOX_TYPE_REGISTRY[MailboxItemType]][])
      .filter(([, d]) => d.category === 'system')
      .map(([k]) => k);
    if (
      newItem.sourceType === 'human_chat' &&
      bgTypes.includes(currentItem.sourceType)
    ) {
      return 'preempt';
    }

    // R8: Same priority but current is background work → preempt
    if (
      newItem.priority === currentItem.priority &&
      bgTypes.includes(currentItem.sourceType)
    ) {
      return 'preempt';
    }

    // R9: Mentions always preempt low-priority work
    if (
      newItem.sourceType === 'mention' &&
      currentItem.priority >= MailboxPriorityLevel.normal
    ) {
      return 'preempt';
    }

    // Default: continue current work
    return 'continue';
  }

  /**
   * Enhanced decision with optional LLM fallback for ambiguous cases.
   * Used by the delegate's evaluateInterrupt when wired.
   */
  async evaluateWithLLMFallback(
    currentItem: MailboxItem,
    newItem: MailboxItem,
  ): Promise<DecisionType> {
    const heuristic = this.heuristicDecision(currentItem, newItem);

    // If heuristics produce a clear non-continue answer, use it
    if (heuristic !== 'continue') return heuristic;

    // If no LLM judge is configured, stick with heuristic
    if (!this.llmJudge) return heuristic;

    // For same-priority items where heuristic says 'continue',
    // consult LLM for nuanced judgment
    try {
      const prompt = this.buildJudgePrompt(currentItem, newItem);
      const llmDecision = await this.llmJudge(prompt);
      const validDecisions: DecisionType[] = ['continue', 'preempt', 'cancel', 'merge', 'defer'];
      if (validDecisions.includes(llmDecision)) return llmDecision;
    } catch (err) {
      log.debug('LLM judge failed, falling back to heuristic', {
        agentId: this.agentId,
        error: String(err),
      });
    }

    return heuristic;
  }

  private buildJudgePrompt(
    currentItem: MailboxItem,
    newItem: MailboxItem,
  ): string {
    const recentDecs = this.decisions.slice(-5).map(d =>
      `- ${d.decisionType}: ${d.reasoning}`
    ).join('\n');

    const queuedItems = this.mailbox.getQueuedItems();
    const queueSection = queuedItems.length > 0
      ? queuedItems.map(i => `  - [${i.sourceType}] p${i.priority}: "${i.payload.summary}"`).join('\n')
      : '  (empty)';

    const currentContent = currentItem.payload.content?.slice(0, 500) ?? '';
    const newContent = newItem.payload.content?.slice(0, 800) ?? '';

    return [
      'You are deciding whether to INTERRUPT your current work to handle a new incoming message.',
      '',
      'RULES (in priority order):',
      '1. Human messages (human_chat) ALWAYS preempt non-human work — users are top priority.',
      '2. If the new message explicitly CANCELS or REVOKES the current work (e.g. "cancel that task",',
      '   "don\'t publish this anymore", "delete the draft"), choose cancel — current work is permanently abandoned.',
      '3. If the new message asks to PAUSE or DELAY current work (e.g. "hold off for now",',
      '   "wait before deploying", "pause that"), choose preempt — current work is saved and can be resumed later.',
      '4. If the new message is about the SAME task/topic as current work and adds info, consider merge.',
      '5. If the new message is lower priority and unrelated, continue current work.',
      '',
      `CURRENT FOCUS: [${currentItem.sourceType}] priority=${currentItem.priority}`,
      `  Summary: "${currentItem.payload.summary}"`,
      `  Task: ${currentItem.payload.taskId ?? 'none'}`,
      currentContent ? `  Content preview: ${currentContent}` : '',
      '',
      `NEW ITEM: [${newItem.sourceType}] priority=${newItem.priority}`,
      `  Summary: "${newItem.payload.summary}"`,
      `  Task: ${newItem.payload.taskId ?? 'none'}`,
      newContent ? `  Content: ${newContent}` : '',
      '',
      `FULL QUEUE (${this.mailbox.depth} items):`,
      queueSection,
      '',
      'RECENT DECISIONS:',
      recentDecs || '(none)',
      '',
      'DECISIONS:',
      '- preempt: PAUSE current work (session saved for later resumption) and handle the new item',
      '- cancel: PERMANENTLY STOP current work (session dropped, will NOT be resumed) and handle the new item',
      '- merge: Inject new item into current session as additional context (no interruption)',
      '- defer: Put the new item aside for later (no interruption)',
      '- continue: Ignore the new item for now, keep working',
      '',
      'Choose exactly one: continue | preempt | cancel | merge | defer',
      'Reply with ONLY the decision word, nothing else.',
    ].join('\n');
  }

  // ─── Triage ─────────────────────────────────────────────────────────────────

  /**
   * Determine whether LLM triage is actually needed.
   *
   * Triggers deliberation in two scenarios (first match wins):
   * 1. Backlog: queue depth >= TRIAGE_BACKLOG_THRESHOLD (currently 2) — agent
   *    uses mailbox tools to defer/drop/prioritize before committing to work.
   * 2. Priority ambiguity: queued items at the same or higher priority as
   *    head — priority queue alone can't decide the right order.
   * (Never for human_chat — always processed immediately in FIFO order.)
   */
  private needsLLMTriage(headItem: MailboxItem): boolean {
    if (headItem.sourceType === 'human_chat') return false;

    const queued = this.mailbox.getQueuedItems();
    if (queued.length === 0) return false;

    if (queued.length >= TRIAGE_BACKLOG_THRESHOLD) return true;

    const samePriorityCount = queued.filter(i => i.priority <= headItem.priority).length;
    return samePriorityCount > 0;
  }

  /**
   * LLM-driven triage: given the dequeued head item plus all remaining
   * queued items, ask the agent to decide which one to process first
   * and whether to defer or drop any others.
   */
  private async performTriage(headItem: MailboxItem): Promise<TriageResult | null> {
    if (!this.triageJudge) return null;
    this.setState('deciding');

    try {
      const ctx = await this.delegate?.getTriageContext?.();
      const prompt = this.buildTriagePrompt(headItem, ctx ?? undefined);

      let raw: string | undefined;

      // Mini tool loop: if triageChatFn and tools are available, allow limited
      // read-only tool calls before the final JSON decision
      if (this.triageChatFn && this.triageToolHandlers && this.triageToolHandlers.size > 0) {
        const llmTools = [...this.triageToolHandlers.values()].map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        const triageAgentName = ctx?.agentName ?? 'Agent';
        const triageRoleHint = ctx?.agentRole ? ` Your role: ${ctx.agentRole}.` : '';
        const messages: Array<{ role: string; content: string; toolCalls?: any[]; toolCallId?: string; reasoningContent?: string }> = [
          { role: 'system', content: `You are ${triageAgentName}, deliberating over your mailbox.${triageRoleHint} You may call tools to gather context before making your decision. When ready, output ONLY a single JSON object — no explanation, no markdown fences, no <think> tags. Start your response with {` },
          { role: 'user', content: prompt },
        ];

        let iterations = 0;
        while (iterations < TRIAGE_MAX_TOOL_ITERATIONS) {
          const response = await this.triageChatFn(messages, llmTools);

          if (!response.toolCalls?.length) {
            raw = response.content;
            break;
          }

          messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, reasoningContent: response.reasoningContent });

          for (const tc of response.toolCalls) {
            const handler = this.triageToolHandlers!.get(tc.name);
            let result: string;
            if (handler) {
              try { result = await handler.execute(tc.arguments); }
              catch (err) { result = `Error: ${String(err)}`; }
            } else {
              result = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
            }
            messages.push({ role: 'tool', content: result, toolCallId: tc.id });
          }
          iterations++;
        }

        // If loop exhausted without a final text response, make one last call without tools
        if (raw === undefined) {
          const finalResp = await this.triageChatFn(messages, undefined);
          raw = finalResp.content;
        }
      } else {
        raw = await this.triageJudge(prompt);
      }

      // Strip <think>...</think> blocks that some models (e.g. Qwen, DeepSeek) emit.
      const cleaned = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.warn('Triage judge returned non-JSON response', { agentId: this.agentId, raw: raw.slice(0, 300) });
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<TriageResult>;
      if (!parsed.processItemId || !parsed.reasoning) {
        log.warn('Triage judge returned incomplete result', { agentId: this.agentId, parsed });
        return null;
      }

      const allCandidateIds = new Set([headItem.id, ...this.mailbox.getQueuedItems().map(i => i.id)]);
      if (!allCandidateIds.has(parsed.processItemId)) {
        log.warn('Triage judge chose unknown item ID', {
          agentId: this.agentId,
          chosen: parsed.processItemId,
          candidates: [...allCandidateIds],
        });
        return null;
      }

      return {
        processItemId: parsed.processItemId,
        deferItemIds: (parsed.deferItemIds ?? []).filter(id => allCandidateIds.has(id)),
        dropItemIds: (parsed.dropItemIds ?? []).filter(id => allCandidateIds.has(id)),
        reasoning: parsed.reasoning,
      };
    } catch (err) {
      log.warn('Triage deliberation failed, falling back to priority order', {
        agentId: this.agentId,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Apply a TriageResult to the mailbox: reorder, defer, drop items.
   * Returns the item to process next.
   */
  private applyTriageResult(currentItem: MailboxItem, triageResult: TriageResult): MailboxItem {
    let item = currentItem;
    if (triageResult.processItemId !== item.id) {
      this.mailbox.putBack(item);
      const chosen = this.mailbox.dequeueById(triageResult.processItemId);
      if (chosen) {
        item = chosen;
      } else {
        const redequeued = this.mailbox.dequeueById(currentItem.id);
        if (redequeued) item = redequeued;
      }
    }

    const queueSnapshot = this.mailbox.getQueuedItems();
    const isProtected = (id: string) => {
      const it = queueSnapshot.find(i => i.id === id);
      if (!it) return false;
      if (it.sourceType === 'human_chat') return true;
      if (it.payload.extra?.triggerExecution) return true;
      if (it.payload.extra?.directMention) return true;
      return false;
    };

    for (const deferId of triageResult.deferItemIds) {
      if (isProtected(deferId)) continue;
      this.mailbox.defer(deferId);
    }
    for (const dropId of triageResult.dropItemIds) {
      if (isProtected(dropId)) continue;
      this.mailbox.drop(dropId);
    }

    this.lastTriageResult = { ...triageResult, timestamp: new Date().toISOString() };
    this.delegate?.onTriageCompleted?.(triageResult);
    this.eventBus.emit('attention:triage', {
      agentId: this.agentId,
      triage: this.lastTriageResult,
    });
    const triageDecision = this.recordDecision('triage', item, triageResult.reasoning);
    this.delegate?.onDecisionMade(triageDecision);
    return item;
  }

  /**
   * Apply a DeliberationResult to the mailbox: handle inline completions, reorder, defer, drop.
   * Returns the item to process next.
   */
  /** Batch items dequeued for the current processing cycle (set by applyDeliberationResult). */
  private pendingBatchItems: MailboxItem[] = [];
  private pendingBatchContext?: string;

  private applyDeliberationResult(currentItem: MailboxItem, result: DeliberationResult): MailboxItem {
    let item = currentItem;

    const queueSnapshot = this.mailbox.getQueuedItems();
    const isProtected = (id: string) => {
      const it = queueSnapshot.find(i => i.id === id);
      if (!it) return false;
      if (it.sourceType === 'human_chat') return true;
      if (it.payload.extra?.triggerExecution) return true;
      if (it.payload.extra?.directMention) return true;
      return false;
    };

    // Resolve effective process IDs (batch takes precedence over single)
    const effectiveProcessIds = (result.processItemIds && result.processItemIds.length > 0)
      ? result.processItemIds
      : [result.processItemId];

    // Mark inline-completed items (these were handled during deliberation, NOT discarded).
    for (const completedId of result.inlineCompletedIds) {
      if (isProtected(completedId)) continue;
      if (completedId === currentItem.id) continue;
      if (effectiveProcessIds.includes(completedId)) continue;
      const completedItem = queueSnapshot.find(i => i.id === completedId);
      this.mailbox.complete(completedId);
      if (completedItem) {
        this.recordDecision('complete', completedItem, 'Handled inline during deliberation');
      }
    }

    // Select the primary item to process
    const primaryId = effectiveProcessIds[0];
    if (primaryId !== item.id) {
      this.mailbox.putBack(item);
      const chosen = this.mailbox.dequeueById(primaryId);
      if (chosen) {
        item = chosen;
      } else {
        log.warn('Deliberation chose item that is no longer in queue, falling back to head', {
          agentId: this.agentId,
          chosenId: primaryId,
          fallbackId: currentItem.id,
        });
        const redequeued = this.mailbox.dequeueById(currentItem.id);
        if (redequeued) item = redequeued;
      }
    }

    // Dequeue additional batch items (if batch processing)
    this.pendingBatchItems = [];
    this.pendingBatchContext = result.batchContext;
    if (effectiveProcessIds.length > 1) {
      for (let i = 1; i < effectiveProcessIds.length; i++) {
        const batchId = effectiveProcessIds[i];
        if (isProtected(batchId)) continue;
        const batchItem = this.mailbox.dequeueById(batchId);
        if (batchItem) {
          this.pendingBatchItems.push(batchItem);
        }
      }
    }

    // Defer and drop
    for (const deferId of result.deferItemIds) {
      if (isProtected(deferId)) continue;
      this.mailbox.defer(deferId);
    }
    for (const dropId of result.dropItemIds) {
      if (isProtected(dropId)) continue;
      this.mailbox.drop(dropId);
    }

    // Apply memory updates from deliberation
    if (result.memoryUpdates && result.memoryUpdates.length > 0) {
      this.delegate?.applyMemoryUpdates?.(result.memoryUpdates);
    }

    // Emit events and update cognition
    const triageEquivalent: TriageResult = {
      processItemId: primaryId,
      deferItemIds: result.deferItemIds,
      dropItemIds: result.dropItemIds,
      inlineCompletedIds: result.inlineCompletedIds,
      reasoning: result.reasoning,
    };
    this.lastTriageResult = { ...triageEquivalent, timestamp: new Date().toISOString() };
    this.delegate?.onDeliberationCompleted?.(result);
    this.eventBus.emit('attention:triage', {
      agentId: this.agentId,
      triage: this.lastTriageResult,
    });
    const triageDecision = this.recordDecision('triage', item, `[deliberation] ${result.reasoning}`);
    this.delegate?.onDecisionMade(triageDecision);
    return item;
  }

  private buildTriagePrompt(headItem: MailboxItem, ctx?: TriageContext): string {
    const agentName = ctx?.agentName ?? 'Agent';
    const queuedItems = this.mailbox.getQueuedItems();
    const allItems = [headItem, ...queuedItems];

    const shown = allItems.slice(0, TRIAGE_PROMPT_MAX_ITEMS);
    const overflow = allItems.length - shown.length;

    const formatAge = (ms: number): string => {
      if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
      if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
      return `${(ms / 3_600_000).toFixed(1)}h`;
    };

    const formatItem = (item: MailboxItem, idx: number) => {
      const pri = PRIORITY_LABELS?.[item.priority] ?? `p${item.priority}`;
      const ageMs = Date.now() - new Date(item.queuedAt).getTime();
      const timestamp = new Date(item.queuedAt).toISOString().slice(11, 19);
      const contentPreview = item.payload.content
        ? `\n      content: "${item.payload.content.slice(0, TRIAGE_ITEM_CONTENT_CHARS)}"`
        : '';
      return [
        `  [${idx + 1}] id="${item.id}"`,
        `      type=${item.sourceType}  priority=${pri}  age=${formatAge(ageMs)}  queued=${timestamp}`,
        `      summary: "${item.payload.summary}"`,
        item.payload.taskId ? `      taskId: ${item.payload.taskId}` : null,
        item.metadata?.senderName ? `      from: ${item.metadata.senderName} (${item.metadata?.senderRole ?? 'unknown'})` : null,
        contentPreview || null,
      ].filter(Boolean).join('\n');
    };

    const itemsSection = shown.map(formatItem).join('\n\n');
    const overflowNote = overflow > 0
      ? `\n\n  ... and ${overflow} more items (lower priority, similar types). You can only choose from the items listed above.`
      : '';

    // Group items by taskId for the LLM to see relationships
    const taskGroups = new Map<string, number>();
    for (const item of shown) {
      const tid = item.payload.taskId ?? (item.metadata?.taskId as string | undefined);
      if (tid) taskGroups.set(tid, (taskGroups.get(tid) ?? 0) + 1);
    }
    const taskGroupSummary = taskGroups.size > 0
      ? [...taskGroups.entries()].map(([tid, count]) => `  ${tid}: ${count} items`).join('\n')
      : '  (no task grouping)';

    const recentContext = ctx?.recentMainSessionMessages
      ?.map(m => `  [${m.role}]: ${m.content}`)
      .join('\n') ?? '  (no recent context)';

    const recentActivity = ctx?.recentActivitySummaries?.length
      ? ctx.recentActivitySummaries.map(a => `  - ${a}`).join('\n')
      : '  (no recent activity)';

    const recentDecs = this.decisions.slice(-5).map(d =>
      `  - ${d.decisionType}: ${d.reasoning}`
    ).join('\n') || '  (none)';

    const activeTasksSection = ctx?.activeTaskIds?.length
      ? `  Active tasks: ${ctx.activeTaskIds.join(', ')}`
      : '  (no active tasks)';

    return [
      `You are ${agentName}. You have ${allItems.length} items in your mailbox that need attention.`,
      `Your job is to decide which item to process NOW. Current time: ${new Date().toISOString().slice(11, 19)} UTC.`,
      '',
      `## Mailbox Items (top ${shown.length} candidates)`,
      itemsSection + overflowNote,
      '',
      '## Items Grouped by Task',
      taskGroupSummary,
      '',
      '## Your Current State',
      activeTasksSection,
      '',
      '## Your Recent Conversation Context',
      recentContext,
      '',
      '## Your Recent Activity',
      recentActivity,
      '',
      '## Your Recent Decisions',
      recentDecs,
      '',
      '## Rules',
      '- Human messages (human_chat) and human comments are ALWAYS highest priority — process them first.',
      '- Agent messages with direct @mentions (a2a_message where you were explicitly mentioned) should be treated like human messages — NEVER drop them. They represent explicit requests for your input.',
      '- Task status updates (task_status_update) come in two flavours: **execution triggers** (priority 1, carry execution context) that MUST be processed — never drop or defer them; and **informational** ones that the system already handled. Informational updates serve as decision context, not work items.',
      '- **Time decay**: Items older than 1 hour are increasingly stale. Multiple status updates about the same task — only the latest matters. Aggressively DROP old informational items (heartbeats, old status updates, memory consolidation) that no longer provide actionable context.',
      '- **Task grouping**: When multiple items reference the same taskId, consider them together. Drop redundant/superseded items for the same task — only keep the most recent or most actionable one.',
      '- Consider dependencies: if one item provides context needed by another, process it first.',
      '- DEFER means "handle later" — use for items that can wait but should not be forgotten.',
      '- DROP means "not worth processing" — use for stale, redundant, or obsolete items. When in doubt about old informational items, DROP them.',
      '- When in doubt, process items in priority order (lower number = higher priority).',
      '',
      '## Required Response Format',
      'Respond with ONLY a JSON object, nothing else:',
      '{',
      '  "processItemId": "<id of the item to process NOW>",',
      '  "deferItemIds": ["<ids to defer>"],',
      '  "dropItemIds": ["<ids to drop>"],',
      '  "reasoning": "<1-2 sentence explanation>"',
      '}',
    ].join('\n');
  }

  // ─── State & Queries ──────────────────────────────────────────────────────

  getState(): AttentionState {
    return this.state;
  }

  getCurrentFocus(): MailboxItem | undefined {
    return this.currentFocus;
  }

  getRecentDecisions(limit = 20): AttentionDecision[] {
    return this.decisions.slice(-limit);
  }

  getMindState(): AgentMindState {
    const queued = this.mailbox.getQueuedItems();
    return {
      attentionState: this.state,
      isDeliberating: this.isDeliberating || undefined,
      currentFocus: this.currentFocus
        ? {
            mailboxItemId: this.currentFocus.id,
            type: this.currentFocus.sourceType,
            label: this.currentFocus.payload.summary,
            startedAt: this.currentFocus.startedAt ?? this.currentFocus.queuedAt,
            taskId: this.currentFocus.payload.taskId,
          }
        : undefined,
      mailboxDepth: queued.length,
      queuedItems: queued.map(i => ({
        id: i.id,
        sourceType: i.sourceType,
        priority: i.priority,
        summary: i.payload.summary,
        queuedAt: i.queuedAt,
      })),
      deferredItems: [],
      recentDecisions: this.decisions.slice(-10),
      lastTriage: this.lastTriageResult ? {
        reasoning: this.lastTriageResult.reasoning,
        processedItemId: this.lastTriageResult.processItemId,
        deferredItemIds: this.lastTriageResult.deferItemIds,
        droppedItemIds: this.lastTriageResult.dropItemIds,
        inlineCompletedIds: this.lastTriageResult.inlineCompletedIds ?? [],
        timestamp: this.lastTriageResult.timestamp,
      } : undefined,
    };
  }

  deferItem(itemId: string, reason: string, deferUntilMs?: number): boolean {
    const item = this.mailbox.getById(itemId);
    if (!item || item.status !== 'queued') return false;
    if (item.sourceType === 'human_chat') return false;
    this.mailbox.defer(itemId, deferUntilMs ? new Date(Date.now() + deferUntilMs).toISOString() : undefined);
    const decision = this.recordDecision('defer', item, reason);
    this.delegate?.onDecisionMade(decision);
    return true;
  }

  dropItem(itemId: string, reason: string): boolean {
    const item = this.mailbox.getById(itemId);
    if (!item || item.status !== 'queued') return false;
    if (item.sourceType === 'human_chat') return false;
    this.mailbox.drop(itemId);
    const decision = this.recordDecision('drop', item, reason);
    this.delegate?.onDecisionMade(decision);
    return true;
  }

  prioritizeItem(itemId: string, newPriority: number): boolean {
    const item = this.mailbox.getById(itemId);
    if (!item || item.sourceType === 'human_chat') return false;
    return this.mailbox.updatePriority(itemId, newPriority);
  }

  hasInterruptPending(): boolean {
    return this.interruptSignal;
  }

  /**
   * Restore the interrupt signal after a yield point returned a decision
   * that couldn't be acted upon (e.g. preempt in a non-preemptable context).
   * This prevents the signal from being silently consumed and lost.
   */
  restoreInterruptSignal(item?: MailboxItem): void {
    this.interruptSignal = true;
    if (item) {
      this.pendingInterruptItem = item;
    }
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  private setState(s: AttentionState): void {
    if (this.state === s) return;
    this.state = s;
    this.eventBus.emit('attention:state-changed', {
      agentId: this.agentId,
      state: s,
      currentFocus: this.currentFocus?.id,
    });
  }

  private recordDecision(
    type: DecisionType,
    item: MailboxItem,
    reasoning: string,
  ): AttentionDecision {
    const decision: AttentionDecision = {
      id: generateId('dec'),
      agentId: this.agentId,
      decisionType: type,
      mailboxItemId: item.id,
      context: {
        currentFocusType: this.currentFocus?.sourceType,
        currentFocusLabel: this.currentFocus?.payload.summary,
        currentFocusItemId: this.currentFocus?.id,
        mailboxDepth: this.mailbox.depth,
        queuedItemTypes: this.mailbox
          .getQueuedItems()
          .map(i => i.sourceType),
      },
      reasoning,
      createdAt: new Date().toISOString(),
    };

    this.decisions.push(decision);
    if (this.decisions.length > AttentionController.MAX_RECENT_DECISIONS) {
      this.decisions = this.decisions.slice(-AttentionController.MAX_RECENT_DECISIONS);
    }

    this.decisionPersistence?.save(decision);
    this.eventBus.emit('attention:decision', { agentId: this.agentId, decision });

    return decision;
  }

  private formatDecisionReasoning(
    type: DecisionType,
    currentItem: MailboxItem,
    newItem: MailboxItem,
  ): string {
    const newLabel = `${newItem.sourceType}: "${newItem.payload.summary}"`;
    const currentLabel = `${currentItem.sourceType}: "${currentItem.payload.summary}"`;

    switch (type) {
      case 'continue':
        return `New mail (${newLabel}) not urgent enough to interrupt current work (${currentLabel}).`;
      case 'preempt':
        return `New mail (${newLabel}) has higher priority — pausing current work (${currentLabel}).`;
      case 'merge':
        return `New mail (${newLabel}) relates to current work — absorbing into current focus.`;
      case 'defer':
        return `New mail (${newLabel}) deferred — will handle after current work completes.`;
      case 'delegate':
        return `New mail (${newLabel}) delegated to another agent.`;
      default:
        return `Decision: ${type} for ${newLabel}.`;
    }
  }
}
