/**
 * Remember-from-message helpers (LEARNING-LOOP §9).
 */

export const EVOLVE_TRANSCRIPT_MAX_MESSAGES = 40;
export const EVOLVE_TRANSCRIPT_MAX_CHARS = 24_000;

export interface EvolveSourceMessage {
  id?: string;
  role: string;
  content: string;
  createdAt?: string;
  metadata?: {
    segments?: Array<{
      type?: string;
      tool?: string;
      status?: string;
      result?: string;
      content?: string;
    }>;
  } | null;
}

function formatToolSegmentLine(seg: NonNullable<NonNullable<EvolveSourceMessage['metadata']>['segments']>[number]): string | null {
  if (seg.type !== 'tool' || !seg.tool) return null;
  const status = seg.status ?? 'done';
  const resultOne = (seg.result ?? '').replace(/\s+/g, ' ').slice(0, 120);
  return `  [tool ${seg.tool} ${status}]${resultOne ? ` ${resultOne}` : ''}`;
}

/** Emit turn body in segment order (tools ↔ text). Fallback content after tools when segments omit text. */
function formatTurnBodyLines(m: EvolveSourceMessage): string[] {
  const segments = m.metadata?.segments ?? [];
  const bodyLines: string[] = [];
  let emittedText = false;

  for (const seg of segments) {
    if (seg.type === 'tool') {
      const line = formatToolSegmentLine(seg);
      if (line) bodyLines.push(line);
      continue;
    }
    if (seg.type === 'text') {
      const text = (seg.content ?? '').trim();
      if (text) {
        bodyLines.push(text);
        emittedText = true;
      }
    }
  }

  const fallback = (m.content || '').trim();
  // Tool-only / empty segment lists still carry the final reply in `content`.
  if (!emittedText && fallback) bodyLines.push(fallback);
  return bodyLines;
}

function messageTimeMs(m: EvolveSourceMessage): number {
  if (!m.createdAt) return 0;
  const t = Date.parse(m.createdAt);
  return Number.isFinite(t) ? t : 0;
}

export function formatEvolveTranscript(
  messages: EvolveSourceMessage[],
  opts?: { focusMessageId?: string; focusText?: string },
): { transcript: string; truncated: boolean; focusMarked: boolean } {
  // chatSessionRepo.getMessages already returns oldest→newest; sort defensively
  // so callers that pass either order still get chronological reading order.
  const chronological = [...messages].sort((a, b) => messageTimeMs(a) - messageTimeMs(b));
  const blocks: string[] = [];
  let focusMarked = false;

  for (const m of chronological) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : m.role;
    const body = (m.content || '').trim();
    const bodyLines = formatTurnBodyLines(m);
    const isFocus =
      (!!opts?.focusMessageId && m.id === opts.focusMessageId) ||
      (!!opts?.focusText && body.length > 0 && body === opts.focusText.trim());
    if (isFocus) focusMarked = true;
    const header = `${isFocus ? '>>> FOCUS ' : ''}[${m.id ?? '?'}][${m.createdAt ?? ''}] ${role}:`;
    blocks.push([header, ...bodyLines].filter(Boolean).join('\n'));
  }

  // Keep the most recent window under caps, still emit oldest→newest.
  const selected: string[] = [];
  let chars = 0;
  let truncated = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (selected.length >= EVOLVE_TRANSCRIPT_MAX_MESSAGES || chars + block.length > EVOLVE_TRANSCRIPT_MAX_CHARS) {
      truncated = true;
      break;
    }
    selected.unshift(block);
    chars += block.length + 2;
  }

  return {
    transcript: selected.join('\n\n') || '(no messages in parent session)',
    truncated,
    focusMarked,
  };
}

export function buildEvolveSeedPrompt(opts: {
  parentSessionId: string;
  evolutionSessionId: string;
  sourceMessageId?: string;
  userNote?: string;
  transcript: string;
  truncated: boolean;
}): string {
  const parts = [
    '[EVOLUTION REQUEST — Remember from conversation]',
    '',
    'You are in a personal evolution session. Review the source conversation and encode durable lessons.',
    `parentSessionId: ${opts.parentSessionId}`,
    `evolutionSessionId: ${opts.evolutionSessionId}`,
  ];
  if (opts.sourceMessageId) parts.push(`sourceMessageId (focus): ${opts.sourceMessageId}`);
  if (opts.userNote?.trim()) {
    parts.push('', '## User note (highest priority)', opts.userNote.trim());
  }
  parts.push(
    '',
    '## Source conversation',
    opts.truncated
      ? '(Transcript may be truncated — older messages omitted.)'
      : '(Full recent window attached.)',
    '',
    opts.transcript,
    '',
    '## Instructions',
    '1. Review the Source conversation (user corrections, outcomes, and tool actions). Prefer lessons grounded in user feedback.',
    `2. If truncated or insufficient, fetch more with: recall_context({ scope: "chat_session", session_id: "${opts.parentSessionId}", limit: 40, before: "<oldest ISO timestamp>" }).`,
    '3. Before encoding: `memory_search` related themes so you patch/update instead of duplicating.',
    '4. Follow Learning Habits — me vs others, lightest store wins:',
    '   - Only helps you → memory: one lesson = `memory_save` once `{ content, type:"insight", tags }` (never an array); your multi-step = `memory_update` / `memory_update_longterm` on a knowledge.md section (`patch`/`append` preferred).',
    '   - Helps other agents as an executable playbook/MCP flow → Skill under `builder-artifacts/skills/` then `package_install` (impact low/high). Skill = steps/tools/boundaries, not a diary dump.',
    '   - Always-on rule → ROLE.md; patrol → HEARTBEAT.md.',
    '5. Ask via request_user_input before high-impact ROLE identity/scope rewrites or skill impact:"high" installs.',
    '6. Verify every write via tool JSON (`status` + `store:"knowledge.md"`). On error, fix and retry — never claim encoded without success.',
    '7. End with a short table of what actually saved (tool status, store, section/id or skill name) — not intentions. This is a personal evolution session; do not casually continue the parent chat.',
  );
  return parts.join('\n');
}
