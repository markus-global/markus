/**
 * sessionStreamState — 「某个会话此刻是否正在输出」的**唯一**客户端权威。
 *
 * ## 为什么需要它
 *
 * 这个事实由**服务端**拥有（`ActiveStreamRegistry`），但客户端此前用一堆本地派生量
 * 去**近似**它，彼此寿命不同：
 *   · `sending`（视图级，切 tab 就变）
 *   · `streamingVisual`（带 400ms 最短展示闩）
 *   · `hasStreamingTail(messages)`（依赖已被合并过的显示缓冲，可能带过期 `isStreaming`）
 *   · `getStreamSession()`（其实是**传输附着**登记簿，不是回合存活性）
 * 于是同一瞬间会出现「顶部说工作中、侧栏说空闲」「tab 圆点消失但仍在下文」这类矛盾。
 *
 * ## 契约（单一写者 + 权威否决派生）
 *
 * 写入口只有三个，且共用一套排序规则：
 *   1. `applyServerState`   —— WS 推送（权威，延迟 ~0）
 *   2. `reconcileFromServer` —— 分钟级批量轮询兜底（同样是**服务端**口径）
 *   3. `applyLocalOptimistic` —— 本端发送/停止的即时反馈（**只是提示**）
 *
 *   · 服务端事件按**服务端时间**排序：晚到的旧事件不得覆盖新状态；
 *   · 服务端状态**始终**压过本地乐观提示（权威可否决派生）；
 *   · 只有**真实变化**才通知订阅者。
 *
 * 目的：让「传输登记簿被当成存活性权威」这类误用在**结构上不可能**。
 */

import { useSyncExternalStore } from 'react';
import { api, wsClient } from '../api.ts';

export interface SessionStreamEntry {
  agentId: string;
  streaming: boolean;
  /** 这条状态的来源。`local` 只是提示，随时可被 `server` 覆盖。 */
  source: 'server' | 'local';
  /** **服务端**时间戳（毫秒），本地写入用 `Date.now()` 仅作兜底排序。 */
  at: number;
}

/** 已结束的条目保留多久（仅为让陈旧事件可判断；到点回收，避免无界增长）。 */
const ENTRY_TTL_MS = 10 * 60_000;

export class SessionStreamState {
  private bySession = new Map<string, SessionStreamEntry>();
  private listeners = new Set<() => void>();
  private _revision = 0;

  // 稳定引用：useSyncExternalStore 要求 subscribe / getSnapshot 身份不变。
  getRevision = (): number => this._revision;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** 服务端推送：权威写入。 */
  applyServerState(agentId: string, sessionId: string, streaming: boolean, at = Date.now()): void {
    const prev = this.bySession.get(sessionId);
    // 陈旧事件：已有更新的**服务端**状态 → 丢弃（本地条目不算，权威可覆盖它）。
    if (prev && prev.source === 'server' && prev.at > at) return;
    const changed = !prev || prev.streaming !== streaming;
    this.bySession.set(sessionId, { agentId, streaming, source: 'server', at });
    if (changed) this.bump();
  }

  /** 批量轮询兜底：同样是服务端口径，走同一套规则。 */
  reconcileFromServer(agentId: string, streamingBySession: Record<string, boolean>, at = Date.now()): void {
    for (const [sessionId, streaming] of Object.entries(streamingBySession)) {
      this.applyServerState(agentId, sessionId, streaming, at);
    }
  }

  /**
   * 本端乐观提示（发送 / 显式停止的即时反馈）。
   * **不得**覆盖已有的服务端条目 —— 权威一旦发过话，本地就不再猜。
   */
  applyLocalOptimistic(agentId: string, sessionId: string, streaming: boolean): void {
    const prev = this.bySession.get(sessionId);
    if (prev && prev.source === 'server') return;
    const changed = !prev || prev.streaming !== streaming;
    this.bySession.set(sessionId, { agentId, streaming, source: 'local', at: Date.now() });
    if (changed) this.bump();
  }

  isStreaming(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return this.bySession.get(sessionId)?.streaming ?? false;
  }

  /** 该 agent 名下**任一**会话在输出 —— 顶部状态徽章与侧栏共用的口径。 */
  isAgentStreaming(agentId: string | null | undefined): boolean {
    if (!agentId) return false;
    for (const e of this.bySession.values()) {
      if (e.agentId === agentId && e.streaming) return true;
    }
    return false;
  }

  /**
   * 需要**整个集合**的渲染点（如团队侧栏）用。这是派生视图，不是另一份真值 ——
   * 写入仍只能经上面三个入口。
   */
  streamingAgentIds(): Set<string> {
    const out = new Set<string>();
    for (const e of this.bySession.values()) if (e.streaming) out.add(e.agentId);
    return out;
  }

  hasEntry(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  /** 回收已结束的旧条目（有界增长）。仍在流的条目一律保留。 */
  prune(now = Date.now(), maxAgeMs = ENTRY_TTL_MS): void {
    for (const [sessionId, e] of this.bySession) {
      if (!e.streaming && now - e.at > maxAgeMs) this.bySession.delete(sessionId);
    }
  }

  private bump(): void {
    this._revision += 1;
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* 订阅者异常不得影响其他订阅者或状态本身 */
      }
    }
  }
}

export const sessionStreamState = new SessionStreamState();

/** WS 载荷形状（服务端 `session:stream_state`）。 */
function readStreamStateEvent(event: unknown): { agentId: string; sessionId: string; streaming: boolean } | null {
  const p = (event as { payload?: { agentId?: unknown; sessionId?: unknown; streaming?: unknown } })?.payload;
  if (!p || typeof p.sessionId !== 'string' || typeof p.streaming !== 'boolean') return null;
  return {
    agentId: typeof p.agentId === 'string' ? p.agentId : '',
    sessionId: p.sessionId,
    streaming: p.streaming,
  };
}

let feedAttached = false;

/**
 * 接上权威供给（幂等）。WS 推送是主口径；轮询兜底由调用方按打开的 tab 触发
 * （见 `reconcileOpenSessions`）。
 */
export function ensureSessionStreamStateFeed(): void {
  if (feedAttached) return;
  feedAttached = true;
  wsClient.on('session:stream_state', (event: unknown) => {
    const s = readStreamStateEvent(event);
    if (!s) return;
    // 信封的 timestamp 是**服务端**时钟 —— 排序必须用它，不能用本地时钟。
    const at = Date.parse((event as { timestamp?: string }).timestamp ?? '') || Date.now();
    sessionStreamState.applyServerState(s.agentId, s.sessionId, s.streaming, at);
  });
}

/** 对打开的会话做一次批量对账（一次请求覆盖全部 tab）。 */
export async function reconcileOpenSessions(agentId: string, sessionIds: string[]): Promise<void> {
  if (!agentId || sessionIds.length === 0) return;
  try {
    const res = await api.sessions.streamStatusBatch(agentId, sessionIds);
    sessionStreamState.reconcileFromServer(agentId, res.streaming ?? {}, res.at);
  } catch {
    /* 对账失败不改写状态：保留上一次已知权威，等下一轮 */
  }
  sessionStreamState.prune();
}

/**
 * 订阅**任意**会话的存活性变化。返回值（revision）无需使用 —— 调用它本身就让组件在
 * 任何存活性变化时重渲染，供「需要按需读取多个会话」的渲染点使用（如 session tab 栏）。
 */
export function useSessionStreamRevision(): number {
  return useSyncExternalStore(sessionStreamState.subscribe, sessionStreamState.getRevision, sessionStreamState.getRevision);
}

/** 该会话是否在输出（订阅式读取）。 */
export function useSessionStreaming(sessionId: string | null | undefined): boolean {
  useSyncExternalStore(sessionStreamState.subscribe, sessionStreamState.getRevision, sessionStreamState.getRevision);
  return sessionStreamState.isStreaming(sessionId);
}

/** 该 agent 名下是否有会话在输出（订阅式读取）—— 顶部徽章与侧栏同源。 */
export function useAgentSessionStreaming(agentId: string | null | undefined): boolean {
  useSyncExternalStore(sessionStreamState.subscribe, sessionStreamState.getRevision, sessionStreamState.getRevision);
  return sessionStreamState.isAgentStreaming(agentId);
}
