/**
 * ChatDraftMemory — 每个视图（agent / session tab）各存一份输入框草稿。
 *
 * ── 为什么存在 ────────────────────────────────────────────────────────────────
 *
 * 输入框原先是一个**全局** `input` 字符串：切 Agent / session tab 时文本跟着走，
 * 于是「在 A tab 里写了一半的草稿」会原样出现在 B tab 里，甚至可能被误发。
 * 产品要的是相反的行为：每个视图留一份自己的草稿，切回来还在。
 *
 * 键与滚动记忆**完全同源**（`convKey::sessionId`，见 chatScrollRestore#scrollMemoryKey），
 * 因此草稿跟着的就是用户眼前那个视图，不会出现「按 agent 存、按 tab 取」这种错位。
 *
 * ── 约定 ─────────────────────────────────────────────────────────────────────
 *
 * • **空串 = 没有草稿**（发送后清空即删除该槽），这样 `get` 的返回值无歧义，
 *   也顺带把 store 压小。
 * • 只活在**进程内**（不落盘），并被 LRU 限界 —— 与 `chatScrollMemory` 同一口径：
 *   它是"当前这次使用里的顺手状态"，不是需要持久化的用户数据。
 * • 纯状态机、零 React 依赖，可直接单测。
 */
export class ChatDraftMemory {
  /** Map 保持插入序；LRU = 「最近一次 save/get 的在尾部」。 */
  private readonly entries = new Map<string, string>();

  constructor(private readonly capacity = 120) {}

  /**
   * 记下某个视图的当前草稿。空串 = 删除该槽。
   * 空 key 直接忽略：调用方还在切换途中（指针是另一个写者写的）时不该落任何东西。
   */
  save(key: string, text: string): void {
    if (!key) return;
    this.entries.delete(key);
    if (text === '') return;
    this.entries.set(key, text);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** 取某个视图的草稿；没有就是空串（绝不返回 undefined）。命中会把它推到 LRU 尾部。 */
  get(key: string): string {
    const found = this.peek(key);
    if (found === '') return '';
    // touch → 提到 LRU 尾部
    this.entries.delete(key);
    this.entries.set(key, found);
    return found;
  }

  /**
   * 只读、**不**改变 LRU 顺序。
   *
   * 用途：切换视图时判断「这一拍里 `input` 是不是被外部写者改过」（导航预填
   * `markus_nav_prefillMessage`）—— 用 `get` 会顺手改动淘汰顺序，那是副作用，
   * 不该藏在一次比较里。
   */
  peek(key: string): string {
    if (!key) return '';
    return this.entries.get(key) ?? '';
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 进程内单例 —— 与 `chatScrollMemory` 同族，切页面/重挂载后草稿仍在。 */
export const chatDraftMemory = new ChatDraftMemory();
