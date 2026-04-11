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
  MailboxPriorityLevel,
  MAILBOX_TYPE_REGISTRY,
} from '@markus/shared';
import type { EventBus } from './events.js';
import type { AgentMailbox } from './mailbox.js';

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
  private unsubscribeNewItem?: () => void;
  private decisions: AttentionDecision[] = [];

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

    this.loopPromise = this.runLoop();
    log.info('Attention controller started', { agentId: this.agentId });
  }

  /**
   * Stop the attention loop.
   */
  stop(): void {
    this.running = false;
    this.unsubscribeNewItem?.();
    this.unsubscribeNewItem = undefined;
    this.mailbox.cancelWait();
    log.info('Attention controller stopped', { agentId: this.agentId });
  }

  /**
   * Main attention loop. Blocks on mailbox when idle, processes one item
   * at a time, then returns to idle.
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      this.setState('idle');
      this.currentFocus = undefined;
      this.delegate?.onFocusChanged(undefined);

      let item: MailboxItem;
      try {
        item = await this.mailbox.dequeueAsync();
      } catch {
        if (!this.running) break;
        continue;
      }

      if (!this.running) {
        this.mailbox.enqueue(item.sourceType, item.payload, {
          priority: item.priority,
          metadata: item.metadata,
        });
        break;
      }

      const decision = this.recordDecision('pick', item, `Idle, processing ${item.sourceType}`);
      this.delegate?.onDecisionMade(decision);

      await this.processFocusedItem(item);
    }
  }

  /**
   * Process a single mailbox item with full focus.
   */
  private async processFocusedItem(item: MailboxItem): Promise<void> {
    this.setState('focused');
    this.currentFocus = item;
    this.interruptSignal = false;
    this.pendingInterruptItem = undefined;
    this.delegate?.onFocusChanged(item);

    try {
      await this.delegate?.processMailboxItem(item);
    } catch (err) {
      log.warn('Error processing mailbox item', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
        error: String(err),
      });
    } finally {
      this.mailbox.complete(item.id);
      this.currentFocus = undefined;
      this.interruptSignal = false;
      this.pendingInterruptItem = undefined;
    }
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

  /**
   * Fast heuristic decision when no LLM judgment is available.
   * Rules are evaluated top-to-bottom; first match wins.
   */
  /** Types that represent direct user interaction — always highest priority. */
  private static readonly USER_INTERACTION_TYPES: Set<MailboxItemType> = new Set([
    'human_chat', 'task_comment',
  ]);

  heuristicDecision(currentItem: MailboxItem, newItem: MailboxItem): DecisionType {
    const isNewUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(newItem.sourceType);
    const isCurrentUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(currentItem.sourceType);

    // R1: User chat/comments ALWAYS preempt non-user work — users are top priority
    if (isNewUserInteraction && !isCurrentUserInteraction) {
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

    // R3: Requirement update on the focused requirement → merge
    if (
      newItem.sourceType === 'requirement_update' &&
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

    // R5: Status update on the currently focused task → preempt
    //     (external state change: approval, rejection, pause, etc.)
    if (
      newItem.sourceType === 'task_status_update' &&
      newItem.payload.taskId === currentItem.payload.taskId
    ) {
      return 'preempt';
    }

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
      ? queuedItems.map(i => `  - [${i.sourceType}] p${i.priority}: "${i.payload.summary.slice(0, 80)}"`).join('\n')
      : '  (empty)';

    return [
      'You are an attention manager for an AI agent. Decide how to handle a new incoming item.',
      'CRITICAL RULE: User chat (human_chat) and user comments (task_comment) ALWAYS take priority over all other work.',
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
    const newLabel = `${newItem.sourceType}: "${newItem.payload.summary.slice(0, 60)}"`;
    const currentLabel = `${currentItem.sourceType}: "${currentItem.payload.summary.slice(0, 60)}"`;

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
