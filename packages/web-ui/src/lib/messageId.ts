/**
 * 消息 id 的**唯一**前端生成器。
 *
 * ── 为什么由客户端来铸 ────────────────────────────────────────────────────────
 * 用户在按下发送的那一刻，界面就已经渲染了一个乐观气泡（总得有个 id 才能渲染）。
 * 如果服务端再自己铸一个 `cm_*`，同一个回合就有了两个身份，只能事后靠「相邻启发式」
 * 对账 —— 每次对不上就是一个重复气泡，重连一次就给同一回合**追加第二行**。
 *
 * 现在两边用**同一串** id：客户端铸、服务端接受为行主键。乐观气泡与落库行出生即同一身份，
 * 重连时复用「在飞那个气泡」的 id，于是原地更新那一行，而不是新增一行。
 *
 * ── 为什么格式必须是 `cm_` + 24 hex ──────────────────────────────────────────
 * 这就是库里的既有主键形状（`@markus/shared` 的 `generateId('cm')` = `cm_` + 12 字节 hex）。
 * 客户端若自创 `a_<nonce>` 之类的形状，写进库就是**格式污染**：所有按前缀识别来源的
 * 读路径都会把新行当成异类。所以这里的形状不是随便定的，它是一条数据兼容约定 ——
 * 改动它会需要一次数据迁移，而那正是要避免的事。
 *
 * 旧数据不受影响：既有行 id 不变，本函数只用于**新**消息。
 */

/** 12 字节 = 24 hex，与 `generateId('cm')` 逐字同构。 */
export function newMessageId(): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // 极老运行时兜底（jsdom 之外几乎不会走到）：仍然产出同形状的 24 hex。
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `cm_${hex}`;
}

/** 这个 id 是否是我们自己铸的（即：可能还没落库）。 */
export function looksLikeClientMessageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^cm_[0-9a-f]{24}$/.test(id);
}
