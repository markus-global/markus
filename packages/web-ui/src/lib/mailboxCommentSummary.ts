/**
 * 「Comment on <实体> "..." from <作者>」摘要的**唯一解析点**。
 *
 * ## 为什么收敛到一处
 *
 * 这两个正则原本各自散在 `pages/AgentProfile.tsx` 的两个 switch 分支里，而且都带一个
 * 可选分组 `(\s*\(\+\d+\))?` —— 那是 mailbox 折叠项在**旧格式**下把折叠计数写进
 * `summary` 末尾留下的痕迹（`displayLabelOf` 的 ` (+N)`）。
 *
 * 现在解析器不再替调用方「猜」这段散文：
 *   - 新行的折叠数写在 `metadata.mergeCount` 里（结构化，见 core 的
 *     `mailbox-summary.ts#mergeCountOf`）；
 *   - 实测现网（2026-10-23）`mailbox_items` 中，注释类摘要带该后缀的行数为 **0**；
 *   - 万一真出现一条旧行，作者名会原样带上 ` (+N)` —— 可见、可追，而不是被静默改写。
 *
 * 判据：结构不能从散文里推断。散文要么被显式说明（这里由调用方决定怎么展示），
 * 要么就当作纯文本原样传递。
 */
export interface CommentSummary {
  /** 被评论的实体标题（任务 / 需求） */
  subject: string;
  /** 评论作者显示名 */
  author: string;
}

/**
 * 匹配顺序即优先级：先 task 后 requirement。
 * 两个模式都**锚定首尾**——否则一句「Comment on task "X" from Y and more」会被
 * 悄悄截成作者名 Y，等于又从散文里造出了结构。
 */
const PATTERNS: readonly RegExp[] = [
  /^Comment on task "(.+?)" from (.+)$/,
  /^Comment on requirement "(.+?)" from (.+)$/,
];

/**
 * 解析注释类邮箱摘要。不是这两种形状就返回 `null`，调用方回退到原样展示。
 */
export function parseCommentSummary(summary: string): CommentSummary | null {
  if (!summary) return null;
  for (const re of PATTERNS) {
    const m = re.exec(summary);
    if (m) return { subject: m[1], author: m[2] };
  }
  return null;
}
