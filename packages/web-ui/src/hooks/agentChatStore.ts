/**
 * agentChatStore — 纯函数 per-agent 聊天状态容器（无 React 依赖，可单测）。
 *
 * 背景（交付物页聊天对齐 Team Chat）：ChatPanel 在交付物页会随 L1 列表切换
 * agentId，若用单一 state 保存 messages/sessionId/流状态，多 agent 并行流式
 * 输出时切换会互相污染、切回无法续接。本容器将每个 agent 的主会话状态隔离在
 * 一个 Map 中，与 Team.tsx 的 msgBuffers 思路一致，但不搬动 Team 的 5500 行。
 *
 * 设计：
 * - 状态按 agentId 索引（Map<string, T>）。
 * - updateField(id, field, updater) 只更新目标 agent，返回变更后的完整状态；
 *   其余 agent 的状态不受影响（隔离的关键保证）。
 * - 组件侧在 updateAgent 命中「当前可见 agent」时把最新状态同步到渲染层。
 */
export type StateUpdater<V> = V | ((prev: V) => V);

export interface AgentChatStore<T extends object> {
  /** 读取某 agent 的状态，不存在返回 undefined。 */
  get(id: string): T | undefined;
  /** 读取某 agent 的状态，不存在则用 makeBlank 初始化并返回。 */
  getOrCreate(id: string): T;
  /** 是否已有某 agent 的状态。 */
  has(id: string): boolean;
  /**
   * 更新某个 agent 单个字段（支持函数式更新）。
   * 返回该 agent 更新后的完整状态，方便调用方判断是否命中活动 agent 并同步渲染。
   */
  updateField<K extends keyof T>(id: string, field: K, updater: StateUpdater<T[K]>): T;
  /** 整体替换某 agent 的状态。 */
  set(id: string, state: T): T;
  delete(id: string): boolean;
}

/** 创建一个按 agentId 隔离的聊天状态容器。 */
export function createAgentChatStore<T extends object>(
  makeBlank: () => T,
): AgentChatStore<T> {
  const map = new Map<string, T>();

  return {
    get(id: string): T | undefined {
      return map.get(id);
    },
    getOrCreate(id: string): T {
      let v = map.get(id);
      if (!v) {
        v = makeBlank();
        map.set(id, v);
      }
      return v;
    },
    has(id: string): boolean {
      return map.has(id);
    },
    updateField<K extends keyof T>(id: string, field: K, updater: StateUpdater<T[K]>): T {
      const cur = map.get(id) ?? makeBlank();
      const nextVal =
        typeof updater === 'function'
          ? (updater as (prev: T[K]) => T[K])(cur[field])
          : updater;
      const next = { ...cur, [field]: nextVal } as T;
      map.set(id, next);
      return next;
    },
    set(id: string, state: T): T {
      map.set(id, state);
      return state;
    },
    delete(id: string): boolean {
      return map.delete(id);
    },
  };
}
