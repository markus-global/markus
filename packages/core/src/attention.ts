import {
  createLogger,
  generateId,
  type MailboxItem,
  type MailboxItemType,
  type MailboxPriority,
  type AttentionState,
  type AttentionDecision,
  type DecisionType,
  type DecisionSource,
  type DecisionContext,
  type AgentMindState,
  type TriageContext,
  MailboxPriorityLevel,
  routeMailboxItem,
  MAILBOX_ITEM_MAX_RETRIES,
  END_TURN_REPLY_SENTINEL,
  MAILBOX_PROCESSING_TIMEOUT_MS,
  MAILBOX_INACTIVITY_POLL_MS,
  BACKSTOP_CANCEL_GRACE_MS,
  MAILBOX_COALESCE_WINDOW_MS,
  APPROVAL_WAIT_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_DRIFT_THRESHOLD_MS,
  TRIAGE_BACKLOG_THRESHOLD,
  isStrictStateItem,
} from '@markus/shared';
import type { EventBus } from './events.js';
import {
  MAILBOX_LEASE_RENEW_INTERVAL_MS,
  PLATFORM_INTERNAL_SOURCES,
  type AgentMailbox,
} from './mailbox.js';
import { displayLabelOf, bounceReasonOfFailure } from './mailbox-summary.js';
import { createSessionWorkspace, sessionWorkspaceStore, type SessionWorkspace } from './session-workspace.js';

// ─── Abnormal Completion Detection ──────────────────────────────────────────

/**
 * Check whether a mailbox-item turn produced nothing.
 *
 * This layer can only honestly judge ONE thing: whether the turn emitted any output
 * at all. Whether the agent actually *finished its work* is a question only the agent
 * loop can answer — it owns the tool loop and the typed `end_turn` signal. Judging it
 * here is what the old text-marker protocol got wrong: a legitimate turn whose model
 * forgot the magic string was requeued (and eventually dropped) as "incomplete"
 * (8 items in one day, 2026-10-04).
 *
 * Intentional interruptions and typed silences are not abnormal and must never be retried:
 *  - Preempted items return '[preempted]' — the scheduler will re-trigger
 *    background scenarios naturally.
 *  - Cancelled items return '[cancelled]' — the user/controller meant to stop.
 *  - Turns ended via the `end_turn` tool return {@link END_TURN_REPLY_SENTINEL} — a
 *    typed, deliberate silence, which is exactly what completes the item.
 *
 * Returns a reason string when abnormal, `undefined` when the reply is OK.
 */
export function detectAbnormalCompletion(
  reply: string | void,
  item: MailboxItem,
): string | undefined {
  if (!routeMailboxItem(item).invokesLLM) return undefined;

  if (reply === '[preempted]' || reply === '[cancelled]') return undefined;
  if (reply === END_TURN_REPLY_SENTINEL) return undefined;

  // The single honest judgement available here: nothing was produced.
  if (reply === undefined || reply === '') {
    return 'empty reply from LLM-invoking item';
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
  /**
   * Cancel the in-flight processing for `item` — invoked when the backstop
   * timeout fires so the orphaned turn stops before the item is requeued
   * (prevents duplicate tool side effects). Implementations abort the active LLM
   * stream and set the processing cancel flag. Optional for non-agent delegates.
   *
   * `workerId` is the worker that was **holding `item`** when the timeout fired
   * (captured before the race — NOT re-derived from ALS). The call site is a
   * timer callback, so implementations must use this to pick the target turn
   * deterministically; inferring the target from AsyncLocalStorage would fall
   * back to worker 1 and cancel the wrong worker. Handlers may return a promise;
   * a rejection is logged, never fatal.
   */
  cancelProcessing?(item: MailboxItem, workerId?: number): void | Promise<void>;
  evaluateInterrupt(
    currentItem: MailboxItem,
    newItem: MailboxItem,
  ): Promise<DecisionType>;
  /**
   * Provide a per-worker SessionWorkspace in concurrent mode (workerId >= 1).
   * Implementations should return a fresh, cached workspace per worker so each
   * concurrent processing loop gets isolated session state. Undefined falls
   * back to a fresh default workspace for that worker.
   */
  getWorkerWorkspace?(workerId: number): SessionWorkspace | undefined;
  /**
   * 该 item **实际将要运行的记忆会话**，形如 `session:<sess_*>`；无法确定时返回
   * undefined（例如「新会话」——它将独占一个全新会话，无可争夺）。
   *
   * ## 为什么锁键必须来自这里，而不是 item 的 payload（2026-10-22 事故）
   *
   * 实体键由 `resolveEntityKeys` 从 payload **声明**的信息推出。但一个回合真正改写
   * 的资源是「它将要跑进去的那个记忆会话」，这两者可以不重合：
   * `callback_result` 不带任何会话字段 → 退化成 `system:<agentId>` 这把全局键，可它
   * 实际运行在 `this.currentSessionId`（即某个正在跑的聊天会话）里。实测：
   * worker 1 持有 `conv:cs_9809eb…` 跑聊天回合，worker 2 拿到 `system:agt_…` 就在
   * **同一个记忆会话**里并发跑起了后台回调回合 —— 两个回合同时写一份会话记忆，
   * 回调回合还吃掉了聊天回合的收口续跑，产出的话没有任何投递通道（它没有
   * onEvent / responsePromise），用户看到的是一条 0 字回复。
   *
   * 所以锁的**键必须由「回合会跑进哪个会话」决定**，而不是由「消息自称属于谁」
   * 决定。实现必须与 `resolveTurnSession` 用同一套解析（同一个事实、同一个解析点），
   * 否则又是两把量不同资源的尺子。
   */
  sessionLockKey?(item: MailboxItem): string | undefined;
  /**
   * 并发交接钩子（P2c）：worker 处理 item 的关键生命周期事件。
   * - 'declared'：worker 开始处理 item（声明意图，防重复动作）
   * - 'done'：worker 处理完成（沉淀结论 + 遗留）
   * - 'conflict'：worker 处理时检测到与实体锁冲突/目标已被占用
   * Implementations 写入 ConcurrentHandoffLog（持久化），供其他 worker 的 prompt 注入。
   */
  onConcurrentHandoff?(
    kind: 'declared' | 'done' | 'conflict',
    workerId: number,
    item: MailboxItem | undefined,
    summary: string,
  ): void;
}

export interface DecisionPersistence {
  save(decision: AttentionDecision): void;
}


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
/** 单个并发 worker 的可变状态（workerCount=1 时不用，走实例单值字段）。 */
interface AttentionWorkerState {
  workerId: number;
  state: AttentionState;
  focus?: MailboxItem;
  processingStartedAt?: number;
  /**
   * 该 worker 此刻**实际持有**的锁键（认领成功那一刻求值一次，释放时清空）。
   *
   * 为什么存下来而不是查询时再求值：锁键来自 `lockKeysFor(item)`，其中
   * `sessionLockKey` 依赖会话上下文；在别处重新求值就是第二把量不同资源的尺子。
   * 这里存的就是**真正上锁用的那组键**（同一事实、同一执行点）。
   */
  entityKeys?: string[];
  /** worker 定向的用户取消请求（并发模式承载；串行走实例字段）。 */
  userCancelCurrent?: boolean;
}

/**
 * 「此刻谁在干什么」的**权威快照**（唯一在途信号来源）。
 *
 * 只从**实时状态**回答：worker 的 focus + 它真正持有的锁键。**绝不从交接历史反推** ——
 * 历史里的 `declared` 说的是「过去某一刻我开始做过」，把它读成「现在仍被占用」会让别的
 * 分身对着一个早已结束的任务停手（2026-11-17 真机事故：同一会话在同一段并发上下文里
 * 既出现在「正在进行中」又出现在「已完成」，agent 因此宣布「由另一个 worker 处理」并
 * 拒绝接手；Owner 看到的就是「同一个前端里 agent 说被别的 worker 占着」）。
 */
export interface ActiveClaim {
  workerId: number;
  /** 该 worker 真正持有的锁键（至少一个；`system:` 兜底也算）。 */
  entityKeys: string[];
  /** 条目类型（`human_chat` / `task_execution` …）。**不带正文** —— 占用是结构事实，
   * 正文只会把别人的会话内容泄进本会话的 prompt。 */
  itemType: string;
  /** 本回合开始处理的时间戳（epoch ms）。 */
  startedAt: number;
}

export class AttentionController {
  /** 串行模式单值状态（workerCount=1 时与旧行为完全一致）。 */
  private stateStorage: AttentionState = 'idle';
  /** 串行模式 focus 存储（workerCount=1 时 currentFocus 的承载）。 */
  private focusStorage: MailboxItem | undefined;
  /** 并发模式 worker 状态容器。 */
  private workerStates = new Map<number, AttentionWorkerState>();
  /** 并发 worker 数（默认 1 = 串行）。 */
  private workerCount = 1;
  private workerPromises: Promise<void>[] = [];
  private activeWorkerIds = new Set<number>();
  /**
   * 在途处理登记：workerId → 正在执行的 `processMailboxItem` promise。
   *
   * 用途：backstop 超时后的 single-flight 判定 —— 必须先确认上一次尝试
   * 真的结束，才允许把 item 重新入队重跑；否则重跑会与仍在执行的工具
   * 产生重复副作用。键为 workerId（并发模式）或 1（串行模式）。
   */
  private inFlightProcessing = new Map<number, Promise<unknown>>();

  private interruptSignal = false;
  /** Explicit user cancel of the focused item (Cancel button) — not a new-mail preempt.
   * 并发模式按 worker 承载（每 worker 独立 userCancel），避免取消串到其他 worker。 */
  private userCancelCurrentStorage = false;
  private get userCancelCurrent(): boolean {
    if (this.workerCount > 1) return !!this.workerState(this.currentWorkerId()).userCancelCurrent;
    return this.userCancelCurrentStorage;
  }
  private set userCancelCurrent(v: boolean) {
    if (this.workerCount > 1) this.workerState(this.currentWorkerId()).userCancelCurrent = v;
    else this.userCancelCurrentStorage = v;
  }
  private pendingInterruptItem: MailboxItem | undefined;
  private criticalInterruptResolve?: () => void;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private readonly agentId: string;
  private readonly mailbox: AgentMailbox;
  private readonly eventBus: EventBus;
  private delegate?: AttentionDelegate;
  private decisionPersistence?: DecisionPersistence;
  /** Tracks whether the last yield-point decision was 'cancel' vs 'preempt'. */
  private lastYieldDecision?: DecisionType;
  private unsubscribeNewItem?: () => void;
  private decisions: AttentionDecision[] = [];
  /** 冲突策略：auto=实体锁冲突时放回队列错开（默认）；report=冲突时上报并放回。 */
  private conflictPolicy: 'auto' | 'report' = 'auto';
  /** 判定"空闲"的处理 watchdog（ms）。 */
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private watchdogLastTick = Date.now();
  /** 串行模式处理起始时间存储（并发模式走 workerStates）。 */
  private processingStartedAtStorage?: number;
  private waitingForHumanApproval = false;
  /** Backstop window override (test/config); defaults to MAILBOX_PROCESSING_TIMEOUT_MS. */
  private processingTimeoutMs?: number;
  /**
   * 每个 worker 的「最后一次进展」时间戳（ms）。backstop 从「总耗时」改为「无进展」后，
   * 判据是 `now - progressAt[workerId] >= window`：只要还在产出（文本 / tool_start /
   * tool_end / status / error）就永远不判超时，只有真正静默才兜底。进展由 delegate 通过
   * `noteProgress()` 上报（agent 的 activity-log 汇聚点）。
   */
  private progressAt = new Map<number, number>();
  /**
   * Backstop 超时后等待「在途 turn 真正结束」的宽限期。
   * 可用 setBackstopCancelGraceMs 覆盖（测试需要确定性短宽限期）。
   */
  private backstopCancelGraceMs = BACKSTOP_CANCEL_GRACE_MS;

  private static readonly MAX_RECENT_DECISIONS = 50;

  /** True while the runLoop's while-body is executing; false after the loop exits. */
  private loopAlive = false;
  /** Bumped on each launchLoop so a superseded loop exits instead of double-consuming. */
  private loopGeneration = 0;

  // ─── 并发 accessor ───────────────────────────────────────────────────────

  /** 当前 workerId：ALS 上下文内从 SessionWorkspace 拿；否则 1（串行/外部）。 */
  private currentWorkerId(): number {
    return sessionWorkspaceStore.getStore()?.workerId ?? 1;
  }

  private get state(): AttentionState {
    if (this.workerCount > 1) return this.workerState(this.currentWorkerId()).state;
    return this.stateStorage;
  }
  private set state(v: AttentionState) {
    if (this.workerCount > 1) this.workerState(this.currentWorkerId()).state = v;
    else this.stateStorage = v;
  }

  private workerState(workerId: number): AttentionWorkerState {
    let ws = this.workerStates.get(workerId);
    if (!ws) {
      ws = { workerId, state: 'idle' };
      this.workerStates.set(workerId, ws);
    }
    return ws;
  }

  private get currentFocus(): MailboxItem | undefined {
    if (this.workerCount > 1) return this.workerState(this.currentWorkerId()).focus;
    return this.focusStorage;
  }
  private set currentFocus(v: MailboxItem | undefined) {
    if (this.workerCount > 1) this.workerState(this.currentWorkerId()).focus = v;
    else this.focusStorage = v;
  }

  private get processingStartedAt(): number | undefined {
    if (this.workerCount > 1) return this.workerState(this.currentWorkerId()).processingStartedAt;
    return this.processingStartedAtStorage;
  }
  private set processingStartedAt(v: number | undefined) {
    if (this.workerCount > 1) this.workerState(this.currentWorkerId()).processingStartedAt = v;
    else this.processingStartedAtStorage = v;
  }

  /** 任一活跃 worker 的处理起始时间（watchdog 用）。 */
  private anyProcessingStartedAt(): number | undefined {
    if (this.workerCount > 1) {
      for (const st of this.workerStates.values()) if (st.processingStartedAt) return st.processingStartedAt;
      return undefined;
    }
    return this.processingStartedAtStorage;
  }

  /** 活跃 worker 数（watchdog 重启判断 / agent 状态上报用）。 */
  private activeWorkerCount(): number {
    if (this.workerCount > 1) return this.activeWorkerIds.size;
    return this.loopAlive ? 1 : 0;
  }

  /** 聚合状态（并发模式下任一 worker 非 idle 即非空闲）。 */
  private aggregateState(): AttentionState {
    if (this.workerCount > 1) {
      let any = false;
      for (const st of this.workerStates.values()) {
        if (st.state !== 'idle') return 'focused';
        any = true;
      }
      return any ? 'idle' : this.state;
    }
    return this.state;
  }

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
   * C8-B：轮内 delta 注入的决策落账入口。
   *
   * **只做一件事**：把「这条事实推翻了当前回合的前提」写进既有台账
   * （`agent_decisions`，`decision_type='cancel'`）。之所以放在这里而不是
   * 在新模块里直连 repo：`agent_decisions` 的写者**只有一个**
   * （`recordDecision` → `decisionPersistence`），第二个写者会让台账出现两套
   * 语义（谁在什么时机写的）。
   *
   * 返回 `void`：调用方只需要「已落账」这个事实，不需要决策对象。
   */
  recordTurnDeltaDecision(item: MailboxItem, reasoning: string, outcome: string): void {
    this.recordDecision('cancel', item, reasoning, outcome);
  }

  setWaitingForApproval(waiting: boolean): void {
    this.waitingForHumanApproval = waiting;
  }

  /** Override the processing backstop window (ms). Primarily for tests/config. */
  setProcessingTimeoutMs(ms: number): void {
    this.processingTimeoutMs = ms > 0 ? ms : undefined;
  }

  /**
   * 上报「当前 worker 正在产出进展」，重置 inactivity 兜底计时。
   * 由 delegate（agent）在每次 LLM 输出 / 工具调用时调用 —— 与 agent 的
   * `state.lastProgressAt` 是同一语义、同一汇聚点（emitActivityLog）。
   * 无处理进行时写入 1 号 worker 也无害：该键只在对应 worker 处理期间被读取。
   */
  noteProgress(): void {
    this.progressAt.set(this.currentWorkerId(), Date.now());
  }

  /**
   * 覆盖 backstop 超时后的取消宽限期（毫秒）。0 表示不等待（立即判定为「未结束」）。
   * 主要供测试使用；生产走 `BACKSTOP_CANCEL_GRACE_MS` 默认值。
   */
  setBackstopCancelGraceMs(ms: number): void {
    this.backstopCancelGraceMs = Math.max(0, ms);
  }
  /**
   * 设置并发 worker 数（1 = 串行，与旧行为完全一致）。
   * 运行中调用会重启 attention 循环以应用新 worker 数。
   */
  setWorkerCount(n: number): void {
    const count = Math.max(1, Math.min(10, Math.floor(n || 1)));
    if (count === this.workerCount) return;
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.workerCount = count;
    if (wasRunning) this.start();
  }

  /** 当前并发 worker 数。 */
  getWorkerCount(): number {
    return this.workerCount;
  }

  /** 设置冲突策略（auto=自动错开放回，report=冲突时上报）。 */
  setConflictPolicy(policy: 'auto' | 'report'): void {
    this.conflictPolicy = policy;
  }

  /** 当前冲突策略。 */
  getConflictPolicy(): 'auto' | 'report' {
    return this.conflictPolicy;
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
   * Launch (or re-launch) the attention loops with auto-restart on unexpected exit.
   * Serial mode (workerCount=1) launches the single runLoop; concurrent mode
   * launches a pool of worker loops (see launchWorkerPool).
   */
  private launchLoop(): void {
    if (this.workerCount > 1) {
      this.launchWorkerPool();
      return;
    }
    const gen = ++this.loopGeneration;
    // Wake any prior waiter so a superseded loop can exit cleanly.
    this.mailbox.cancelWait();
    this.loopPromise = this.runLoop(gen).catch(err => {
      if (this.running && gen === this.loopGeneration) {
        log.error('Attention loop exited unexpectedly — restarting in 2 s', {
          agentId: this.agentId,
          error: String(err),
          stack: (err as Error)?.stack,
        });
        setTimeout(() => {
          if (this.running && gen === this.loopGeneration) this.launchLoop();
        }, 2000);
      }
    });
  }

  /** 并发模式：启动 N 个 worker 协程；任一异常退出则整体重启。 */
  private launchWorkerPool(): void {
    const gen = ++this.loopGeneration;
    this.mailbox.cancelWait();
    this.workerPromises = [];
    this.activeWorkerIds.clear();
    for (let w = 1; w <= this.workerCount; w++) {
      this.workerState(w); // 预创建 worker 状态
      const p = this.concurrentWorkerLoop(w, gen).catch(err => {
        if (this.running && gen === this.loopGeneration) {
          log.error(`Attention worker ${w} exited unexpectedly — restarting pool in 2 s`, {
            agentId: this.agentId,
            error: String(err),
            stack: (err as Error)?.stack,
          });
          setTimeout(() => {
            if (this.running && gen === this.loopGeneration) this.launchWorkerPool();
          }, 2000);
        }
      });
      this.workerPromises.push(p);
    }
    this.loopPromise = Promise.all(this.workerPromises).then(() => undefined);
    log.info('Attention worker pool started', { agentId: this.agentId, workers: this.workerCount });
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
        const focusedId = this.getCurrentFocus()?.id;
        const processingFor = this.anyProcessingStartedAt()
          ? Math.round((now - this.anyProcessingStartedAt()!) / 1000)
          : 0;
        log.warn('System sleep/wake detected', {
          agentId: this.agentId,
          driftMs: elapsed,
          state: this.aggregateState(),
          focusedItemId: focusedId,
          processingForSec: processingFor,
        });
      }

      // Self-heal: if the loops died while we're still supposed to be running,
      // restart them.  The outer try-catch + launchLoop auto-restart should
      // prevent this, but this is a last-resort safety net.
      if (this.running && this.activeWorkerCount() === 0) {
        log.error('Watchdog: attention loop is dead — restarting', {
          agentId: this.agentId,
          state: this.aggregateState(),
          workers: this.workerCount,
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
      const aggregated = this.aggregateState();
      if (this.running && this.activeWorkerCount() === 0 && (aggregated === 'idle' || aggregated === 'deciding')) {
        try {
          // Mailbox upkeep (defer release / lease reclaim / stale cleanup / ghost
          // purge) is owned by the agent clock now — one owner for time-driven
          // transitions. The watchdog keeps only liveness duties.
          // Self-heal lost-wakeup: idle with a non-empty queue means the loop
          // is parked without having seen the enqueue signal — nudge it.
          if (aggregated === 'idle' && this.mailbox.depth > 0) {
            log.warn('Watchdog: idle with queued mail — nudging attention loop', {
              agentId: this.agentId,
              queueDepth: this.mailbox.depth,
            });
            this.mailbox.nudgeIfPending();
          }
        } catch (err) { log.debug('Triage scoring failed', { error: String(err) }); }
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
  private async runLoop(gen: number): Promise<void> {
    this.loopAlive = true;
    try {
      while (this.running && gen === this.loopGeneration) {
        try {
          this.setState('idle');
          this.currentFocus = undefined;
          this.delegate?.onFocusChanged(undefined);

          // Resurface deferred items that are due before waiting for new work
          try { this.mailbox.resurfaceDue(); } catch (err) { log.debug('Resurface-due failed', { error: String(err) }); }

          let item: MailboxItem;
          try {
            item = await this.mailbox.dequeueAsync();
          } catch {
            // MailboxCancelledError (or any error) while not running → clean exit
            if (!this.running || gen !== this.loopGeneration) break;
            continue;
          }

          // Superseded by a newer launchLoop — put the item back for the new loop.
          if (gen !== this.loopGeneration) {
            try { this.mailbox.putBack(item); } catch { /* ignore */ }
            break;
          }

          if (!this.running) {
            // Re-enqueue so items are not lost on shutdown.
            // human_chat is NOT re-enqueued: its SSE stream is stale after
            // restart and replaying would duplicate the response. The user
            // can resend.
            // Direct a2a_message with a live responsePromise is also dropped
            // (the promise is stale after restart). Group chat a2a_messages
            // (no responsePromise) ARE re-enqueued to avoid silent message loss.
            const hasLiveCallback = item.sourceType === 'a2a_message' && !!item.runtime?.responsePromise;
            if (item.sourceType !== 'human_chat' && !hasLiveCallback) {
              try {
                // P1.x (a)(R2)：**显式复用原行**回队（而不仅仅是重投）。
                //
                // 停机时 item 刚被本实例取走（持久行为 `processing` + `claimed_by` = 本实例），
                // 而 P1 已给 review_request 打上非空幂等键：若无条件 `enqueue(resue)` 新 id，
                // 唯一键会返 false → 该次投递被抑、原行永远停在 processing
                // （重试 < 租约 TTL 延 15min，> TTL 被清成 dropped = 评审永久丢失）。
                // 传 `reuseItemId` 后走 `resolveReinjectDecision` 的「复用原行回队」分支：
                // 不新增行、无条件释放认领、刷新 `queued_at`，返回 `status='queued'`。
                //
                // C9 相邻路径：回队只有**一个**实现（`reEnqueueOnShutdown`），身份表态也在
                // 那里 —— 这里内联一份 `enqueue(...)` 就等于同一件事有两个写者：内联版会漏掉
                // 「复用行继承 work_unit_ref」的声明，被入队守卫直接拒绝（默认行为）
                // （真机探针见 docs/records/cut9-adjacent-identity-paths-2026-11-15.md）。
                this.mailbox.reEnqueueOnShutdown(item);
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

            // 出队顺序由优先级队列唯一决定 —— 这里**不再有 LLM 分拣，也没有分拣回合**。
            // 「先处理哪一条」是队列的不变量（优先级 + 入队序），不是值得花一次带工具的
            // 模型回合去猜的问题。旧实现（2026-11 之前）在 backlog≥2 或同优先级歧义时起
            // 一次带工具的分拣/审议回合，让模型决定 reorder/defer/drop；它既贵（整轮工具
            // 调用）又不可观测（决定只落在日志里），而它想解决的问题（同一实体多条消息）
            // 已经由三层吸收机制在结构上解决了。
            // 记账不在这里做 —— 唯一执行点是 processFocusedItem（两条 loop 的共同下游）。
            await this.processFocusedItem(item);
          } catch (err) {
            const isUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(item.sourceType);
            log.error(`Attention loop iteration failed — ${isUserInteraction ? 'completing' : 'requeueing'} item and continuing`, {
              agentId: this.agentId,
              itemId: item.id,
              type: item.sourceType,
              error: String(err),
            });
            this.currentFocus = undefined;
            this.interruptSignal = false;
            this.pendingInterruptItem = undefined;
            this.lastYieldDecision = undefined;
            if (isUserInteraction) {
              // User-facing items may have already produced partial responses
              // and tool-call side effects — restarting would duplicate them.
              try { this.mailbox.complete(item.id); } catch (err) { log.debug('Failed to complete mailbox item', { id: item.id, error: String(err) }); }
            } else {
              try { this.mailbox.requeue(item); } catch (err) { log.debug('Failed to requeue item', { id: item.id, error: String(err) }); }
            }
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
          this.currentFocus = undefined;
          this.interruptSignal = false;
          this.pendingInterruptItem = undefined;
          this.lastYieldDecision = undefined;
          // Brief delay to prevent tight error loops on persistent failures
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } finally {
      if (gen === this.loopGeneration) this.loopAlive = false;
    }
  }

  /**
   * MailboxItem → 一句话摘要（用于并发交接记录）。
   */
  private describeItem(item: MailboxItem): string {
    const task = item.payload.taskId ?? item.metadata?.taskId;
    const label = `${item.sourceType}: "${displayLabelOf(item)}"`;
    return task ? `${label} [task ${task}]` : label;
  }

  /**
   * 并发 worker 循环（workerCount > 1 时每个 worker 一个协程）。
   *
   * 按方案 A 设计——「并发不打断」：
   * - 每个 worker 是纯消费者：dequeueAsync → 实体锁 → processMailboxItem → 解锁 → 循环；
   * - 不做 triage/deliberation/中断抢占（这些保留给串行模式的 runLoop）；
   * - 实体亲和锁保证同一任务/需求/会话/用户永不并发处理；
   * - 每个 worker 用独立 SessionWorkspace 挂载处理链路（async_hooks 隔离）。
   */
  /**
   * 一个 item 的全部并发锁键 = 实体亲和键 ∪ 「它将跑进去的会话」键。
   *
   * 两者缺一不可：实体键防同一任务/需求/会话被两个 worker 同时改；会话键防两个
   * **不同类型的 item**（如人类消息与后台回调）在同一份记忆会话里并发跑回合。
   * 声明式的实体维度永远推不出后者的存在（payload 里没有这个事实），所以由
   * delegate 用与 `resolveTurnSession` 同一套解析来表态。
   */
  private lockKeysFor(item: MailboxItem): string[] {
    const keys = this.mailbox.entityKeysOf(item);
    const sessionKey = this.delegate?.sessionLockKey?.(item);
    return sessionKey && !keys.includes(sessionKey) ? [...keys, sessionKey] : keys;
  }

  private async concurrentWorkerLoop(workerId: number, gen: number): Promise<void> {
    this.activeWorkerIds.add(workerId);
    const wsState = this.workerState(workerId);
    try {
      while (this.running && gen === this.loopGeneration) {
        wsState.state = 'idle';
        wsState.focus = undefined;
        wsState.processingStartedAt = undefined;

        let item: MailboxItem;
        try {
          item = await this.mailbox.dequeueAsync();
        } catch {
          // MailboxCancelledError（或任何错误）且非 running → 正常退出
          if (!this.running || gen !== this.loopGeneration) break;
          continue;
        }

        // 被更新的 pool 取代 → 放回，退出
        if (gen !== this.loopGeneration) {
          try { this.mailbox.putBack(item); } catch { /* ignore */ }
          break;
        }

        // 已停止：**stop() 之后不得再处理任何 item**。
        //
        // 旧实现只检查 generation，不检查 running —— stop() 刚好落在「dequeue 已返回、
        // 处理还没开始」的窗口里时，这一件仍会被完整跑完（2026-11-08 生产事故：Owner
        // 停止 GEO 团队后 7–13 秒仍有 'handleMessage cancel by higher-priority item'，
        // 界面上看起来「停了又自己起来了两个」）。
        // 放回队列、下次启动再处理：既不丢件，也不让已停止的 agent 再产生任何回合。
        if (!this.running) {
          try { this.mailbox.putBack(item); } catch { /* ignore */ }
          break;
        }

        // 实体亲和锁：取到即锁全部实体维度，处理完必释放（lockEntities 为全有或全无）。
        //
        // 锁键必须**在本 worker 的会话上下文里**求值：`delegate.sessionLockKey` 要回答
        // 「我这一轮会跑进哪个会话」，而 agent 的 `currentSessionId` 是 per-workspace
        // 的（AsyncLocalStorage）。在 ALS 之外求值会读到 rootWorkspace 的指针 —— 所有
        // 没有会话身份的 item（心跳、系统事件）于是共用同一把键，退化成互相排队。
        const workspace = this.delegate?.getWorkerWorkspace?.(workerId) ?? createSessionWorkspace(workerId);
        const entityKeys = sessionWorkspaceStore.run(workspace, () => this.lockKeysFor(item));
        const entityKey = entityKeys[0];
        const holder = item.id;
        if (!this.mailbox.lockEntities(entityKeys, holder)) {
          // 竞态：任一实体维度已被其他 worker 持有 → 放回队列，等锁释放唤醒。
          try { this.mailbox.putBack(item); } catch { /* ignore */ }
          this.delegate?.onConcurrentHandoff?.('conflict', workerId, item, `实体 ${entityKeys.join(', ')} 已被其他分身锁定，暂缓处理并放回队列`);
          if (this.conflictPolicy === 'report') {
            // report 策略：冲突不再静默——发事件让父级感知。
            this.eventBus.emit('agent:entity-conflict', {
              agentId: this.agentId,
              entityKey,
              holder,
              itemId: item.id,
              workerId,
              summary: displayLabelOf(item, 200),
            });
          }
          // auto 与 report 都做轻量退避：避免两个 worker 反复竞抢同一被锁实体
          // 造成忙循环（unlockEntity 的广播唤醒 + 重新入队会立刻再次触发竞态）。
          await new Promise<void>(r => setTimeout(r, 250 + Math.min(item.retryCount ?? 0, 8) * 250));
          continue;
        }

        // 认领成功 = 这组键此刻由本 worker 持有。在途快照（getActiveClaims）读它，
        // 而不是回头从交接历史里推断「谁在干活」。
        wsState.entityKeys = entityKeys;
        this.delegate?.onConcurrentHandoff?.('declared', workerId, item, this.describeItem(item));
        let handoffWritten = false;
        try {
          await sessionWorkspaceStore.run(workspace, async () => {
            wsState.state = 'focused';
            wsState.focus = item;
            wsState.processingStartedAt = Date.now();
            this.delegate?.onFocusChanged(item);
            await this.processFocusedItem(item);
          });
        } catch (err) {
          const isUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(item.sourceType);
          log.error(`Attention worker ${workerId} processing failed — ${isUserInteraction ? 'completing' : 'requeueing'} item`, {
            agentId: this.agentId,
            itemId: item.id,
            type: item.sourceType,
            error: String(err),
          });
          if (isUserInteraction) {
            try { this.mailbox.complete(item.id); } catch { /* ignore */ }
          } else {
            try { this.mailbox.requeue(item); } catch { /* ignore */ }
          }
          this.delegate?.onConcurrentHandoff?.('done', workerId, item, `处理失败（${isUserInteraction ? '已结束' : '已重新入队'}）：${String(err).slice(0, 200)}`);
          handoffWritten = true;
        } finally {
          this.mailbox.unlockEntities(entityKeys, holder);
          wsState.focus = undefined;
          wsState.entityKeys = undefined;
          wsState.processingStartedAt = undefined;
          wsState.state = 'idle';
          this.delegate?.onFocusChanged(undefined);
          if (!handoffWritten) {
            this.delegate?.onConcurrentHandoff?.('done', workerId, item, `处理完成：${this.describeItem(item)}`);
          }
        }
      }
    } finally {
      this.activeWorkerIds.delete(workerId);
      wsState.state = 'idle';
      wsState.focus = undefined;
      wsState.entityKeys = undefined;
    }
  }

  /**
   * Process a single mailbox item with full focus.
   * After processing, validates the result; if the LLM produced an abnormal
   * reply (e.g. raw XML tool-call markup), the item is requeued for retry
   * up to `MAILBOX_ITEM_MAX_RETRIES` times.
   */
  private async processFocusedItem(item: MailboxItem): Promise<void> {
    // 捕获「持有该 item 的 worker」，全程复用这个值（不再二次 currentWorkerId()）。
    // 根因 2：ALS 漂移时重算会删错在途登记键，残留登记使
    // awaitInFlightSettled 永远返回 false；根因 1：定向取消也必须用这个值。
    const workerId = this.currentWorkerId();
    this.setState('focused');
    this.currentFocus = item;
    this.interruptSignal = false;
    this.pendingInterruptItem = undefined;
    this.criticalInterruptResolve = undefined;
    this.lastYieldDecision = undefined;
    this.processingStartedAt = Date.now();
    this.delegate?.onFocusChanged(item);

    // 记账的唯一执行点。串行 runLoop 与并发 concurrentWorkerLoop 都经过这里，
    // 所以「选中并开始处理」只有一个写者。放在任何一条 loop 里，另一条就会静默漏账：
    // 2026-11-18 实测，并发模式下当日 116 条输入只留下 3 条 drop 决策，台账成了拒绝簿。
    const resumeLabel = item.metadata?.isResume ? 'Continuing' : 'Processing';
    // C10-0B §3.3：内部来源（平台唤醒）不落账 —— 此时 `pickDecision` 为 null，
    // 不通知 delegate「有决策」，但本轮处理照常继续。
    const pickDecision = this.recordDecision('pick', item, `${resumeLabel} ${item.sourceType}`);
    if (pickDecision) this.delegate?.onDecisionMade(pickDecision);

    let reply: string | void = undefined;
    let timedOut = false;
    /** backstop 超时后，上一次尝试在宽限期内仍未结束 → 禁止重排（防重复副作用）。 */
    let orphanAbandoned = false;
    /**
     * 处理中途抛出的异常（第六刀 C5）。必须保留它：终态原因要按**真实原因**投影。
     * 只丢掉 reply 而不记住「为什么没有 reply」，就只能靠猜，猜出来的就是那个
     * 会说谎的 `stale_signal` —— 缺字段的报文与过期信号在台账上变成同一件事。
     */
    let processingError: unknown = undefined;
    /** Inactivity backstop 定时器（处理结束 / 超时后清理）。 */
    let backstopTimer: ReturnType<typeof setInterval> | undefined;
    // P0 租约续租：处理期间周期续租。不续租 → 租约到期后该项会被其它 worker
    // （含其它实例）回收重认领 → 同一 item 被两个 worker 重复处理。
    const leaseRenewTimer = setInterval(() => {
      try {
        if (!this.mailbox.renewLease(item.id)) {
          log.warn('Mailbox lease renewal lost during processing', {
            agentId: this.agentId, itemId: item.id, type: item.sourceType,
          });
        }
      } catch (err) {
        log.debug('Mailbox lease renewal threw', { itemId: item.id, error: String(err) });
      }
    }, MAILBOX_LEASE_RENEW_INTERVAL_MS);
    if (typeof leaseRenewTimer.unref === 'function') leaseRenewTimer.unref();
    try {
      // The delegate's processMailboxItem makes LLM calls and shell commands,
      // each of which has its own transport-level timeout. This outer timeout
      // is a generous backstop — by the time it fires, all underlying I/O has
      // surely completed or failed, so requeuing is safe.
      const processing = this.delegate?.processMailboxItem(item);
      if (processing) this.inFlightProcessing.set(workerId, processing);
      const backstopMs = this.waitingForHumanApproval
        ? APPROVAL_WAIT_TIMEOUT_MS
        : (this.processingTimeoutMs ?? MAILBOX_PROCESSING_TIMEOUT_MS);
      // Inactivity backstop (was: total-duration cap). A turn that keeps reporting
      // progress via noteProgress() is never interrupted, however long it runs;
      // only a turn silent for `backstopMs` is treated as hung. Adaptive poll keeps
      // small (test) windows punctual without busy-waiting on production windows.
      const backstopStartedAt = Date.now();
      this.progressAt.set(workerId, backstopStartedAt);
      const pollMs = Math.max(10, Math.min(MAILBOX_INACTIVITY_POLL_MS, Math.floor(backstopMs / 4)));
      const backstop = new Promise<undefined>(resolve => {
        backstopTimer = setInterval(() => {
          const last = this.progressAt.get(workerId) ?? backstopStartedAt;
          if (Date.now() - last >= backstopMs) {
            if (backstopTimer) clearInterval(backstopTimer);
            backstopTimer = undefined;
            resolve(undefined);
          }
        }, pollMs);
        if (typeof backstopTimer.unref === 'function') backstopTimer.unref();
      });
      const result = await Promise.race([
        processing?.then(r => ({ done: true as const, reply: r })),
        backstop.then(() => ({ done: false as const, reply: undefined })),
      ]);
      if (result?.done) {
        reply = result.reply;
      } else {
        timedOut = true;
        // Single-flight guard. The backstop only stops us *waiting* — it must not
        // let a second attempt start while the first may still be executing tools.
        //   1. signal the orphan to abort (cooperative, via the delegate);
        //   2. wait (bounded) for it to actually settle;
        //   3. requeue ONLY if it settled — otherwise complete as `incomplete`,
        //      so the item is never silently re-run on top of live side effects.
        try {
          // 定向：把持有该 item 的 workerId 显式交给 delegate —— 不靠 ALS 推断。
          const cancelled = this.delegate?.cancelProcessing?.(item, workerId);
          if (cancelled && typeof (cancelled as Promise<void>).catch === 'function') {
            void (cancelled as Promise<void>).catch(err => {
              log.warn('cancelProcessing rejected on backstop timeout', {
                agentId: this.agentId,
                itemId: item.id,
                workerId,
                error: String(err),
              });
            });
          }
        } catch (err) {
          // 根因 5：取消失败不再只留 debug —— 必须可见。
          log.warn('cancelProcessing threw on backstop timeout', {
            agentId: this.agentId,
            itemId: item.id,
            workerId,
            error: String(err),
          });
        }
        const orphanSettled = await this.awaitInFlightSettled(workerId, this.backstopCancelGraceMs);
        if (orphanSettled) {
          log.error('Processing exceeded backstop timeout — orphan settled, requeueing', {
            agentId: this.agentId,
            itemId: item.id,
            type: item.sourceType,
            timeoutMs: backstopMs,
          });
        } else {
          orphanAbandoned = true;
          log.error('Processing exceeded backstop timeout — orphan still running; completing as incomplete instead of requeueing', {
            agentId: this.agentId,
            itemId: item.id,
            type: item.sourceType,
            timeoutMs: backstopMs,
            graceMs: this.backstopCancelGraceMs,
          });
        }
      }
    } catch (err) {
      processingError = err;
      log.warn('Error processing mailbox item', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
        error: String(err),
      });
    } finally {
      clearInterval(leaseRenewTimer);
      if (backstopTimer) clearInterval(backstopTimer);
      this.progressAt.delete(workerId);
      // Deregister the in-flight attempt for this worker (the promise may still be
      // pending when abandoned — we simply stop waiting on it).
      // 必须用开始时捕获的 workerId：重算 currentWorkerId() 在 ALS 漂移时会删错键。
      this.inFlightProcessing.delete(workerId);
    }

    this.processingStartedAt = undefined;

    // 终态原因投影（第六刀 C5）：入参校验失败（报文缺必填字段 / 类型不对）不是「陈旧信号」。
    // 只覆盖**失败**族；决策型终态（用户取消 / 主动丢弃）仍走 `drop()` 的默认
    // `stale_signal`，两个方向都不允许「就近使用」。
    const failureReason = bounceReasonOfFailure(processingError, item);

    let statusResolved = false;
    if (timedOut) {
      if (orphanAbandoned) {
        // Visibility + no silent re-run: an orphan we could not stop is exactly
        // the "finished but unfinished" terminal, not a retryable failure.
        // 语义修正：超时未完成 ≠ 完成，标 dropped（异常可见 + 允许补偿重投），
        // 绝不标 completed。
        this.emitIncomplete(
          item,
          'backstop timeout — in-flight turn did not settle within grace; not requeued to avoid duplicate side effects',
        );
        this.mailbox.drop(item.id, undefined, failureReason);
      } else {
        this.mailbox.requeue(item);
      }
      statusResolved = true;
    } else if (reply === '[cancelled]' || this.lastYieldDecision === 'cancel') {
      // 取消（用户显式取消按钮 / 新消息 revoke 当前工作）。
      // 语义修正：被取消 = **异常终态**，标 dropped（红色可见 + 允许补偿重投），
      // 绝不标 completed —— completed 会被 resolveReinjectDecision 判为 settled
      // 而抑制后续同键重投，等于把被取消的工作静默吞掉。
      log.info('Item cancelled — marking dropped (not completed)', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
      });
      this.mailbox.drop(item.id);
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
      const isUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(item.sourceType);

      if (abnormalReason && retries < MAILBOX_ITEM_MAX_RETRIES) {
        if (isUserInteraction) {
          // Empty reply / error for user-facing item — the user already saw
          // partial results and tool calls may have produced side effects.
          // Don't restart; the user can manually retry if needed.
          // 语义修正：一次异常 ≠ 完成，标 dropped（红点可见），用户可手动重试。
          log.warn('Abnormal completion for user interaction — marking dropped without retry', {
            agentId: this.agentId,
            itemId: item.id,
            type: item.sourceType,
            reason: abnormalReason,
          });
          this.emitIncomplete(item, abnormalReason);
          this.mailbox.drop(item.id, undefined, failureReason);
        } else {
          // Empty reply for background type — transient errors may self-correct.
          log.warn('Abnormal completion detected, requeueing for retry', {
            agentId: this.agentId,
            itemId: item.id,
            type: item.sourceType,
            retryCount: retries + 1,
            reason: abnormalReason,
          });
          this.mailbox.requeue(item);
        }
      } else if (abnormalReason) {
        // 重试耗尽后仍异常：异常终态，标 dropped（红点可见 + 允许补偿重投），
        // 不标 completed —— 未明确正常结束的工作没有资格标记为「完成」。
        log.error('Abnormal completion persisted after max retries — marking dropped', {
          agentId: this.agentId,
          itemId: item.id,
          type: item.sourceType,
          retryCount: retries,
          reason: abnormalReason,
        });
        this.emitIncomplete(item, abnormalReason);
        this.mailbox.drop(item.id, undefined, failureReason);
      } else {
        // 正常完成（reply 有效、无异常、agent 明确结束）→ completed 是唯一合法终态。
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

    this.currentFocus = undefined;
    this.interruptSignal = false;
    this.pendingInterruptItem = undefined;
  }

  /**
   * Called when new mail arrives. If idle, the loop handles it via dequeueAsync.
   * If focused, registers an interrupt signal for the next yield point.
   * For critical user messages, also fires the critical-interrupt promise so that
   * long-running tool execution can be aborted early.
   *
   * 并发模式（workerCount > 1）：方案 A —— 不打断忙碌 worker。新邮件靠
   * dequeueAsync 的广播唤醒被空闲 worker 取走；忙碌 worker 不被抢占。
   */
  private onNewMail(): void {
    if (this.workerCount > 1) {
      // 空闲 worker 会被 dequeueAsync 的广播唤醒取走新邮件；这里无需中断信号。
      return;
    }

    if (this.state === 'idle') {
      return;
    }

    if (this.state === 'focused' || this.state === 'deciding') {
      this.interruptSignal = true;
      const peeked = this.mailbox.peek();
      if (peeked) {
        this.pendingInterruptItem = peeked;

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

  /**
   * User clicked Cancel on the current focused mailbox item (Agent Profile).
   * Forces the next yield point to return `cancel` so non-stream work
   * (heartbeat / handleMessage) actually stops — not only SSE streams.
   */
  requestUserCancelCurrent(): void {
    if (!this.currentFocus) return;
    this.userCancelCurrent = true;
    this.interruptSignal = true;
    log.info('User cancel requested for current focus', {
      agentId: this.agentId,
      itemId: this.currentFocus.id,
      type: this.currentFocus.sourceType,
    });
  }

  /** 并发模式：查找持有指定 mailbox item 的 workerId（串行始终返回 1）。 */
  findWorkerByItemId(itemId: string): number | undefined {
    if (this.workerCount <= 1) return 1;
    for (const [wid, ws] of this.workerStates) {
      if (ws.focus?.id === itemId) return wid;
    }
    return undefined;
  }

  /**
   * 并发模式：按会话定位持有该会话的 workerId（串行始终返回 1）。
   * 匹配 focus 的 metadata.sessionId / dbSessionId / payload.extra.sessionId。
   * 用于外部 HTTP 线程按 session 定向取消，避免取消错对象。
   */
  findWorkerBySessionId(sessionId: string): number | undefined {
    if (this.workerCount <= 1) return 1;
    for (const [wid, ws] of this.workerStates) {
      const f = ws.focus;
      if (!f) continue;
      if (f.metadata?.sessionId === sessionId
        || f.metadata?.dbSessionId === sessionId
        || f.payload?.extra?.sessionId === sessionId) return wid;
    }
    return undefined;
  }

  /**
   * 诊断/测试：当前登记了在途处理 promise 的 workerId 列表。
   * 正常收敛（无残留登记）时应为空 —— 用于回护根因 2（ALS 漂移删错键）。
   */
  getInFlightWorkerIds(): number[] {
    return [...this.inFlightProcessing.keys()];
  }

  /**
   * 诊断/测试：某 worker 当前的 focus item（并发模式不看 ALS 上下文）。
   * 串行模式返回唯一的 focus。
   */
  getWorkerFocus(workerId: number): MailboxItem | undefined {
    if (this.workerCount > 1) return this.workerStates.get(workerId)?.focus;
    return this.focusStorage;
  }

  /**
   * **此刻正在处理中的** claim 快照 —— 并发上下文的权威在途信号（唯一来源）。
   *
   * 语义边界：只包含「已拿到实体锁、正在跑回合」的 worker。排队中的 item、空闲
   * worker、以及**交接历史**都不在其中。历史只能回答「过去发生过什么」，把它当
   * 在途信号就会产出「同一实体既在进行中又已完成」的自相矛盾提示。
   */
  getActiveClaims(): ActiveClaim[] {
    if (this.workerCount <= 1) {
      const focus = this.focusStorage;
      if (!focus || this.stateStorage !== 'focused') return [];
      return [{
        workerId: 1,
        entityKeys: [...this.mailbox.entityKeysOf(focus)],
        itemType: focus.sourceType,
        startedAt: this.processingStartedAtStorage ?? 0,
      }];
    }
    const out: ActiveClaim[] = [];
    for (const [wid, ws] of this.workerStates) {
      if (ws.state !== 'focused' || !ws.focus) continue;
      out.push({
        workerId: wid,
        // 兜底：极端情况下（旧 worker 状态对象）没有存锁键，用同一纯函数重算一次，
        // 仍然不是「另一把尺子」——两者同源。
        entityKeys: [...(ws.entityKeys ?? this.mailbox.entityKeysOf(ws.focus))],
        itemType: ws.focus.sourceType,
        startedAt: ws.processingStartedAt ?? 0,
      });
    }
    return out.sort((a, b) => a.workerId - b.workerId);
  }

  /**
   * 诊断/测试：某 worker 的定向用户取消标志（并发模式不看 ALS 上下文）。
   * 定向取消的断言就靠它 —— 「只置位目标 worker」必须可观测。
   */
  getWorkerUserCancel(workerId: number): boolean {
    if (this.workerCount > 1) return !!this.workerStates.get(workerId)?.userCancelCurrent;
    return this.userCancelCurrentStorage;
  }

  /**
   * 诊断/测试：某 worker 的状态快照（state / focus item id / 定向取消标志）。
   * 串行模式（workerCount=1）返回实例单值快照。
   */
  getWorkerSnapshot(workerId: number): { state: AttentionState; focusItemId?: string; userCancelCurrent: boolean } | undefined {
    if (this.workerCount <= 1) {
      return {
        state: this.stateStorage,
        focusItemId: this.focusStorage?.id,
        userCancelCurrent: this.userCancelCurrentStorage,
      };
    }
    const ws = this.workerStates.get(workerId);
    if (!ws) return undefined;
    return { state: ws.state, focusItemId: ws.focus?.id, userCancelCurrent: !!ws.userCancelCurrent };
  }

  /**
   * 按 worker 定向取消（并发模式）。直接对该 worker 的取消状态置位，
   * 不依赖 ALS 上下文——外部 HTTP 线程也能精确命中持有目标 item 的 worker。
   * 返回是否命中（worker 存在且正在处理 focus）。
   */
  requestUserCancelForWorker(workerId: number): boolean {
    const ws = this.workerCount > 1 ? this.workerStates.get(workerId) : undefined;
    const focus = ws?.focus;
    if (!focus) return false;
    ws!.userCancelCurrent = true;
    this.interruptSignal = true;
    log.info('User cancel requested for worker', {
      agentId: this.agentId,
      workerId,
      itemId: focus.id,
      type: focus.sourceType,
    });
    return true;
  }

  /** Clear a pending user-cancel flag (e.g. after the focused item finishes). */
  clearUserCancelCurrent(): void {
    this.userCancelCurrent = false;
  }

  /**
   * A3: emit a structured `agent:incomplete` event when a mailbox item completes
   * without finishing cleanly (an empty/abnormal reply accepted without retry).
   * Visibility only — does not change retry semantics.
   */
  /**
   * 等待某 worker 的在途处理 promise 结束（有界等待）。
   *
   * 返回 `true` = 已在 `timeoutMs` 内结束（item 可安全重排重跑）；
   * 返回 `false` = 仍在运行（**不可**重排，否则会重复副作用）。
   * 无登记（无 delegate / 已结束）视为已结束。
   */
  private async awaitInFlightSettled(workerId: number, timeoutMs: number): Promise<boolean> {
    const inFlight = this.inFlightProcessing.get(workerId);
    if (!inFlight) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      // 无论成功还是抛错，只要 settle 就算结束（异常路径不重排也没意义）。
      return await Promise.race([
        inFlight.then(() => true, () => true),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private emitIncomplete(item: MailboxItem, reason: string): void {
    // 用户可见性：以前这里只发事件，而 human_chat 的 `agent:incomplete` 没有任何 UI
    // 消费者（只有 CLI 恢复任务与 task-service 的特定 reason 在听），于是「一轮被超时
    // 取消」对用户完全不可见——他只看得到半截回复，也不知道可以重试。这里先把事实明确
    // 记到日志（哪条消息 / 哪个会话 / 什么原因），而不是只留一个没人听的 debug 事件。
    log.warn('Mailbox item completed as incomplete', {
      agentId: this.agentId,
      itemId: item.id,
      type: item.sourceType,
      sessionId: (item.payload?.extra as { sessionId?: string } | undefined)?.sessionId,
      taskId: item.payload?.taskId,
      reason,
    });
    try {
      this.eventBus.emit('agent:incomplete', {
        agentId: this.agentId,
        itemId: item.id,
        type: item.sourceType,
        taskId: item.payload?.taskId,
        reason,
      });
    } catch (err) {
      // 事件发不出去也要可见：静默吞掉这里会让「有轮失败了」彻底消失。
      log.warn('Failed to emit agent:incomplete', { itemId: item.id, error: String(err) });
    }
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
    // Explicit Cancel button — stop current focus immediately (before new-mail logic).
    if (this.userCancelCurrent && this.currentFocus) {
      this.userCancelCurrent = false;
      this.interruptSignal = false;
      this.lastYieldDecision = 'cancel';
      return {
        decision: 'cancel',
        reasoning: 'User cancelled current processing',
      };
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
    // 谁拍板的，必须和判断本身一起落账。降级到启发式时如实标 heuristic ——
    // 让平台的规则判断在台账上冒充模型判断，是「行为不可解释」的直接来源。
    let source: DecisionSource = this.delegate ? 'model' : 'heuristic';
    try {
      decisionType = this.delegate
        ? await this.delegate.evaluateInterrupt(this.currentFocus, newItem)
        : this.heuristicDecision(this.currentFocus, newItem);
    } catch (err) {
      log.debug('Delegate evaluateInterrupt failed, falling back to heuristic', { error: String(err) });
      decisionType = this.heuristicDecision(this.currentFocus, newItem);
      source = 'heuristic';
    }

    this.setState('focused');

    // 严格状态管理事件（正式任务执行/评审/收尾动作）绝不能 defer：持久化会丢失 onLog
    // 等闭包，resurface 后无法真正执行 → 任务卡死在 in_progress。
    //
    // 否决在**记账之前**算完，台账只留一条最终判断。旧实现先记一条 defer、再记一条
    // 启发式改判：同一件事两个写者，读台账的人分不清哪条作数。折叠后分支块也不再重复。
    let overrode: DecisionType | undefined;
    if (decisionType === 'defer' && isStrictStateItem(newItem)) {
      log.info('Refusing to defer strict state item — falling back to heuristic', {
        agentId: this.agentId,
        itemId: newItem.id,
        type: newItem.sourceType,
        taskId: newItem.payload.taskId,
      });
      overrode = decisionType;
      decisionType = this.heuristicDecision(this.currentFocus, newItem);
      source = 'heuristic';
    }

    const reasoning = this.formatDecisionReasoning(decisionType, this.currentFocus, newItem);
    const decision = this.recordDecision(decisionType, newItem, reasoning, undefined, source, overrode);
    if (decision) this.delegate?.onDecisionMade(decision);

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

  private static readonly USER_INTERACTION_TYPES: Set<MailboxItemType> = new Set([
    'human_chat',
  ]);

  /** Peer interaction types that preempt background work but not human chat. */
  private static readonly PEER_INTERACTION_TYPES: Set<MailboxItemType> = new Set([
    'a2a_message',
  ]);

  /**
   * Fast heuristic decision table — evaluated top-to-bottom, first match wins.
   *
   * | Rule | Condition                                      | Decision  |
   * |------|------------------------------------------------|-----------|
   * | R0   | Same user, same session, both human_chat       | merge     |
   * | R0x  | New human_chat is explicit NEW session          | continue  |
   * | R1   | New is human_chat, current is not              | preempt   |
   * | R1.5 | New is a2a_message, current is background      | preempt   |
   * | R2   | task_comment on same taskId as current          | merge     |
   * | R3   | requirement update/comment on same requirement  | merge     |
   * | R4   | New priority is critical, current is not        | preempt   |
   * | R6   | New has strictly higher priority (lower number) | preempt   |
   * | R8   | Same priority, current is background/system     | preempt   |
   * | R9   | New is mention, current priority >= normal      | preempt   |
   * | --   | Otherwise                                       | continue  |
   */
  heuristicDecision(currentItem: MailboxItem, newItem: MailboxItem): DecisionType {
    const isNewUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(newItem.sourceType);
    const isCurrentUserInteraction = AttentionController.USER_INTERACTION_TYPES.has(currentItem.sourceType);

    // R0: Same-user follow-up during active chat → merge (inject into session)
    // This lets the user send multiple messages without each one preempting the previous.
    // Only merge if in the SAME session — different sessions should queue independently
    // so the agent processes them sequentially with correct context.
    // Skip merge when the current stream is being cancelled (user aborted) —
    // the new message should be processed as a fresh turn after cancellation.
    // 显式新会话信号（extra.sessionRestore === null，即用户点了「新对话」）在任何情况
    // 下都绝不 merge —— 该消息属于独立会话，必须排队等当前流完成后再单独处理。
    if (
      newItem.sourceType === 'human_chat' &&
      currentItem.sourceType === 'human_chat' &&
      (newItem.payload?.extra as { sessionRestore?: unknown } | undefined)?.sessionRestore === null
    ) {
      return 'continue';
    }
    if (
      newItem.sourceType === 'human_chat' &&
      currentItem.sourceType === 'human_chat' &&
      newItem.metadata?.senderId &&
      newItem.metadata.senderId === currentItem.metadata?.senderId &&
      !(currentItem.payload.extra?.cancelToken as { cancelled?: boolean } | undefined)?.cancelled
    ) {
      // Only merge if both items belong to the same session (or session is unknown)
      const newSession = newItem.metadata?.dbSessionId as string | undefined;
      const currentSession = currentItem.metadata?.dbSessionId as string | undefined;
      if (!newSession || !currentSession || newSession === currentSession) {
        return 'merge';
      }
      // Different sessions: don't merge — queue behind current item
      return 'continue';
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

    // R8: Same priority but current is background/system work → preempt
    // (R7 was removed — it was redundant with R1 which already handles human_chat preempting all non-human work)
    if (
      newItem.priority === currentItem.priority &&
      routeMailboxItem(currentItem).backgroundWork
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

  // ─── State & Queries ──────────────────────────────────────────────────────

  getState(): AttentionState {
    if (this.workerCount > 1) return this.aggregateState();
    return this.state;
  }

  /**
   * 当前 focus。串行模式返回唯一的 focus；并发模式返回当前 worker
   * （ALS 上下文）的 focus，外部调用无 ALS 上下文时返回 worker 1 的 focus。
   */
  getCurrentFocus(): MailboxItem | undefined {
    return this.currentFocus;
  }

  getRecentDecisions(limit = 20): AttentionDecision[] {
    return this.decisions.slice(-limit);
  }

  getMindState(): AgentMindState {
    const queued = this.mailbox.getQueuedItems();
    const state = this.workerCount > 1 ? this.aggregateState() : this.state;
    return {
      attentionState: state,
      currentFocus: this.currentFocus
        ? {
            mailboxItemId: this.currentFocus.id,
            type: this.currentFocus.sourceType,
            label: displayLabelOf(this.currentFocus),
            startedAt: this.currentFocus.startedAt ?? this.currentFocus.queuedAt,
            taskId: this.currentFocus.payload.taskId,
          }
        : undefined,
      mailboxDepth: queued.length,
      queuedItems: queued.map(i => ({
        id: i.id,
        sourceType: i.sourceType,
        priority: i.priority,
        summary: displayLabelOf(i),
        queuedAt: i.queuedAt,
        isStrictState: isStrictStateItem(i),
      })),
      deferredItems: [],
      recentDecisions: this.decisions.slice(-10),
    };
  }

  deferItem(itemId: string, reason: string, deferUntilMs?: number): boolean {
    const item = this.mailbox.getById(itemId);
    if (!item || item.status !== 'queued') return false;
    if (item.sourceType === 'human_chat') return false;
    this.mailbox.defer(itemId, deferUntilMs ? new Date(Date.now() + deferUntilMs).toISOString() : undefined);
    const decision = this.recordDecision('defer', item, reason);
    if (decision) this.delegate?.onDecisionMade(decision);
    return true;
  }

  dropItem(itemId: string, reason: string): boolean {
    const item = this.mailbox.getById(itemId);
    if (item) {
      if (item.status !== 'queued') return false;
      if (item.sourceType === 'human_chat') return false;
      this.mailbox.drop(itemId);
      const decision = this.recordDecision('drop', item, reason);
      if (decision) this.delegate?.onDecisionMade(decision);
      return true;
    }
    // Ghost / already-handled: not in the live queue. Force-drop in persistence
    // so the agent stops looping on "Item not found" for stale IDs.
    // C3：`dropped` 已不是取值域 —— 合成占位项用 `bounced`（它确实是一个退信）。
    this.mailbox.drop(itemId);
    const decision = this.recordDecision('drop', {
      id: itemId,
      agentId: this.agentId,
      sourceType: 'system_event',
      priority: 4,
      status: 'bounced',
      payload: { summary: `Ghost/orphan drop: ${reason}`, content: reason },
      metadata: {},
      queuedAt: new Date().toISOString(),
    }, reason);
    if (decision) this.delegate?.onDecisionMade(decision);
    return true;
  }

  prioritizeItem(itemId: string, newPriority: number): boolean {
    const item = this.mailbox.getById(itemId);
    if (!item || item.sourceType === 'human_chat') return false;
    return this.mailbox.updatePriority(itemId, newPriority);
  }

  hasInterruptPending(): boolean {
    // 并发模式无中断信号（方案 A）。
    if (this.workerCount > 1) return false;
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
    outcome?: string,
    source: DecisionSource = 'rule',
    overrode?: DecisionType,
  ): AttentionDecision | null {
    // ── C10-0B §3.3：平台内部唤醒不产生决策行 ───────────────────────────────
    //
    // `PLATFORM_INTERNAL_SOURCES`（heartbeat / system_event / …）本质**没有实体**：
    // 它们是平台唤醒信号，不是「关于某项工作的决策」，也没有回合身份可以挂在行上。
    // 给它们写一条 `work_unit_ref IS NULL` 的决策行，等于把台账变成一本
    // 「谁都没身份」的拒绕簿 —— 真机 1093/1106 的 leak 就是这些行。
    //
    // 在**唯一写者**处拒绝，而不是在每个 pick 调用点各判一次：不得合成的判定
    // 只能有一个执行点，否则下一条 loop 会又多一份。
    //
    // 注意：不落账 ≠ 不处理。item 照常被 pick、照常进 `processMailboxItem`；
    // 只是没有“决策”这个副作用。（决策 ≠ 动作）
    if (PLATFORM_INTERNAL_SOURCES.has(item.sourceType)) return null;

    const decision: AttentionDecision = {
      id: generateId('dec'),
      agentId: this.agentId,
      decisionType: type,
      mailboxItemId: item.id,
      context: {
        currentFocusType: this.currentFocus?.sourceType,
        currentFocusLabel: this.currentFocus ? displayLabelOf(this.currentFocus) : undefined,
        currentFocusItemId: this.currentFocus?.id,
        mailboxDepth: this.mailbox.depth,
        queuedItemTypes: this.mailbox
          .getQueuedItems()
          .map(i => i.sourceType),
      },
      reasoning,
      // ①-2：把邮箱行的身份带进决策台账。
      // 不带的话，「谁在哪个回合撤销了什么」只能靠 mailbox_item_id 反推 ——
      // 而邮箱行会被 TTL 清理/实体合并，反查链会断在中间。
      workUnitRef: item.workUnitRef ?? null,
      // 谁拍板的。缺了它，规则做的不可逆动作和模型深思后的判断在台账上长得一样。
      source,
      ...(overrode ? { overrode } : {}),
      createdAt: new Date().toISOString(),
      // C8-B：副作用已在回合内发生时，outcome 必须在**落库之前**就带上——
      // 先 save 再补字段等于写两次（第二次没人读，读到的永远是 null）。
      ...(outcome ? { outcome } : {}),
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
    const newLabel = `${newItem.sourceType}: "${displayLabelOf(newItem)}"`;
    const currentLabel = `${currentItem.sourceType}: "${displayLabelOf(currentItem)}"`;

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
