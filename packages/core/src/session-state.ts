/**
 * SessionStateRegistry —— 以「会话」为单位的处理状态机（后端唯一真相源）
 * ---------------------------------------------------------------------------
 * 为什么需要它（老板 2026-10-06 报告的问题 B）：
 *   「某个会话在不在处理中」此前有 4 个互不同步的真相源——
 *     (1) attention 内存态（per-worker，见 attention.ts workerStates/aggregateState）
 *     (2) DB `mailbox_items.status`（per-item，不绑会话）
 *     (3) ActiveStreamRegistry（per-(agent,session)，但要先知道 sessionId）
 *     (4) 前端本地 ref（streamingSessions / volatile.sending / …）
 *   没有任何一处能回答「这个 agent 现在有哪几个会话在跑」→ 前后端必然漂移。
 *
 * 本模块把该事实收敛为**唯一写法**：每个会话一个运行时状态；agent 的「工作中」
 * 状态 = 各会话状态的**并集**（任一会话 processing ⇒ working）。
 *
 * 单一写者契约：只有本注册表改状态；其它子系统（attention / SSE / API）只**读**它。
 * 键 = 会话身份（`resolveTurnSession` 解析出的内存会话 id：`sess_*` / `task_*` /
 * `hb_*` / `sys_*` / `channel_*` …）。这是一个 **agent 级单例**，与 per-worker 的
 * SessionWorkspace 正交（不违反 STATE-OWNERSHIP.md：会话→worker 的绑定仍显式传参）。
 *
 * 语义要点：
 *  - `begin` 幂等；会话内多条 item 时，`processingSince` 只记第一次。
 *  - `settle` 必须**全部** item 结算完，会话才回 `idle`（会话内串行）。
 *  - `error` / `cancelled` 是**结果**（lastOutcome），不粘滞为状态——避免历史
 *    「error 粘性」类缺陷（见 agent.ts transitionStatus 的历史注释）。
 *  - 未知会话 / 未知 item 的 settle = 安全 no-op，绝不误伤其它会话。
 */

export type SessionStateName = 'idle' | 'processing';

export type SessionSettleOutcome = 'ok' | 'cancelled' | 'error';

export interface SessionRuntimeState {
  /** 会话身份（内存会话 id）。 */
  sessionKey: string;
  state: SessionStateName;
  /** 正在处理中的 mailbox item id 集合（会话内可有多条排队/在飞）。 */
  itemIds: Set<string>;
  /** 首次进入 processing 的时间（ms）。 */
  processingSince?: number;
  /** 最近一次终结结果（可观测性）。 */
  lastOutcome?: SessionSettleOutcome;
  lastErrorMessage?: string;
  /** 最近一次状态变更时间（ms）。 */
  lastUpdated: number;
}

/**
 * 会话处理状态机。全局唯一写者；所有读操作返回快照语义的数据。
 */
export class SessionStateRegistry {
  private readonly sessions = new Map<string, SessionRuntimeState>();

  /** 某个工作单元开始处理该会话。幂等；空 key 忽略（调用方未解析出会话）。 */
  begin(sessionKey: string, itemId: string): void {
    if (!sessionKey) return;
    const now = Date.now();
    const existing = this.sessions.get(sessionKey);
    if (!existing) {
      this.sessions.set(sessionKey, {
        sessionKey,
        state: 'processing',
        itemIds: new Set([itemId]),
        processingSince: now,
        lastUpdated: now,
      });
      return;
    }
    existing.itemIds.add(itemId);
    if (existing.state !== 'processing') {
      existing.state = 'processing';
      existing.processingSince = now;
    }
    existing.lastUpdated = now;
  }

  /**
   * 某个工作单元结束。仅当该会话已无在飞 item 时才回 `idle`。
   * 未知会话 / 未知 item = 安全 no-op。
   */
  settle(
    sessionKey: string,
    itemId: string,
    outcome: SessionSettleOutcome = 'ok',
    errorMessage?: string,
  ): void {
    if (!sessionKey) return;
    const existing = this.sessions.get(sessionKey);
    if (!existing) return;

    existing.itemIds.delete(itemId);
    existing.lastOutcome = outcome;
    existing.lastErrorMessage = outcome === 'error' ? errorMessage : undefined;
    existing.lastUpdated = Date.now();

    if (existing.itemIds.size === 0) {
      existing.state = 'idle';
      existing.processingSince = undefined;
    }
  }

  getSession(sessionKey: string): SessionRuntimeState | undefined {
    return this.sessions.get(sessionKey);
  }

  /** 是否**任一**会话正在处理（agent「工作中」的派生依据）。 */
  anyProcessing(): boolean {
    for (const s of this.sessions.values()) {
      if (s.state === 'processing') return true;
    }
    return false;
  }

  /** 正在处理的会话数。 */
  processingCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.state === 'processing') n += 1;
    return n;
  }

  /** 仅正在处理的会话键。 */
  activeSessionKeys(): string[] {
    const keys: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.state === 'processing') keys.push(s.sessionKey);
    }
    return keys;
  }

  /** 全部已登记的会话（含已 idle 的历史）。 */
  list(): SessionRuntimeState[] {
    return [...this.sessions.values()];
  }

  /** 测试/重置用。 */
  clear(): void {
    this.sessions.clear();
  }
}
