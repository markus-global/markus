/**
 * Detect DM replies that are pure acknowledgments / standby chatter.
 * These must not be auto-chained to the peer (otherwise agents ping-pong forever).
 *
 * Important: compound phrases like "收到，保持待命。" strip to `收到保持待命`,
 * which a single-token regex misses — so we greedily consume known ack tokens.
 */

const ACK_TOKENS = [
  '消息已送达',
  '继续待命',
  '保持待命',
  '待命中',
  '已送达',
  '知道了',
  'soundsgood',
  'understood',
  'acknowledge',
  'acknowledged',
  'gotit',
  'gotcha',
  'willdo',
  'standby',
  'waiting',
  'okay',
  'copy',
  'noted',
  'roger',
  'sure',
  'ack',
  'ok',
  '收到',
  '好的',
  '了解',
  '明白',
  '确认',
  '遵命',
  '待命',
  '没问题',
  '可以',
  '好',
].sort((a, b) => b.length - a.length);

/** True when the message is only acknowledgment / standby tokens (any combination). */
export function isDmPureAcknowledgment(text: string): boolean {
  const stripped = text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  if (!stripped) return true;

  let rest = stripped;
  let matchedAny = false;
  while (rest.length > 0) {
    let hit = false;
    for (const tok of ACK_TOKENS) {
      if (rest.startsWith(tok.toLowerCase())) {
        rest = rest.slice(tok.length);
        matchedAny = true;
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return matchedAny;
}

/**
 * Secretary/coordinator mistakenly pastes "X 回复说：…" back into the peer DM
 * instead of notifying the human. That re-triggers the peer and starts an ACK loop.
 */
export function isDmMisdirectedRelay(text: string): boolean {
  const t = text.trim();
  if (!/回复说[：:]/.test(t) && !/转达[：:]/.test(t)) return false;
  // Still allow if it clearly asks the peer a new question.
  if (/[？?]/.test(t)) return false;
  if (/(请|麻烦|帮|能否|要不要|需要你|你觉得)/.test(t)) return false;
  return true;
}
