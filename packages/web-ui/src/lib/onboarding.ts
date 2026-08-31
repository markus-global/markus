/**
 * Per-user onboarding state helpers.
 *
 * 背景：曾经的 `markus_onboarded` / `markus_checklist_dismissed` 是全局（按浏览器）的
 * 单 key，所有登录用户共享。这导致两类问题：
 *  1. 老用户在存量实例里新建一个测试用户，新用户看不到引导清单（数据已存在 / key 已被旧用户置位）；
 *  2. 老用户即使非常熟悉产品，只要 localStorage 里没有旧 key（例如清了缓存），
 *     就会被再次塞入引导，体验被打扰。
 *
 * 修复：引导状态改为 per-user key（`markus_onboarded_<uid>` / `markus_checklist_dismissed_<uid>`），
 * 读取时回退兼容旧的全局 key，保证升级后老用户不会被重新引导。
 */

const LEGACY_ONBOARDED_KEY = 'markus_onboarded';

export function onboardingKey(userId: string): string {
  return `markus_onboarded_${userId}`;
}

export function checklistDismissedKey(userId: string): string {
  return `markus_checklist_dismissed_${userId}`;
}

/** 该用户是否已完成引导（per-user key 优先，回退旧全局 key 兼容老用户）。 */
export function isUserOnboarded(userId: string): boolean {
  try {
    if (localStorage.getItem(onboardingKey(userId)) !== null) return true;
    return localStorage.getItem(LEGACY_ONBOARDED_KEY) !== null;
  } catch {
    return false;
  }
}

/** 标记该用户已完成引导。同时保留旧全局 key（不主动清，避免破坏其它逻辑）。 */
export function markUserOnboarded(userId: string): void {
  try {
    localStorage.setItem(onboardingKey(userId), '1');
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** 清除该用户的引导状态（当后端判定为首次登录/邀请流时调用）。 */
export function clearUserOnboarded(userId: string): void {
  try {
    localStorage.removeItem(onboardingKey(userId));
  } catch {
    /* ignore */
  }
}

/** 该用户是否主动关闭过引导清单（per-user，无全局回退，避免老用户被误隐藏/误显示）。 */
export function isChecklistDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(checklistDismissedKey(userId)) === 'true';
  } catch {
    return false;
  }
}

/** 记录该用户主动关闭引导清单。 */
export function markChecklistDismissed(userId: string): void {
  try {
    localStorage.setItem(checklistDismissedKey(userId), 'true');
  } catch {
    /* ignore */
  }
}