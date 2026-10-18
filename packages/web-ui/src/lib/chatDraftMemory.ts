/**
 * ChatDraftMemory — 每个视图（agent / session tab）各存一份**完整的**输入框草稿。
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
 * ── 2026-10-18：草稿是「输入框的全部内容」，不是「字符串」─────────────────────
 *
 * 上一版只存 `text`，而用户实际在编辑的东西有四件：文字、待发图片、引用片段
 * （chatContext chips）、回复目标。于是**只有文字被正确隔离**——图片/引用/回复
 * 仍然是全局 state：在 A 视图贴了图，切到 B 视图图还在（而且 B 里根本看不出它
 * 是从哪来的）。老板报的就是这个（"缓存似乎只缓存了文字，对于图片，引用，标签等等，
 * 没有正常的缓存或切换"）。
 *
 * 根因是**结构被压成了载荷**：用 `string` 表达「草稿」，凡是不能变成字符串的
 * 那部分就必然丢失。所以这里的草稿是一个**结构化记录**，四个字段一起存、一起取，
 * 加减字段时编译器会强制每个调用点跟着改（`ChatDraft` 是唯一契约）。
 *
 * ── 约定 ─────────────────────────────────────────────────────────────────────
 *
 * • **全空 = 没有草稿**（发送后清空即删除该槽），这样 `get` 的返回值无歧义，
 *   也顺带把 store 压小。
 * • 只活在**进程内**（不落盘），并被 LRU 限界 —— 与 `chatScrollMemory` 同一口径：
 *   它是"当前这次使用里的顺手状态"，不是需要持久化的用户数据。
 * • 纯状态机、零 React 依赖，可直接单测。
 */

/** 待发图片（data URL 直接留在草稿里：它就是输入框里的缩略图）。 */
export interface ChatDraftImage {
  id: string;
  dataUrl: string;
  name: string;
}

/** 引用片段（composer 里的 chip）。 */
export interface ChatDraftContext {
  id: string;
  label: string;
  content: string;
}

/** 「回复某条消息」的目标。 */
export interface ChatDraftReplyTo {
  id: string;
  sender: string;
  text: string;
}

/** 一个视图的完整草稿。调用方以**不可变**方式使用（数组换了就换新的）。 */
export interface ChatDraft {
  text: string;
  images: ChatDraftImage[];
  context: ChatDraftContext[];
  replyTo: ChatDraftReplyTo | null;
}

/** 空草稿 —— 调用方拿到的「没有草稿」的唯一形态（绝不返回 undefined）。 */
export const EMPTY_CHAT_DRAFT: ChatDraft = Object.freeze({
  text: '',
  images: [],
  context: [],
  replyTo: null,
}) as ChatDraft;

/** 草稿里有没有任何东西（有就说明这个视图需要占一个槽）。 */
export function isEmptyDraft(draft: ChatDraft): boolean {
  return draft.text === '' && draft.images.length === 0 && draft.context.length === 0 && draft.replyTo === null;
}

/** 补齐缺省字段：调用方可以只传它关心的那几个（例如只改文字）。 */
function normalize(draft: ChatDraft): ChatDraft {
  return {
    text: draft.text,
    images: draft.images,
    context: draft.context,
    replyTo: draft.replyTo,
  };
}

export class ChatDraftMemory {
  /** Map 保持插入序；LRU = 「最近一次 save/get 的在尾部」。 */
  private readonly entries = new Map<string, ChatDraft>();

  constructor(private readonly capacity = 120) {}

  /**
   * 记下某个视图的当前草稿。全空 = 删除该槽。
   * 空 key 直接忽略：调用方还在切换途中（指针是另一个写者写的）时不该落任何东西。
   *
   * `draft` 是**完整**记录（不是 Partial）：四个字段都必须给。这条约束就是本类
   * 存在的理由 —— 草稿漏存一个字段，用户看到的就是「图片/引用跟着视图乱串」。
   * 用 Partial 让「忘了传」静默成「当作没有」，编译器就再也拦不住了。
   */
  save(key: string, draft: ChatDraft): void {
    if (!key) return;
    this.entries.delete(key);
    const normalized = normalize(draft);
    if (isEmptyDraft(normalized)) return;
    this.entries.set(key, normalized);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** 取某个视图的草稿；没有就是空草稿。命中会把它推到 LRU 尾部。 */
  get(key: string): ChatDraft {
    const found = this.peek(key);
    if (isEmptyDraft(found)) return EMPTY_CHAT_DRAFT;
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
  peek(key: string): ChatDraft {
    if (!key) return EMPTY_CHAT_DRAFT;
    return this.entries.get(key) ?? EMPTY_CHAT_DRAFT;
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
