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

/**
 * 本视图（某个 agent 会话 key + **确切** session id）此刻是否有活流。
 *
 * ## 为什么必须在这里、而且必须"只认确切 id"
 *
 * 客户端把所有在途流记在一个按 **convKey** 索引的 membership 集合里，元素是
 * session id。切换 session tab 时要回答"目标 tab 是不是正在输出"，只能问
 * 「这个集合里有没有**这个** id」。
 *
 * 曾经写成 `集合.has(s.id) || 集合.has(NEW_CHAT_PLACEHOLDER_ID)` —— 后半个子句把
 * `NEW_CHAT_PLACEHOLDER_ID` 当作"任意会话"的通配符。但它只是一个**普通 id**：
 * 一条从「新会话」发出的流会让该 agent 的**每一个** tab 都被判成在途流，于是
 * 切 tab 时那条 tab 的最后一条消息被画上"输出中"动态边框，几百毫秒后又被权威
 * 状态纠正而消失（用户看到的是无端闪烁）。placeholder 不是一个选择器。
 *
 * placeholder 视图自己依然匹配：`has(sid)` 在 `sid === placeholder` 时照样成立。
 */
export function sessionHasLiveStream(
  sessions: ReadonlySet<string> | undefined,
  sessionId: string | null | undefined,
): boolean {
  return !!sessions && !!sessionId && sessions.has(sessionId);
}

export interface StreamingBubbleInput {
  /** 消息载荷上携带的 `isStreaming`。注意它**可能**是服务端持久化的中途快照。 */
  msgIsStreaming: boolean;
  /** 权威：`sessionHasLiveStream(活流集合, 本视图的 session id)`。 */
  liveStreamForView: boolean;
}

/**
 * 这条 agent 气泡该不该画"输出中"动态边框。
 *
 * ## 为什么不能只看载荷上的 `isStreaming`
 *
 * 服务端在 SSE 断开时**不停止生成**（`SSE_DISCONNECT_FORCE_STOP_MS = 45min`），
 * 而断开瞬间会把"中途快照"连同 `metadata.isStreaming = true` 一起**持久化**。
 * 之后任何一次 DB 回填 / 会话缓存恢复都会把这条副本带回来：它已经**不是**在途流了，
 * 但载荷上还写着"在跑"。若显示层直接采信它，切到该会话就会看到
 * 「一个只有边框、没有内容的空气泡」——网络越慢，权威数据越晚到，盯得越久。
 *
 * 所以判据是**两票制**：载荷说"在跑"**且**权威活流状态确认"这个视图真在跑"。
 *
 * 不用「本地 `sending` 为真」当例外：`sending` 本身也是权威状态的**本地副本**，
 * 切会话的那一拍会短暂残留上一个视图的值 —— 拿它当所有权证据，正好会在切 tab 的
 * 那一帧把新 tab 的最后一条消息画上边框（实测到的那个 150ms 瞬态）。发信时
 * `setStreamSession` 已先于气泡创建登记，所以这个例外本就多余。
 *
 * 本函数是纯函数，`isStreaming` 本身**不被改写**（它只能由服务端终态或用户显式
 * stop 改写，见本模块头部不变量）——这里只决定"这一次渲染画不画边框"。
 */
export function shouldPaintStreamingBubble(input: StreamingBubbleInput): boolean {
  return input.msgIsStreaming && input.liveStreamForView;
}
