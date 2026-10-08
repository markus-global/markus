/**
 * 流式回合的「结束」判据 —— 单一事实源。
 *
 * ## 为什么需要它
 *
 * 服务端在 SSE 连接断开时**不会停止生成**（`SSE_DISCONNECT_FORCE_STOP_MS = 45min`，
 * 断开时日志打 `SSE client disconnected — detaching (agent continues)`）。
 * 而客户端读循环一旦拿不到数据，就很容易把**传输结束**误当成**回合结束**：
 * `setSending(false)` + `clearStreamSession()` + `finalizeLastStreamingBubble()`。
 *
 * 这一个错误推断会连锁出三个下游缺陷（2026-10-08 事故）：
 *   ① 气泡的"输出中"动态边框被抹掉（`showStreamingBubble` 依赖 `isStreaming`）；
 *   ② 在途气泡在下一次 DB 合并时被当"陈旧副本"丢弃（`mergeDbWithCache` 依赖
 *      客户端所有权集合 `streamLive`，而它已被清空）—— 表现为"前端气泡根本不流式"；
 *   ③ `shouldSweepGhostStreaming` 反噬：断开后本地信号恰好全部为假，于是它把服务端
 *      权威证据认可的"在途行"当幽灵抹掉，且该 effect 挂在 `[messages]` 上**每次 delta 都跑**，
 *      边框永远亮不回来。
 *
 * ## 不变量
 *
 * **`isStreaming`（"这轮还在跑"）只能由服务端终态、或用户显式 stop 改写。
 * 传输结束永远不构成改写理由。**
 *
 * 所以本函数只回答一个问题：这次 stream 调用返回之后，该定型还是该续接。
 * 判据是**权威**（服务端），不是任何客户端本地信号 —— 本地信号只描述"本客户端
 * 有没有在消费"，描述不了"这轮结束了没有"。这正是既有教训里那条
 * 「派生 UI 必须能被权威否决」的落地。
 *
 * 本模块是纯函数、无副作用，便于把这条不变量固化成回归测试。
 */

/** 服务端对该会话此刻的流状态。`null` = 问不到（网络不可达 / 请求失败）。 */
export type ServerStreamStatus =
  | 'streaming'
  | 'done'
  | 'error'
  | 'stopped'
  | 'idle'
  | 'not_found'
  | null;

export interface StreamEndInput {
  /**
   * 本地已终结这次流：用户显式 stop，或被更新的 attach / 导航取代。
   * 这是"用户意图"，属于本地有权改写的情形，必须先于权威判定。
   */
  aborted: boolean;
  /**
   * 传输过程中**收到了服务端的终态事件**（`done` / `error`）。
   * 注意：这只表示"传回来了终态"，不表示"传输没断"。
   */
  sawTerminal: boolean;
  /** 权威：问服务端得来的该会话流状态。 */
  serverStatus: ServerStreamStatus;
}

export type StreamEndDecision = 'finalize' | 'reattach';

/**
 * 这次 stream 调用结束后，该定型还是该续接。
 *
 * - `finalize` —— 权威确认回合已结束（或用户显式停止），可以落地气泡。
 * - `reattach` —— 权威说还在跑，或**问不到权威**；必须继续续接，绝不结案。
 *
 * 歧义时永远选 `reattach`：多一点续接只是多一次请求，而错误结案会让用户
 * 看到"半截回复 + 没有边框 + 内容却还在涨"。两者的代价不对称。
 */
export function decideOnStreamEnd(input: StreamEndInput): StreamEndDecision {
  // 本地有权终结：用户显式停止 / 被更新的 attach 取代。
  if (input.aborted) return 'finalize';

  // 服务端已交付终态 —— 终态事件优先于状态接口的 TTL（done 之后
  // `active` 还会维持约 90s，状态可能仍报 'streaming'，但那不是"还在跑"）。
  if (input.sawTerminal) return 'finalize';

  // 权威说还在跑 → 续接。
  if (input.serverStatus === 'streaming') return 'reattach';

  // 问不到权威 → 歧义，不结案。
  if (input.serverStatus === null) return 'reattach';

  // done / error / idle / not_found：权威明确表示没有在途流了。
  return 'finalize';
}

/**
 * 把服务端 `/stream/status` 的原始 `status` 归一化到本模块的判据取值域。
 *
 * 服务端把该字段声明为开放 `string`（`status?: string`），所以**未知取值必须归为
 * `null`（= 问不到）而不是任何"已结束"** —— 否则服务端协议里每新增一个状态，
 * 老客户端就会把在途回合误判成结束，重演 2026-10-08 那类事故。
 */
export function normalizeServerStreamStatus(raw: string | undefined | null): ServerStreamStatus {
  switch (raw) {
    case 'streaming':
    case 'done':
    case 'error':
    case 'stopped':
    case 'idle':
    case 'not_found':
      return raw;
    default:
      return null;
  }
}
