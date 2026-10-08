/**
 * jumpWindow — 「跳到某条消息」的**自带取数**：从最新往更早逐页取，直到目标进入窗口。
 *
 * 为什么不让跳转复用滚动用的增量翻页（`loadMore`）：
 * 那条通道的每一项前置状态都是**共享**的，且都可能在跳转的中途被别人改写 ——
 *   • 翻页闸门读 `getWindowBounds(bufferId)`，**未写入时默认 `hasMore:false`**
 *     → `loadMore` 直接返回 0 → `locateMessage` 判定「目标加载失败」→ 回到底部
 *     （用户看到的「直接显示该会话最新消息」）；
 *   • 在途去重 `loadMoreInflightRef` 是**全局**的：会把**别人的**在途请求返回给我，
 *     那个请求返回 0（例如它属于另一个视图）时，我这边也立刻收手；
 *   • 请求回来时若「视图已变」会**丢弃整页**并返回 0。
 *
 * 同一个 `0` 同时表示三件不同的事（到底了 / 这页被丢弃 / 我加入了别人的请求），
 * 调用方无法区分 —— 这就是「同一会话内搜正常、跨会话多试几次才坏」的形态：
 * 同会话命中走 fast path（不翻页），跨会话必然翻页，于是必然踩中这些共享状态。
 *
 * 契约（本模块钉住）：
 *   • `has(targetId)` 已命中 → fast path，**不发请求、不安装**（同会话 ⌘F / 通知深链）；
 *   • 否则从**最新**往更早逐页取，直到命中 / 到头（hasMore=false 或空页）/ 上界；
 *   • 返回**累计窗口（升序 = 显示序）**，调用方一次性安装 → 目标必然在内，无需再翻页。
 *
 * 纯函数、无 DOM、无 React —— 时序留给调用方，判定可单测。
 *
 * 数据形态（与服务端一致）：每页**升序**（`messages[0]` 是该页最早一条），
 * 页序为**最新→最旧**，下一页游标 = 上一页 `messages[0].createdAt`。
 */

export interface JumpWindowMessage {
  id: string;
  createdAt: string;
}

export interface JumpWindowPage<M extends JumpWindowMessage = JumpWindowMessage> {
  /** 该页消息，**升序**（`messages[0]` 最早）。 */
  messages: M[];
  /** 还有更早的历史吗（服务端对「再往前一页」的回答）。 */
  hasMore: boolean;
}

export interface CollectJumpWindowOptions<M extends JumpWindowMessage = JumpWindowMessage> {
  /** 目标消息 id。 */
  targetId: string;
  /** 目标是否已在当前缓冲里。调用方保证读**权威、同步最新**的数据源。 */
  has: (id: string) => boolean;
  /** 取一页：`before` = 上一页最早一条的时间；`undefined` = 最新一页。 */
  fetchPage: (before?: string) => Promise<JumpWindowPage<M>>;
  /**
   * 目标自身的创建时间（搜索结果/通知里已知）。
   * 有了它就能在「整页都比目标更旧」时收手 —— 目标不在本会话（已删除/不属于这里），
   * 不必为了 prove-a-negative 一路翻到会话开头。
   */
  targetCreatedAt?: string;
  /** 翻页上界（防止病态情况下无限翻页）。默认 40。 */
  maxPages?: number;
}

/**
 * 把取回的窗口裁到显示上限以内，**保证目标仍在**。
 *
 * `ConversationBufferManager.updateMessages` 会 `slice(-MAX_MESSAGES)` —— 保留**最新**的、
 * 丢掉**最旧**的。而深历史跳转的窗口恰恰把目标放在最旧一端，于是「正好被裁掉」=
 * 又变回「目标不在缓冲里」。所以裁之前必须先把目标保住：
 *   • 窗口没超上限 → 原样返回；
 *   • 超了 → 以目标为中心取一段（目标前留 `contextBefore` 条上下文），窗口整体前移/后移，
 *     既不丢目标，也不越界。
 * 目标不在窗口里（调用方会用 `found=false` 兜底）→ 退回「保留最新」的默认语义。
 */
export function trimJumpWindow<M extends JumpWindowMessage>(
  messages: M[],
  targetId: string,
  opts?: { cap?: number; contextBefore?: number },
): M[] {
  const cap = opts?.cap ?? 500;
  const keepBefore = opts?.contextBefore ?? 20;
  if (messages.length <= cap) return messages;
  const idx = messages.findIndex((m) => m.id === targetId);
  if (idx < 0) return messages.slice(-cap);
  const start = Math.max(0, Math.min(idx - keepBefore, messages.length - cap));
  return messages.slice(start, start + cap);
}

export interface CollectJumpWindowResult<M extends JumpWindowMessage = JumpWindowMessage> {
  /** 目标是否已就位（缓冲里已有，或本次取到）。 */
  found: boolean;
  /**
   * 本次取回的窗口，**升序（显示序）**，可直接覆盖安装。
   * 空数组 = 无需安装（fast path，目标本来就在缓冲里）。
   */
  messages: M[];
  /** 窗口底部边界：取到的最旧那一页是否还有更早的历史。 */
  hasMore: boolean;
  /** 下一页游标 = 本窗口最早一条的时间；空窗口为 null。 */
  oldestCursor: string | null;
  /** 是否已翻到历史尽头（没有更早的了）。 */
  exhausted: boolean;
}

export async function collectJumpWindow<M extends JumpWindowMessage = JumpWindowMessage>(
  options: CollectJumpWindowOptions<M>,
): Promise<CollectJumpWindowResult<M>> {
  const { targetId, has, fetchPage, targetCreatedAt, maxPages = 40 } = options;

  if (has(targetId)) {
    return { found: true, messages: [], hasMore: true, oldestCursor: null, exhausted: false };
  }

  const targetMs = targetCreatedAt ? Date.parse(targetCreatedAt) : Number.NaN;

  /** 累计窗口，保持**升序**：新取的一页（更旧）前插。 */
  let window: M[] = [];
  let before: string | undefined;
  let hasMore = true;
  let exhausted = false;
  let found = false;

  const oldest = () => (window.length > 0 ? window[0]!.createdAt : null);

  for (let page = 0; page < maxPages; page++) {
    let fetched: JumpWindowPage<M>;
    try {
      fetched = await fetchPage(before);
    } catch {
      // 网络/服务端异常：把**已经取到的**窗口交出去（比什么都没有强），由调用方决定。
      return { found: false, messages: window, hasMore, oldestCursor: oldest(), exhausted: false };
    }

    const msgs = fetched?.messages ?? [];
    if (msgs.length === 0) {
      // 空页 = 没有更早的了：这是**唯一**由服务端证明的终止条件。
      exhausted = true;
      hasMore = false;
      break;
    }

    window = [...msgs, ...window];
    hasMore = !!fetched.hasMore;

    if (msgs.some((m) => m.id === targetId)) {
      found = true;
      break;
    }
    if (!hasMore) {
      exhausted = true;
      break;
    }

    // 页内升序 → msgs[0] 是这一页最早一条。
    const pageOldest = msgs[0]!;
    const pageOldestMs = Date.parse(pageOldest.createdAt);
    // 已知目标时间且已经翻过它：目标不在本会话，收手（不必翻到会话开头）。
    if (Number.isFinite(targetMs) && Number.isFinite(pageOldestMs) && pageOldestMs < targetMs) {
      break;
    }
    before = pageOldest.createdAt;
  }

  return { found, messages: window, hasMore, oldestCursor: oldest(), exhausted };
}
