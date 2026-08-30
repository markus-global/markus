/**
 * agent-dirty-reconciler.ts — OB-3 无任务「处理中」脏态的周期兜底清理（O 域可观测性）
 *
 * 作用：周期性扫描所有 agent 的 live state，用「无真实任务却标记为 processing」的判据识别
 * 遗留脏态；对可自动恢复的（reconcile-idle / trigger-heartbeat）触发恢复兜底，并把「谁 /
 * 何时 / 为何被清理」写入执行流（execution stream）供前端与日志追溯；对无法自动处理的
 * （human-review）给出明确提示与建议动作。
 *
 * O 域红线：本器只做 agent 运行态脏标记的识别与兜底事件，不改任务调度/依赖推进逻辑。
 * 安全：feature flag（enabled）可整体关闭；对非脏态永远无副作用；同一 agent 恢复后再次
 * 变脏才重新兜底（去重，不重复刷屏）。
 */
import { createLogger } from '@markus/shared';
import {
  evaluateDirtyState,
  DEFAULT_DIRTY_CONFIG,
  type AgentDirtyConfig,
  type AgentDirtyVerdict,
  type MinimalTaskForDirty,
} from './agent-dirty.js';

const log = createLogger('agent-dirty-reconciler');

/** 同一脏态两次兜底尝试的最短间隔：失败后 5 分钟再试，给 agent 自愈时间又不会永久放弃。 */
export const RETRY_AFTER_MS = 5 * 60_000;

/** 扫描所需的最小 agent live-state 视图（对应 agentManager.listAgents() 的字段）。 */
export interface AgentLiveView {
  agentId: string;
  status: string;
  currentActivity?: { id?: string; type?: string; label?: string; startedAt?: string; taskId?: string } | null;
  activeTaskIds?: string[];
  lastHeartbeat?: string;
  lastErrorAt?: string;
}

/** 写入执行流（execution stream）的可观测条目 */
export interface DirtyObservation {
  sourceType: 'activity';
  sourceId: string;
  agentId: string;
  type: 'status' | 'text' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface DirtyReconcilerOptions {
  /** 判定阈值/开关（合并到默认值；enabled=false 时扫描直接跳过）。 */
  cfg?: Partial<AgentDirtyConfig>;
  /** 按 taskId 查任务，用于判断 activeTaskIds 里是否还有存活任务。 */
  getTask: (id: string) => MinimalTaskForDirty | undefined;
  /** 追加一条可观测事件（落到 execution 流，前端/日志可追溯）。失败容忍。 */
  appendExecution: (entry: DirtyObservation) => void | Promise<void>;
  /**
   * 对脏态执行恢复兜底。默认（不传）仅为观察 + 可观测事件；线上可注入「触发恢复心跳」
   * 让健康的 agent 自愈（不入侵 core 状态机）。
   */
  recover?: (v: DirtyVerdict) => void | Promise<void>;
  /** 对「无法自动处理」的脏态的一次性提示（建议人工介入）。默认仅日志告警。 */
  onNeedsHuman?: (v: DirtyVerdict) => void | Promise<void>;
}

type DirtyVerdict = Extract<AgentDirtyVerdict, { dirty: true }>;

export class AgentDirtyReconciler {
  private cfg: AgentDirtyConfig;
  private timer?: ReturnType<typeof setInterval>;
  /** 已兜底过的脏 key（agentId:recovery）→ 最近一次尝试时间。 */
  private attempted = new Map<string, number>();

  constructor(private opts: DirtyReconcilerOptions) {
    this.cfg = { ...DEFAULT_DIRTY_CONFIG, ...opts.cfg };
  }

  /** 单轮扫描：对给定的 agent 视图逐一出脏态判定并兜底，返回本次新的脏态判定。 */
  async scan(agents: AgentLiveView[], now: number = Date.now()): Promise<DirtyVerdict[]> {
    if (!this.cfg.enabled) return [];
    const done: DirtyVerdict[] = [];
    const seenKeys = new Set<string>();

    for (const a of agents) {
      const v = evaluateDirtyState(
        {
          agentId: a.agentId,
          status: a.status,
          currentActivity: a.currentActivity as never,
          activeTaskIds: a.activeTaskIds,
          lastHeartbeat: a.lastHeartbeat,
          lastErrorAt: a.lastErrorAt,
        },
        this.opts.getTask ?? (() => undefined),
        now,
        this.cfg,
      );
      if (!v.dirty) continue;
      done.push(v);

      const key = `${a.agentId}:${v.recovery}`;
      seenKeys.add(key);

      // 去重但可重试：同一脏态在 RETRY 窗口内不重复触发；超窗后仍未恢复 → 允许再次尝试，
      // 避免「一次 recover 失败 → 永久不再兜底」（此前 Set 去重导致脏 agent 永远卡死）。
      const lastAt = this.attempted.get(key);
      if (lastAt !== undefined && now - lastAt < RETRY_AFTER_MS) continue;
      this.attempted.set(key, now);

      // 可观测：写一条执行流事件（谁/何时/为何/建议）。
      this.observe(a, v);

      if (v.recovery === 'human-review') {
        if (this.opts.onNeedsHuman) void this.opts.onNeedsHuman(v);
        else log.warn('Dirty agent needs human review', { agentId: a.agentId, verdict: v });
      } else if (this.opts.recover) {
        await this.opts.recover(v);
      }
      // recover 默认无动作（纯观察 + 事件）——安全默认。
    }

    // 释放已恢复（不再脏）的 key，允许再次变脏时立即重新兜底。
    for (const k of [...this.attempted.keys()]) {
      if (!seenKeys.has(k)) this.attempted.delete(k);
    }
    return done;
  }

  /** 开启持续兜底。intervalMs 默认 30s。 */
  start(getAgents: () => AgentLiveView[], intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      let list: AgentLiveView[];
      try {
        list = getAgents();
      } catch (err) {
        log.warn('agent-dirty scan: getAgents failed', { error: String(err) });
        return;
      }
      this.scan(list)
        .then((handled) => {
          if (handled.length > 0) {
            log.info(`Dirty reconciler handled ${handled.length} agent(s)`, {
              handled: handled.map((v) => `${v.agentId}:${v.recovery}`),
            });
          }
        })
        .catch((err) => log.warn('agent-dirty scan failed', { error: String(err) }));
    }, intervalMs);
    log.info('Agent dirty reconciler started', { intervalMs, enabled: this.cfg.enabled });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private observe(a: AgentLiveView, v: DirtyVerdict): void {
    const entry: DirtyObservation = {
      sourceType: 'activity',
      sourceId: a.currentActivity?.id ?? a.agentId,
      agentId: a.agentId,
      type: v.recovery === 'human-review' ? 'error' : 'status',
      content: `脏状态自动兜底：${v.reason}`,
      metadata: {
        criterion: v.criterion,
        recovery: v.recovery,
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