/**
 * 存活性权威的**供给端**：把服务端的两个来源接到 {@link sessionStreamState} 上。
 *
 * 与 `sessionStreamState.ts` 分开是为了让状态容器保持**纯**（不 import api / wsClient）：
 * 之前它直接 `import { api, wsClient } from '../api.ts'`，于是那个文件的单元测试在
 * node 环境里连 import 都过不去（`window is not defined`）——测试从未真正跑起来。
 * 一个「跑不起来的测试」比没有测试更糟：它给了覆盖率错觉。
 *
 * 写入规则（排序、权威压过派生）仍全部留在 `SessionStreamState` 内，这里只做搬运。
 */

import { api, wsClient } from '../api.ts';
import { sessionStreamState } from './sessionStreamState.ts';

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
