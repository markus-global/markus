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

export function formatEvolveTranscript(
  messages: EvolveSourceMessage[],
  opts?: { focusMessageId?: string; focusText?: string },
): { transcript: string; truncated: boolean; focusMarked: boolean } {
  // getMessages returns newest-first; reverse for chronological reading
  const chronological = [...messages].reverse();
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  let focusMarked = false;

  for (const m of chronological) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : m.role;
    const toolLines: string[] = [];
    for (const seg of m.metadata?.segments ?? []) {
      if (seg.type === 'tool' && seg.tool) {
        const status = seg.status ?? 'done';
        const resultOne = (seg.result ?? '').replace(/\s+/g, ' ').slice(0, 120);
        toolLines.push(`  [tool ${seg.tool} ${status}]${resultOne ? ` ${resultOne}` : ''}`);
      }
    }
    const body = (m.content || '').trim();
    const isFocus =
      (!!opts?.focusMessageId && m.id === opts.focusMessageId) ||
      (!!opts?.focusText && body.length > 0 && body === opts.focusText.trim());
    if (isFocus) focusMarked = true;
    const header = `${isFocus ? '>>> FOCUS ' : ''}[${m.id ?? '?'}][${m.createdAt ?? ''}] ${role}:`;
    const block = [header, body, ...toolLines].filter(Boolean).join('\n');
    if (lines.length >= EVOLVE_TRANSCRIPT_MAX_MESSAGES || chars + block.length > EVOLVE_TRANSCRIPT_MAX_CHARS) {
      truncated = true;
      break;
    }
    lines.push(block);
    chars += block.length + 2;
  }

  return {
    transcript: lines.join('\n\n') || '(no messages in parent session)',
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
    '3. Follow Learning Habits — choose the lightest store: memory_save, memory_update_longterm (MEMORY.md), ROLE.md, HEARTBEAT.md, or create a skill under builder-artifacts/skills/ then package_install with impact low/high.',
    '4. Ask via request_user_input before high-impact ROLE identity/scope rewrites or skill impact:"high" installs.',
    '5. Summarize what you encoded at the end. This is a personal evolution session — do not casually continue the parent chat.',
  );
  return parts.join('\n');
}
