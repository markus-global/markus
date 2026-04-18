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
  MailboxPriorityLevel,
  MAILBOX_TYPE_REGISTRY,
  MAILBOX_ITEM_MAX_RETRIES,
  COMPLETION_MARKER,
  PRIORITY_LABELS,
  TRIAGE_PROMPT_MAX_ITEMS,
  MAILBOX_PROCESSING_TIMEOUT_MS,
  APPROVAL_WAIT_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_DRIFT_THRESHOLD_MS,
  TRIAGE_ITEM_CONTENT_CHARS,
  TRIAGE_MAX_TOOL_ITERATIONS,
  TRIAGE_ALLOWED_TOOLS,
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

  // Intentional preemption by the attention controller — a higher-priority
  // item arrived and this one was interrupted on purpose.
  if (reply === '[preempted]') return undefined;

  // User-facing interactions: the response (even if partial) was already
  // delivered to the caller.  Requeuing would re-process the identical
  // message and generate a different reply — never desirable.
  const isUserFacing = item.sourceType === 'human_chat' || item.sourceType === 'a2a_message';
  if (isUserFacing) return undefined;

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
  processMailboxItem(item: MailboxItem): Promise<string | void>;
  onDecisionMade(decision: AttentionDecision): void;
  onFocusChanged(item: MailboxItem | undefined): void;
  evaluateInterrupt(
    currentItem: MailboxItem,
    newItem: MailboxItem,
  ): Promise<DecisionType>;
  getTriageContext?(): Promise<TriageContext>;
  onTriageCompleted?(result: TriageResult | null): void;
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
export type TriageChatFn = (messages: Array<{ role: string; content: string; toolCalls?: any[]; toolCallId?: string }>, tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) => Promise<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>;

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
  private unsubscribeNewItem?: () => void;
  private decisions: AttentionDecision[] = [];
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private watchdogLastTick = Date.now();
  private processingStartedAt?: number;
  private waitingForHumanApproval = false;

  private static readonly MAX_RECENT_DECISIONS = 50;

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
    this.loopPromise = this.runLoop().catch(err => {
      if (this.running) {
        log.error('Attention loop crashed unexpectedly', { agentId: this.agentId, error: String(err) });
      }
    });
    log.info('Attention controller started', { agentId: this.agentId });
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
    while (this.running) {
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
        // Re-enqueue so non-interactive items are not lost on shutdown.
        // User-facing chats are NOT re-enqueued: their SSE/promise
        // callbacks are stale after restart, and replaying them would
        // duplicate the message in the session.  The user can resend.
        if (item.sourceType !== 'human_chat' && item.sourceType !== 'a2a_message') {
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

      // Pre-triage cleanup: drop stale informational items, then consolidate
      // items sharing the same task/requirement into single rich-context items.
      if (this.mailbox.depth > 0) {
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
      // 3. A TriageJudge is configured
      // When priorities clearly separate items, the priority queue already
      // produces the right order — no LLM call needed.
      let triaged = false;
      if (this.mailbox.depth > 0 && this.triageJudge && this.needsLLMTriage(item)) {
        const triageResult = await this.performTriage(item);
        if (triageResult) {
          triaged = true;
          if (triageResult.processItemId !== item.id) {
            this.mailbox.putBack(item);
            const chosen = this.mailbox.dequeueById(triageResult.processItemId);
            if (chosen) {
              item = chosen;
            } else {
              const redequeued = this.mailbox.dequeueById(item.id);
              if (redequeued) item = redequeued;
            }
          }
          // Build a lookup so we can guard user chat items from triage actions.
          const queueSnapshot = this.mailbox.getQueuedItems();
          const isUserChat = (id: string) =>
            queueSnapshot.find(i => i.id === id)?.sourceType === 'human_chat';

          for (const deferId of triageResult.deferItemIds) {
            if (isUserChat(deferId)) continue;
            this.mailbox.defer(deferId);
          }
          for (const dropId of triageResult.dropItemIds) {
            if (isUserChat(dropId)) continue;
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
        }
      }

      if (!triaged) {
        const decision = this.recordDecision('pick', item, `Idle, processing ${item.sourceType}`);
        this.delegate?.onDecisionMade(decision);
      }

      await this.processFocusedItem(item);
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
    this.processingStartedAt = Date.now();
    this.delegate?.onFocusChanged(item);

    let reply: string | void = undefined;
    let timedOut = false;
    try {
      // The delegate's processMailboxItem makes LLM calls and shell commands,
      // each of which has its own transport-level timeout. This outer timeout
      // is a generous backstop — by the time it fires, all underlying I/O has
      // surely completed or failed, so requeuing is safe.
      const processing = this.delegate?.processMailboxItem(item);
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

    if (timedOut) {
      this.mailbox.requeue(item);
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
    }

    this.currentFocus = undefined;
    this.interruptSignal = false;
    this.pendingInterruptItem = undefined;
  }

  /**
   * Called when new mail arrives. If idle, the loop handles it via dequeueAsync.
   * If focused, registers an interrupt signal for the next yield point.
   */
  private onNewMail(): void {
    if (this.state === 'idle') {
      return;
    }

    if (this.state === 'focused') {
      this.interruptSignal = true;
      const peeked = this.mailbox.peek();
      if (peeked) {
        this.pendingInterruptItem = peeked;
      }
    }
  }

  /**
   * Called from the Agent's tool loop at safe yield points (between LLM turns).
   * If an interrupt signal is pending, evaluates whether to continue or switch.
   *
   * Returns the decision type so the caller knows what to do:
   * - 'continue' → keep working on current task
   * - 'preempt' → caller should save state and return; controller handles the switch
   * - 'merge' → item was absorbed into current work (caller may inject into session)
   */
  async checkYieldPoint(): Promise<{
    decision: DecisionType;
    item?: MailboxItem;
    reasoning?: string;
  }> {
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
      return { decision: 'preempt', item: newItem, reasoning };
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
      const validDecisions: DecisionType[] = ['continue', 'preempt', 'merge', 'defer'];
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

    return [
      'You are deciding how to handle a new incoming item in your mailbox.',
      'CRITICAL RULE: Human messages (human_chat) and human comments ALWAYS take priority over all other work.',
      '',
      `CURRENT FOCUS: [${currentItem.sourceType}] priority=${currentItem.priority}`,
      `  "${currentItem.payload.summary}"`,
      `  Task: ${currentItem.payload.taskId ?? 'none'}`,
      '',
      `NEW ITEM: [${newItem.sourceType}] priority=${newItem.priority}`,
      `  "${newItem.payload.summary}"`,
      `  Task: ${newItem.payload.taskId ?? 'none'}`,
      '',
      `FULL QUEUE (${this.mailbox.depth} items):`,
      queueSection,
      '',
      'RECENT DECISIONS:',
      recentDecs || '(none)',
      '',
      'Choose exactly one: continue | preempt | merge | defer',
      'Reply with ONLY the decision word, nothing else.',
    ].join('\n');
  }

  // ─── Triage ─────────────────────────────────────────────────────────────────

  /**
   * Determine whether LLM triage is actually needed.
   *
   * Priority queue already handles the clear cases:
   * - headItem is p0 (Critical) and all queued items are p1+ → just process head
   * - headItem has a strictly lower priority number than all queued items → process head
   *
   * LLM triage is needed when:
   * - Multiple items at the same priority level as head (ambiguous ordering)
   * - Or queued items contain a higher-priority item than head (shouldn't happen
   *   with correct priority queue, but defensive check)
   */
  private needsLLMTriage(headItem: MailboxItem): boolean {
    // User chat messages are processed strictly in FIFO order — no triage.
    // The priority queue already surfaced this item; just handle it.
    if (headItem.sourceType === 'human_chat') return false;

    const queued = this.mailbox.getQueuedItems();
    if (queued.length === 0) return false;

    // If any queued item has the same or higher priority as head, LLM should decide
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
        const messages: Array<{ role: string; content: string; toolCalls?: any[]; toolCallId?: string }> = [
          { role: 'system', content: 'You are a mailbox triage assistant. You may call read-only tools to gather context before making your decision. When ready, output ONLY a single JSON object — no explanation, no markdown fences, no <think> tags. Start your response with {' },
          { role: 'user', content: prompt },
        ];

        let iterations = 0;
        while (iterations < TRIAGE_MAX_TOOL_ITERATIONS) {
          const response = await this.triageChatFn(messages, llmTools);

          if (!response.toolCalls?.length) {
            raw = response.content;
            break;
          }

          messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

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

    const activeTasksSection = (ctx as any)?.activeTaskIds?.length
      ? `  Active tasks: ${(ctx as any).activeTaskIds.join(', ')}`
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
      '- Task status updates (task_status_update) are **informational only** — the system handles all side effects automatically. These serve as context for your decisions, not as work items.',
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
        timestamp: this.lastTriageResult.timestamp,
      } : undefined,
    };
  }

  hasInterruptPending(): boolean {
    return this.interruptSignal;
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
