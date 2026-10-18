/**
 * 「这条气泡里有没有正文」—— 唯一判据。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 *
 * `.streaming-bubble`（那道旋转的活跃度光环）挂在**气泡容器**上，而 Agent 气泡容器
 * 是整列宽、并带 `min-height` 地板的块级元素。于是当一轮长时间只有工具调用、
 * 没有正文/思考时，用户看到的不是「正在干活的提示」，而是一个**几乎空的大方框**，
 * 里面只孤零零一行折叠的「执行命令… · 102 步」。老板 2026-10-18 截图报的就是这个。
 *
 * 结构上的错在于：**活跃度信号被画在了由布局决定尺寸的容器上**，而不是画在有内容的
 * 那个东西上。内容一薄，边框就成了空框。而"这一轮还活着"这件事，过程行自己已经在
 * 表达了（转圈图标 + 扫光 + 实时文案），光环在那一态是纯冗余。
 *
 * 所以规则只有一条：**有正文才给气泡上光环**。正文 = 会被 MarkdownMessage 渲染的
 * 那段文字；思考/工具不算（它们有自己的折叠行）。
 *
 * ── 三个来源都必须查 ─────────────────────────────────────────────────────────
 *
 * • `segments`          —— 流式时的权威来源（`text` 分段随 delta 增长）
 * • `committedSegments` —— 中途提交过的分段（历史页/轮次快照走这条）
 * • `text`              —— 老消息的正文只存在于这个字段（没有分段）
 *
 * 只查其中一个会让「有正文」被误判成「没有」→ 该有的光环不出现，比空框更糟。
 */

interface ProseSegment {
  type: string;
  content?: string;
}

export interface ProseBearingMessage {
  text?: string;
  segments?: ProseSegment[];
  committedSegments?: ProseSegment[];
}

function hasTextSegment(segments?: ProseSegment[]): boolean {
  return !!segments?.some(s => s.type === 'text' && (s.content ?? '').trim().length > 0);
}

/** 这条消息是否有正文（决定是否给气泡画活跃度光环）。 */
export function bubbleHasProse(msg: ProseBearingMessage): boolean {
  return (
    hasTextSegment(msg.segments) ||
    hasTextSegment(msg.committedSegments) ||
    !!msg.text?.trim()
  );
}

/**
 * 「这一条气泡该不该上活跃度光环」—— 组合判据的单一定义点。
 *
 * `live` 由既有的两条活性判据传入（`shouldPaintStreamingBubble` / 最后一条视觉流）；
 * 这里只加一道**结构**约束：光环只能画在有正文的 agent 气泡上。
 * 抽成函数而不是写在 JSX 里，是因为这是那个「空方框」bug 的唯一开关 —— 它必须能被
 * 单测直接盯住，而不是靠渲染整个 Team 页去间接观察。
 */
export function shouldPaintStreamingRing(opts: {
  /** 已有活性判据说「这轮在流」。 */
  live: boolean;
  /** 消息发送方（光环只属于 agent 气泡）。 */
  sender: string;
  /** `bubbleHasProse` 的结果。 */
  hasProse: boolean;
}): boolean {
  return opts.live && opts.sender === 'agent' && opts.hasProse;
}
