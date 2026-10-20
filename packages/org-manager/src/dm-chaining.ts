/**
 * Should a DM reply wake the peer?
 *
 * Background (measured 2026-10-19/20): DM channels auto-triggered the peer on
 * EVERY reply ("IM-style back-and-forth", api-server), with only a per-channel
 * cooldown. An agent with 10 channels therefore had ~10x the allowed wake rate
 * with no global ceiling: one agent logged 43 turns in 35 minutes and 103 DMs
 * to 10 peers; 4 messages from a single sender cost 31.6M tokens.
 *
 * Protocol precedent: MCP's notification semantics are one-way —
 * "receiver MUST NOT send a response". A2A's `Message` is a stateless
 * interaction turn, not a wake-up signal. Auto-replying to every message is the
 * thing those specs deliberately avoid.
 *
 * Rule (single source of truth):
 *   - a HUMAN speaking in the channel always gets a chained agent reply;
 *   - an AGENT's reply chains only when it actually asks the peer for something.
 * Everything else is a status report: deliver it, do not wake anyone.
 */

/** Markers that a message expects the peer to do/say something. */
const ASK_PATTERNS: RegExp[] = [
  // Direct questions (ASCII and CJK)
  /\?/,
  /[？]/,
  // Explicit requests for action or judgement
  /\b(please|pls|could you|can you|would you|need you to|kindly)\b/i,
  /\b(confirm|approve|review|decide|clarify|check|verify|provide|send|share|choose|pick)\b/i,
  /\b(what|which|when|where|who|how|why)\b/i,
  // CJK request/decision markers
  /(请|麻烦|帮我|需要你|确认一下|确认下|是否|要不要|能不能|可不可以|如何|怎么|为什么|哪个|哪一|什么时候|请回复|回复我|给个|定一下|拍板)/,
];

/** Phrases that explicitly hand control back without expecting a reply. */
const NO_ASK_PATTERNS: RegExp[] = [
  /^\s*(收到|好的|ok|okay|roger|noted|ack|understood)\s*[。.!！]*\s*$/i,
  /只是同步|仅同步|仅告知|供参考|fyi|no response needed|无需回复|不必回复|不用回复/i,
];

export interface DmChainDecision {
  chain: boolean;
  reason: 'human_sender' | 'asks_peer' | 'no_ask' | 'explicit_no_reply' | 'empty';
}

/**
 * Decide whether `agentId`'s DM reply should wake the peer.
 *
 * @param replyText   the just-sent reply content
 * @param senderType  who produced it ('agent' | 'human')
 */
export function shouldChainDmReply(replyText: string, senderType: 'agent' | 'human'): DmChainDecision {
  const text = (replyText ?? '').trim();
  if (senderType === 'human') return { chain: true, reason: 'human_sender' };
  if (!text) return { chain: false, reason: 'empty' };
  if (NO_ASK_PATTERNS.some((re) => re.test(text))) return { chain: false, reason: 'explicit_no_reply' };
  if (ASK_PATTERNS.some((re) => re.test(text))) return { chain: true, reason: 'asks_peer' };
  return { chain: false, reason: 'no_ask' };
}
