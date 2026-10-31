/**
 * 反馈截图的选择与校验规则（纯函数，无 DOM 依赖）。
 *
 * 为什么要单独一个模块：这些规则有三处使用者——文件选择、拖拽/粘贴、以及
 * 提交前的兜底校验；再加上「最多 5 张 / 单张 5MB / 只收图片」是产品硬约束，
 * 写进组件里就没法单测了。这里只做判断，不碰 File 对象以外的浏览器 API。
 */

export const MAX_FEEDBACK_IMAGES = 5;
export const MAX_FEEDBACK_IMAGE_BYTES = 5 * 1024 * 1024;

/** 只收浏览器能直接预览、且 Hub 上传白名单认识的格式。 */
export const FEEDBACK_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** 校验失败的原因码——调用方负责翻译，避免这里硬编码任何语言的文案。 */
export type RejectReason = 'not_image' | 'too_large' | 'too_many';

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export interface AcceptedFile<T extends FileLike> {
  file: T;
}

export interface RejectedFile {
  name: string;
  reason: RejectReason;
}

export interface AcceptResult<T extends FileLike> {
  accepted: T[];
  rejected: RejectedFile[];
}

/**
 * 从一批候选文件里挑出可以加入附件的部分。
 *
 * @param currentCount 已经挂上的截图数量（用于计算剩余名额）
 *
 * 规则：类型白名单 → 单张体积 → 总数上限。超额的**不静默丢弃**，
 * 逐条给出原因（`too_many`），让 UI 能明确告诉用户「最多 5 张」。
 */
export function acceptFeedbackFiles<T extends FileLike>(
  candidates: readonly T[],
  currentCount: number,
): AcceptResult<T> {
  const accepted: T[] = [];
  const rejected: RejectedFile[] = [];
  const allowed = FEEDBACK_IMAGE_MIME as readonly string[];

  let count = currentCount;
  for (const file of candidates) {
    if (!allowed.includes(file.type)) {
      rejected.push({ name: file.name, reason: 'not_image' });
      continue;
    }
    if (file.size > MAX_FEEDBACK_IMAGE_BYTES) {
      rejected.push({ name: file.name, reason: 'too_large' });
      continue;
    }
    if (count >= MAX_FEEDBACK_IMAGES) {
      rejected.push({ name: file.name, reason: 'too_many' });
      continue;
    }
    accepted.push(file);
    count += 1;
  }

  return { accepted, rejected };
}

/** 人类可读的体积（用于「单张不超过 5MB」这句提示和超限说明）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  const rounded = value >= 10 || exp === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[exp]}`;
}

/** 提交前的最终校验：标题必填（去空白后非空）。返回 null 表示通过。 */
export function validateFeedbackDraft(draft: { title: string }): 'title_required' | null {
  return draft.title.trim() ? null : 'title_required';
}
