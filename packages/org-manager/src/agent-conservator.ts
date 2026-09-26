/**
 * agent-conservator.ts — 存活安全网统一仲裁器（Conservator）
 *
 * 背景（docs/agent-liveness-redesign.md）：刘利（agt_4e6ddf…）数小时产生 600+ 条心跳签到
 * 的根因之一，是 dirty / stale / stall 三个独立判定器各自为政、兜底回路没有统一仲裁和上限，
 * 形成「每 2 分钟一次」的周期解。本文档把三者收敛为**单一仲裁组件**：
 *
 *   1. 脏判定   —— 无任务却标记 processing（agent-dirty.ts・evaluateDirtyState）
 *   2. 过期判定 —— 心跳 / 活动停滞（agent-stall.ts・evaluateStall：stale-heartbeat）
 *   3. 卡死判定 —— 心跳停摆 / 依赖已死（agent-stall.ts・evaluateStall：dead-dependency）
 *
 * 统一输出唯一动作阶梯（对应设计文档 §三.3）：
 *   ok          → 不动作（健康：idle / 有存活任务 / 显式失败态）
 *   observe     → 可疑但心跳新鲜 / 活动刚起步 → 短窗口观察（不动手、不升级）
 *   wake        → 触发一次廉价唤醒（trigger-heartbeat，非 LLM 巡检）
 *   reconcile   → 清理残留活动并回收 idle（reconcile-idle）
 *   human-review→ 升级人工介入（收敛终点；每 episode 只通知一次）
 *
 * 机制保证（本组件与测试共同承诺）：
 *   · 指数退避 —— 同一 episode 连续动作间隔 = retryBaseMs · 2^(n−1)，封顶 backoffMaxMs，
 *     从时间上排除「每 2 分钟一次」这类周期解；
 *   · 总次数上限 —— 每 episode 动作总数 ≤ maxTotalAttempts，wake 连续 > maxWakeAttempts(=3,
 *     Fix A 合流) 或 reconcile 连续 > maxReconcileAttempts 即升级 human-review；
 *   · 收敛证明 —— 升级只在「动作未能让 agent 脱离 processing-like」（无状态迁移）时发生；
 *     agent 真恢复（status 离开 working 且无活动痕迹）后 episode 释放，可开始新 episode；
 *     心跳宽限内的暂时新鲜【绝不】释放 episode（Fix A：否则 2 分钟风暴）。
 */
import { createLogger } from '@markus/shared';
import type { AgentActivity } from '@markus/shared';
import {
  buildAgentRuntimeInfo,
  type AgentRuntimeInfo,
  type MinimalTask,
} from './agent-runtime.js';
import {
  evaluateDirtyState,
  type AgentDirtyVerdict,
} from './agent-dirty.js';
import {
  evaluateStall,
  type AgentStallVerdict,
} from './agent-stall.js';

const log = createLogger('agent-conservator');

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 同一 episode 两次动作的最短间隔基数：5 分钟后才允许下一次动作（原 RETRY_AFTER_MS）。 */
export const CONSERVATOR_RETRY_AFTER_MS = 5 * 60_000;

/** Fix A 合流：trigger-heartbeat 连续无果次数的上限（= 旧 MAX_TRIGGER_HEARTBEAT_ATTEMPTS）。 */
export const CONSERVATOR_MAX_WAKE_ATTEMPTS = 3;

/** reconcile-idle 连续尝试上限：仍无效果则升级 human-review。 */
export const CONSERVATOR_MAX_RECONCILE_ATTEMPTS = 2;

/** 单 episode 动作总数硬上限（收敛证明兜底：即使分类有误也不允许无限动作）。 */
export const CONSERVATOR_MAX_TOTAL_ATTEMPTS = 6;

/** 退避上限（8 小时）：指数退避不会无限发散。 */
export const CONSERVATOR_BACKOFF_MAX_MS = 8 * 60 * 60 * 1000;

// ─── 配置 ────────────────────────────────────────────────────────────────────

export type ConservatorStage = 'ok' | 'observe' | 'wake' | 'reconcile' | 'human-review';

export type ConservatorAction = 'none' | 'trigger-heartbeat' | 'reconcile-idle' | 'human-review';

export interface ConservatorConfig {
  /** 总开关（feature flag）。false 时 evaluate 恒返回 ok（兜底完全关闭）。 */
  enabled: boolean;
  /** processing 痕迹无真实任务支撑超过该时长判定脏态（对应 dirty.staleAfterMs）。 */
  staleAfterMs: number;
  /** lastHeartbeat 距今小于该值视为存活（对应 dirty.heartbeatGraceMs；宽限内不升级）。 */
  heartbeatGraceMs: number;
  /** 拥有行为的 phase 但无任何进展超过该时长判定 stale-heartbeat（对应 stall.stallAfterMs）。 */
  stallAfterMs: number;
  /** 指数退避基数（两次动作间的最短间隔）。 */
  retryBaseMs: number;
  /** 指数退避封顶。 */
  backoffMaxMs: number;
  /** wake（trigger-heartbeat）连续无果次数上限 → 升级 human-review（Fix A）。 */
  maxWakeAttempts: number;
  /** reconcile（reconcile-idle）连续无果次数上限 → 升级 human-review。 */
  maxReconcileAttempts: number;
  /** 单 episode 动作总次数硬上限（收敛证明的最后一道闸）。 */
  maxTotalAttempts: number;
}

export const DEFAULT_CONSERVATOR_CONFIG: ConservatorConfig = {
  enabled: true,
  staleAfterMs: 5 * 60_000,
  heartbeatGraceMs: 2 * 60_000,
  stallAfterMs: 30 * 60_000,
  retryBaseMs: CONSERVATOR_RETRY_AFTER_MS,
  backoffMaxMs: CONSERVATOR_BACKOFF_MAX_MS,
  maxWakeAttempts: CONSERVATOR_MAX_WAKE_ATTEMPTS,
  maxReconcileAttempts: CONSERVATOR_MAX_RECONCILE_ATTEMPTS,
  maxTotalAttempts: CONSERVATOR_MAX_TOTAL_ATTEMPTS,
};

// ─── 输入与判定结果 ──────────────────────────────────────────────────────────

/** Conservator 的输入视图：兼容扫描（AgentLiveView 子集）与展示（/api/agents 富字段）。 */
export interface ConservatorInput {
  agentId: string;
  /** 原始 AgentStatus（idle / working / offline / error） */
  status: string;
  currentActivity?: AgentActivity | null;
  activeTaskIds?: string[];
  lastHeartbeat?: string;
  lastProgressAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  startedAt?: string;
  currentTaskId?: string;
  tokensUsedToday?: number;
}

/** 扫描所需的最小 agent live-state 视图（对应 agentManager.listAgents() 的字段子集）。 */
export interface ConservatorAgentView {
  agentId: string;
  status: string;
  currentActivity?: { id?: string; type?: string; label?: string; startedAt?: string; taskId?: string } | null;
  activeTaskIds?: string[];
  lastHeartbeat?: string;
  lastProgressAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  currentTaskId?: string;
  tokensUsedToday?: number;
}

/**
 * 统一仲裁判定。`stage` 是唯一动作阶梯位置；`action` 是可直接执行的恢复动作；
 * `dirty` / `stall` / `runtime` 是三个原判定器视图（展示 path 直接透出
 * runtime.stall / runtime.dirty，保持对前端形状完全兼容）。
 */
export interface ConservatorVerdict {
  agentId: string;
  stage: ConservatorStage;
  action: ConservatorAction;
  /** 命中的判据标签（前端/事件定位用） */
  criterion: string;
  reason: string;
  suggestions: string[];
  runtime: AgentRuntimeInfo;
  dirty: AgentDirtyVerdict;
  stall: AgentStallVerdict;
}

/** 可写执行流（execution stream）的可观测条目，形状与旧 DirtyObservation 一致。 */
export interface ConservatorObservation {
  sourceType: 'activity';
  sourceId: string;
  agentId: string;
  type: 'status' | 'text' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentConservatorOptions {
  /** 判定阈值/开关（合并到默认值；enabled=false 时 scan 直接跳过）。 */
  cfg?: Partial<ConservatorConfig>;
  /** 按 taskId 查任务，判断 activeTaskIds 里是否还有存活任务。 */
  getTask: (id: string) => MinimalTask | undefined;
  /** 追加一条可观测事件（落到 execution 流）。失败容忍。 */
  appendExecution: (entry: ConservatorObservation) => void | Promise<void>;
  /** 对 wake/reconcile 执行恢复兜底（注入 trigger-heartbeat / reconcile-idle）。 */
  recover?: (v: ConservatorVerdict) => void | Promise<void>;
  /** 升级到 human-review 时的一次性提示（建议人工介入）。 */
  onNeedsHuman?: (v: ConservatorVerdict) => void | Promise<void>;
}

const LIVE_TASK_STATUSES = new Set(['in_progress', 'review', 'blocked']);

function parseTs(iso?: string): number {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

function okVerdict(v: {
  agentId: string;
  reason: string;
  runtime: AgentRuntimeInfo;
  dirty: AgentDirtyVerdict;
  stall: AgentStallVerdict;
}): ConservatorVerdict {
  return {
    agentId: v.agentId,
    stage: 'ok',
    action: 'none',
    criterion: 'none',
    reason: v.reason,
    suggestions: [],
    runtime: v.runtime,
    dirty: v.dirty,
    stall: v.stall,
  };
}

/**
 * 统一仲裁：把 dirty（脏判定）+ stall（过期/卡死判定）三个原判定器输出融合为
 * 唯一动作阶梯（ok / observe / wake / reconcile / human-review）。
 *
 * 纯函数、无副作用、时钟可注入、输入为 live view（与旧 evaluateDirtyState /
 * evaluateStall 同风格），便于确定性单测。
 */
export function evaluateConservator(
  input: ConservatorInput,
  lookupTask: (taskId: string) => MinimalTask | undefined = () => undefined,
  now: number = Date.now(),
  cfg: ConservatorConfig = DEFAULT_CONSERVATOR_CONFIG,
): ConservatorVerdict {
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const runtime = buildAgentRuntimeInfo(
    {
      agentId: input.agentId,
      status: input.status,
      activeTaskIds: input.activeTaskIds,
      currentTaskId: input.currentTaskId,
      currentActivity: input.currentActivity as never,
      lastHeartbeat: input.lastHeartbeat,
      lastProgressAt: input.lastProgressAt,
      tokensUsedToday: input.tokensUsedToday,
      lastError: input.lastError,
      lastErrorAt: input.lastErrorAt,
    },
    lookupTask,
    nowMs,
  );

  const dirty = evaluateDirtyState(
    {
      agentId: input.agentId,
      status: input.status,
      currentActivity: input.currentActivity as never,
      activeTaskIds: input.activeTaskIds,
      lastHeartbeat: input.lastHeartbeat,
      lastErrorAt: input.lastErrorAt,
    },
    lookupTask,
    nowMs,
    { enabled: cfg.enabled, staleAfterMs: cfg.staleAfterMs, heartbeatGraceMs: cfg.heartbeatGraceMs },
  );
  const stall = evaluateStall({ runtime }, nowMs, { stallAfterMs: cfg.stallAfterMs });

  const base = { agentId: input.agentId, runtime, dirty, stall };

  // 总开关关闭 → 一律 ok（兜底完全关闭，展示视图仍透出）。
  if (!cfg.enabled) return okVerdict({ ...base, reason: 'conservator disabled by config' });

  const status = input.status ?? '';
  const hasActivity = !!input.currentActivity;
  const processingLike = status === 'working' || hasActivity;

  // 非 processing 系：idle / offline / error 显式态 → 不算脏，无需仲裁动作。
  if (!processingLike) {
    return okVerdict({ ...base, reason: `not processing-like (status=${status})` });
  }

  // ── 统一动作阶梯 ─────────────────────────────────────────────────────────
  // 1) 卡死判定：依赖已死仍无限等待 → 无法自动恢复，直接人工介入。排在「有存活任务 → ok」
  //    之前：卡死在已终结依赖上的任务永远不会自行前进，是明确的 stuck（区别于正常等待依赖）。
  if (stall.stalled && stall.stallKind === 'dead-dependency') {
    return {
      ...base,
      stage: 'human-review',
      action: 'human-review',
      criterion: 'dead-dependency',
      reason: stall.stuckReason,
      suggestions: stall.suggestions,
    };
  }

  // 有存活任务 → 真在干活 / 真在等待依赖：剔除（防误杀正常 running/blocked；
  // 含 stale-heartbeat 的长任务 —— 只展示不动作，留给任务级 stale 巡检）。
  const aliveTasks = (input.activeTaskIds ?? []).filter((tid) => {
    const t = lookupTask(tid);
    return t && LIVE_TASK_STATUSES.has(t.status);
  });
  if (aliveTasks.length > 0) {
    return okVerdict({ ...base, reason: `has ${aliveTasks.length} live task(s) — genuinely processing` });
  }

  // 2) 脏判定已给出明确恢复方向（既有 dirty 语义优先）。
  if (dirty.dirty) {
    const criterion = dirty.criterion;
    if (dirty.recovery === 'human-review') {
      return {
        ...base,
        stage: 'human-review',
        action: 'human-review',
        criterion,
        reason: dirty.reason,
        suggestions: dirty.suggestions,
      };
    }
    if (dirty.recovery === 'reconcile-idle') {
      return {
        ...base,
        stage: 'reconcile',
        action: 'reconcile-idle',
        criterion,
        reason: dirty.reason,
        suggestions: dirty.suggestions,
      };
    }
    // dirty.recovery === 'trigger-heartbeat'（注意：此时心跳必然已过期，见 agent-dirty）
    return {
      ...base,
      stage: 'wake',
      action: 'trigger-heartbeat',
      criterion,
      reason: dirty.reason,
      suggestions: dirty.suggestions,
    };
  }

  // 3) 卡死判定：拥有行为的 phase 但长时间无进展 → 短窗口观察（不动手，避免误杀长任务）。
  if (stall.stalled && stall.stallKind === 'stale-heartbeat') {
    return {
      ...base,
      stage: 'observe',
      action: 'none',
      criterion: 'stale-heartbeat',
      reason: stall.stuckReason,
      suggestions: stall.suggestions,
    };
  }

  // 4) 心跳新鲜 / 活动刚起步（未超 staleAfter）→ 给自愈机会，短窗口观察不动手。
  const lh = parseTs(input.lastHeartbeat);
  const hbFresh = !Number.isNaN(lh) && nowMs - lh < cfg.heartbeatGraceMs;
  const actStart = input.currentActivity?.startedAt ? parseTs(input.currentActivity.startedAt) : NaN;
  const actFresh = hasActivity && !Number.isNaN(actStart) && nowMs - actStart < cfg.staleAfterMs;
  if (hbFresh || actFresh) {
    return {
      ...base,
      stage: 'observe',
      action: 'none',
      criterion: hbFresh ? 'fresh-heartbeat' : 'fresh-activity',
      reason: hbFresh
        ? 'processing-like but heartbeat fresh — short observation window, hold off'
        : 'activity just started — within stale window, hold off',
      suggestions: ['保持观察；若 continue processing 无进展再升级'],
    };
  }

  // 5) 兜底：剩余可疑 processing-like（无任务无心跳无活动）→ 廉价唤醒。
  return {
    ...base,
    stage: 'wake',
    action: 'trigger-heartbeat',
    criterion: 'no-heartbeat',
    reason: 'processing-like but no live task, no fresh heartbeat, no fresh activity — trigger cheap wake',
    suggestions: ['触发一次恢复心跳，让 agent 自行核对并回到 idle', '若持续如此，可人工重启该 agent'],
  };
}

// ─── 仲裁引擎 ────────────────────────────────────────────────────────────────

/** 单 agent 的 episode 状态（key = agentId:action）。episode 未脱离 processing-like 不复位。 */
interface EpisodeState {
  /** 已执行动作次数（本 episode 累计，收敛证明：总数硬上限）。 */
  attempts: number;
  /** trigger-heartbeat 连续无果次数（Fix A：> maxWakeAttempts 升级）。 */
  consecutiveWake: number;
  /** reconcile-idle 连续无果次数（> maxReconcileAttempts 升级）。 */
  consecutiveReconcile: number;
  /** 最近一次动作时间。 */
  lastActionAt: number;
  /** 下一次允许动作的时间（指数退避）。 */
  nextAllowedAt: number;
  /** 已通知 human-review（每 episode 一次，避免刷屏）。 */
  humanNotified: boolean;
}

function exponentialBackoffMs(attemptOrdinal: number, cfg: ConservatorConfig): number {
  // attemptOrdinal 从 1 开始：1 → base；2 → 2·base；3 → 4·base … 封顶 backoffMaxMs。
  const exponent = Math.max(0, attemptOrdinal - 1);
  const limit = Math.min(exponent, 24); // 防溢出（2^24 ≈ 194 天，远超封顶 8h）
  return Math.min(cfg.retryBaseMs * Math.pow(2, limit), cfg.backoffMaxMs);
}

/**
 * 周期兜底仲裁器：对每 agent 的 live view 做统一仲裁，按阶梯（observe → wake →
 * reconcile → human-review）推进，并施加指数退避 + 总次数上限 + 收敛证明。
 *
 * 与旧 AgentDirtyReconciler 的区别（重构 1 落地点）：
 *   · 判定收敛：只调用 evaluateConservator（内部融合 dirty/stall/stale）；
 *   · Fix A 合流：3 次 trigger-heartbeat 无果即升级 human-review（不再无限重试）；
 *   · 指数退避：连续动作间隔 ≥ base·2^(n−1)，封顶 8h —— 从时间上排除 2 分钟风暴；
 *   · 收敛保证：单 episode 动作总数 ≤ maxTotalAttempts；agent 未脱离 processing-like
 *     前 episode 永不复位；一旦升级 human-review 只通知一次并停止自动动作。
 */
export class AgentConservator {
  private cfg: ConservatorConfig;
  private timer?: ReturnType<typeof setInterval>;
  private episodes = new Map<string, EpisodeState>();

  constructor(private opts: AgentConservatorOptions) {
    this.cfg = { ...DEFAULT_CONSERVATOR_CONFIG, ...(opts.cfg ?? {}) };
  }

  /** 单轮扫描：逐 agent 仲裁并施加退避/上限，返回本轮触发的动作判定（可观测）。 */
  async scan(agents: ConservatorAgentView[], now: number = Date.now()): Promise<ConservatorVerdict[]> {
    if (!this.cfg.enabled) return [];
    const done: ConservatorVerdict[] = [];
    const seenKeys = new Set<string>();
    const viewById = new Map(agents.map((a) => [a.agentId, a] as const));

    for (const a of agents) {
      const v = evaluateConservator(
        {
          agentId: a.agentId,
          status: a.status,
          currentActivity: a.currentActivity as never,
          activeTaskIds: a.activeTaskIds,
          lastHeartbeat: a.lastHeartbeat,
          lastProgressAt: a.lastProgressAt,
          lastError: a.lastError,
          lastErrorAt: a.lastErrorAt,
          currentTaskId: a.currentTaskId,
          tokensUsedToday: a.tokensUsedToday,
        },
        this.opts.getTask ?? (() => undefined),
        now,
        this.cfg,
      );

      if (v.stage === 'ok' || v.stage === 'observe') {
        // ok/observe：不动作（observe 是短窗口观察）。seenKeys 不含 → 下方释放逻辑只对
        // 真正脱离 processing-like 的 agent 释放 episode。
        continue;
      }

      const key = a.agentId; // 每 agent 一个 episode（收敛证明的收敛单元是 agent，而非动作）
      seenKeys.add(key);
      done.push(v);

      let ep = this.episodes.get(key);
      if (!ep) {
        ep = { attempts: 0, consecutiveWake: 0, consecutiveReconcile: 0, lastActionAt: 0, nextAllowedAt: 0, humanNotified: false };
        this.episodes.set(key, ep);
      }

      // human-review：立即通知一次（不受退避门槛限制 —— degraded / dead-dependency 等
      // 明确需要人工的场景必须第一时间提示；每 episode 一次，避免刷屏）。通知后即收敛，
      // 不再有任何自动动作。
      if (v.stage === 'human-review') {
        if (!ep.humanNotified) {
          ep.humanNotified = true;
          this.observe(a, v);
          if (this.opts.onNeedsHuman) void this.opts.onNeedsHuman(v);
          else log.warn('Conservator: agent needs human review', { agentId: a.agentId, verdict: v });
        }
        continue;
      }

      // 指数退避：未到下次允许时间 → 本轮不动手（但 episode 保留，故障状态延续）。
      if (now < ep.nextAllowedAt) continue;

      // Fix A 合流 + reconcile 上限：连续无果 → 升级 human-review（切断风暴回路）。
      let effective: ConservatorVerdict = v;
      if (v.stage === 'wake') {
        ep.consecutiveWake += 1;
        if (ep.consecutiveWake > this.cfg.maxWakeAttempts) {
          effective = {
            ...v,
            stage: 'human-review',
            action: 'human-review',
            reason: `${v.reason}（已连续 ${ep.consecutiveWake - 1} 次触发恢复心跳仍未脱离 stuck-busy，停止自动兜底）`,
            suggestions: [
              '在 Agent 设置中手动重置/重启该 agent 以清除卡死的 working 状态',
              '检查其真实任务是否早已结束，status 是否被错误钉在 working',
            ],
          };
        }
      } else if (v.stage === 'reconcile') {
        ep.consecutiveReconcile += 1;
        if (ep.consecutiveReconcile > this.cfg.maxReconcileAttempts) {
          effective = {
            ...v,
            stage: 'human-review',
            action: 'human-review',
            reason: `${v.reason}（已连续 ${ep.consecutiveReconcile} 次 reconcile-idle 仍未脱离 processing-like，停止自动兜底）`,
            suggestions: [
              '在 Agent 设置中手动重置/重启该 agent 以清除卡死的 processing 状态',
              '检查其残留活动痕迹与真实任务，必要时手动回收',
            ],
          };
        }
      }

      // 收敛证明：单 episode 动作总数硬上限 → 强制 human-review。
      if (effective.stage !== 'human-review' && ep.attempts + 1 > this.cfg.maxTotalAttempts) {
        effective = {
          ...v,
          stage: 'human-review',
          action: 'human-review',
          reason: `${v.reason}（episode 累计动作已达上限 ${this.cfg.maxTotalAttempts} 次仍未脱离，停止自动兜底）`,
          suggestions: [
            '在 Agent 设置中手动重置/重启该 agent',
            '检查 agent 运行环境（模型/工具/网络）是否持续异常',
          ],
        };
      }

      this.observe(a, effective);
      ep.attempts += 1;
      ep.lastActionAt = now;
      ep.nextAllowedAt = now + exponentialBackoffMs(ep.attempts, this.cfg);

      if (effective.stage === 'human-review') {
        if (!ep.humanNotified) {
          ep.humanNotified = true;
          if (this.opts.onNeedsHuman) void this.opts.onNeedsHuman(effective);
          else log.warn('Conservator: agent needs human review', { agentId: a.agentId, verdict: effective });
        }
      } else if (this.opts.recover) {
        await this.opts.recover(effective);
      }
      // recover 默认无动作（纯观察 + 事件）——安全默认。
    }

    // 释放已恢复（不再 processing-like）的 episode，允许再次变脏时重新开始退避。
    // 注意：仅当 agent 真正脱离 processing-like（status != working 且无活动痕迹）才释放；
    // 心跳宽限窗口内的暂时新鲜不释放（Fix A：防 2 分钟风暴绕过退避）。
    for (const k of [...this.episodes.keys()]) {
      if (seenKeys.has(k)) continue;
      const view = viewById.get(k);
      if (view && (view.status === 'working' || view.currentActivity)) continue; // 仍 processing-like
      this.episodes.delete(k);
    }
    return done;
  }

  /** 开启持续兜底。intervalMs 默认 30s。 */
  start(getAgents: () => ConservatorAgentView[], intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      let list: ConservatorAgentView[];
      try {
        list = getAgents();
      } catch (err) {
        log.warn('conservator scan: getAgents failed', { error: String(err) });
        return;
      }
      this.scan(list)
        .then((handled) => {
          if (handled.length > 0) {
            log.info(`Conservator handled ${handled.length} agent(s)`, {
              handled: handled.map((v) => `${v.agentId}:${v.action}`),
            });
          }
        })
        .catch((err) => log.warn('conservator scan failed', { error: String(err) }));
    }, intervalMs);
    log.info('Agent Conservator started', { intervalMs, enabled: this.cfg.enabled });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private observe(a: ConservatorAgentView, v: ConservatorVerdict): void {
    const entry: ConservatorObservation = {
      sourceType: 'activity',
      sourceId: a.currentActivity?.id ?? a.agentId,
      agentId: a.agentId,
      type: v.stage === 'human-review' ? 'error' : 'status',
      content: `存活仲裁兜底：${v.reason}`,
      metadata: {
        stage: v.stage,
        action: v.action,
        criterion: v.criterion,
        suggestions: v.suggestions,
        at: new Date().toISOString(),
      },
    };
    try {
      void this.opts.appendExecution(entry);
    } catch (err) {
      log.debug('appendExecution failed (best-effort)', { error: String(err) });
    }
  }
}