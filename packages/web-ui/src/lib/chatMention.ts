/**
 * 移除「@ 提及」触发片段。
 *
 * 为什么需要纯函数：原先这段逻辑内联在 `insertMention` 里，用**点击那一刻**的
 * `textarea.selectionStart` 去反推 `@` 的位置。点下拉项时 textarea 已经失焦，
 * `selectionStart` 可能停在旧位置（甚至回到 0），于是删除区间算错 ——
 * 用户选完之后，之前输入的 `@前缀` 仍留在输入框里（Owner 2026-11-06 实测）。
 *
 * 判据：删除区间不应该由「当前光标」推断，而应该由「下拉打开时的触发位置」这个
 * **事实**决定；同时必须校验那段文本仍是当初键入的内容（用户可能在打开下拉后
 * 又编辑过），不匹配才回退到按光标扫描。
 */
export interface MentionTrigger {
  /** `@` 在文本中的下标。 */
  at: number;
  /** `@` 之后已键入的过滤片段（原始大小写）。 */
  fragment: string;
}

/** 触发片段是否仍然位于记录的位置。 */
function spanStillMatches(text: string, trigger: MentionTrigger): boolean {
  if (trigger.at < 0) return false;
  const expected = `@${trigger.fragment}`;
  return text.slice(trigger.at, trigger.at + expected.length) === expected;
}

/**
 * @param text     当前输入框文本
 * @param trigger  下拉打开时记录的触发位置；没有记录时传 null
 * @param caret    当前光标位置（仅作为回退路径的输入）
 */
export function removeMentionTrigger(
  text: string,
  trigger: MentionTrigger | null,
  caret: number,
): string {
  if (trigger && spanStillMatches(text, trigger)) {
    const end = trigger.at + 1 + trigger.fragment.length;
    return text.slice(0, trigger.at) + text.slice(end);
  }
  // 回退：按光标前的最后一个 `@` 删。光标越界时夹到文本长度。
  const pos = Math.min(Math.max(caret, 0), text.length);
  const atIdx = text.slice(0, pos).lastIndexOf('@');
  if (atIdx < 0) return text;
  return text.slice(0, atIdx) + text.slice(pos);
}
