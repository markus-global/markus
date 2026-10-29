/**
 * Feishu Interactive Message Card builders.
 * These create card JSON payloads for rich agent interactions.
 */

export interface CardAction {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'primary' | 'default' | 'danger';
  value: Record<string, string>;
}

/**
 * A button on an outbound notification card. `ref` is the **signed** action ref
 * the gateway produced — the card carries it opaquely in the button `value`, and
 * the inbound side (`respondToApproval`) verifies it on tap. The internal
 * approval id never appears in the clear.
 */
export interface NotificationCardAction {
  id: string;
  label: string;
  style?: 'primary' | 'default' | 'danger';
  ref: string;
}

/**
 * Build the interactive card an outbound notification/approval is rendered as
 * (slice T2). The `notifyTarget`-annotated adaptation lives in the adapter; this
 * is the card dialect itself: header + markdown body + one action row of
 * buttons, each carrying its signed `ref` so a tap completes the approval.
 *
 * Feishu button `value` must be a flat string map; `ref` and the command id are
 * both strings, and only `ref` is a secret (the command is not).
 */
export function buildNotificationCard(opts: {
  title: string;
  body: string;
  actions?: NotificationCardAction[];
  /** Who sent it — shown in the card's footnote, the origin's own slot. */
  origin?: { agentName?: string; teamName?: string };
}): Record<string, unknown> {
  const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: opts.body } }];

  // Origin footnote (the card's extension area): the agent that produced the
  // notification, with the team appended when it belongs to one. Structure in,
  // not a line we asked the body to carry — so the same fact has one source.
  const originText = originNote(opts.origin);
  if (originText) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: originText }] });
  }

  const actions = (opts.actions ?? []).filter((a) => a.ref);
  if (actions.length > 0) {
    elements.push({
      tag: 'action',
      actions: actions.map((a) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.label },
        type: a.style ?? 'default',
        // `ref` is verified inbound; `action` is a non-secret fallback label.
        value: { ref: a.ref, action: a.id },
      })),
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: 'blue',
    },
    elements,
  };
}

/** `来自 X · 团队 Y`, or `来自 X`, or nothing when no agent is known. */
function originNote(origin?: { agentName?: string; teamName?: string }): string | undefined {
  const name = origin?.agentName?.trim();
  if (!name) return undefined;
  const team = origin?.teamName?.trim();
  return team ? `来自 ${name} · 团队 ${team}` : `来自 ${name}`;
}

/** Platform ids are opaque payload — never let one inject card markup. */
const SAFE_ACTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Feishu renders `<…>` in `lark_md` as markup, so text carrying it is not text. */
const MARKUP_CHARS = /[<>]/;

/**
 * How the resolved card names **who acted**. A bare `open_id` is a string no human
 * can read, and until 2026-10-16 that is exactly what the card showed — the name
 * lookup silently degrades (the contact API answers `code:0` but *omits* `name`
 * unless the app holds `contact:user.base:readonly` and the user is inside its
 * contact visibility range), and the old fallback printed the id.
 *
 * So the ladder ends somewhere legible either way:
 *   1. the resolved display name — reads the same, and does **not** ping anyone;
 *   2. a live person reference `<at id=…>` — Feishu resolves the display name and
 *      makes it tappable **without any contact scope** (verified against the card
 *      markdown reference: `@指定人会显示为用户名`).
 *
 * Both rungs are **checked, because both are attacker-controlled**: a display name
 * can be set to `<at id=all></at>` by any tenant member, and the id arrives from the
 * platform event. A value carrying markup never reaches the card — the mention is
 * used instead, and if there is no id to mention there is simply no actor line.
 * Printing the raw string as a "safe fallback" was tested and does inject: text
 * interpolated into a `lark_md` element is still markup.
 */
function actorFact(name?: string, id?: string): string | undefined {
  const resolved = name?.trim();
  if (resolved && !MARKUP_CHARS.test(resolved)) return resolved;
  const raw = id?.trim();
  if (!raw || !SAFE_ACTOR_ID.test(raw)) return undefined;
  return `<at id=${raw}></at>`;
}

/** Header words + colour per terminal status. */
const RESOLVED_APPROVAL_HEADER: Record<
  'approved' | 'rejected' | 'cancelled' | 'expired' | 'pending',
  { icon: string; label: string; template: string }
> = {
  approved: { icon: '✅', label: '已批准', template: 'green' },
  rejected: { icon: '❌', label: '已驳回', template: 'red' },
  cancelled: { icon: '⚪', label: '已取消', template: 'grey' },
  expired: { icon: '⏰', label: '已超时', template: 'grey' },
  // 点击没有落账（例如需要到应用内回答的表单）——**不是超时**。把「还没记录」
  // 画成「已超时」是另一种谎：人会以为请求失效了，于是重发一份。
  pending: { icon: '⏳', label: '未记录 · 请到 Markus 应用内回答', template: 'orange' },
};

/** Render an ISO timestamp compactly, without pretending to know the reader's TZ. */
function formatResolvedAt(at: string): string {
  const iso = at.trim();
  // `2026-10-13T11:33:25.123Z` → `2026-10-13 11:33 UTC`
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/**
 * The card an approval turns into once it has been decided. Same header + body as
 * the request card, **minus the action row** — the buttons are gone and a status
 * line takes their place, so a tap leaves visible evidence instead of a card that
 * looks untouched.
 *
 * Without this the tapper gets no feedback at all: an interactive card is a
 * one-shot message, and the platform never edits it for us.
 */
export function buildResolvedApprovalCard(opts: {
  title: string;
  body: string;
  status: 'approved' | 'rejected' | 'cancelled' | 'expired' | 'pending';
  actorId?: string;
  actorName?: string;
  selectedOption?: string;
  at?: string;
}): Record<string, unknown> {
  const head = RESOLVED_APPROVAL_HEADER[opts.status];
  const facts: string[] = [`**${head.icon} ${head.label}**`];
  // A named option carries more than approve/reject — surface what was chosen.
  if (opts.selectedOption && opts.selectedOption !== 'approve' && opts.selectedOption !== 'reject') {
    facts.push(`选项：\`${opts.selectedOption}\``);
  }
  // Prefer the resolved display name; fall back to the raw id (always correct).
  const actor = actorFact(opts.actorName, opts.actorId);
  if (actor) facts.push(`操作人：${actor}`);
  if (opts.at) facts.push(`时间：${formatResolvedAt(opts.at)}`);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: head.template,
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: opts.body } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: facts.join('\n') } },
    ],
  };
}

export function buildStatusCard(opts: {
  agentName: string;
  title: string;
  content: string;
  status: 'success' | 'warning' | 'error' | 'info';
  actions?: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
}) {
  const colorMap = { success: 'green', warning: 'orange', error: 'red', info: 'blue' };

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: opts.content } },
  ];

  if (opts.actions?.length) {
    elements.push({
      tag: 'action',
      actions: opts.actions.map((a) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.text },
        type: a.type ?? 'default',
        value: { action: a.value, agent: opts.agentName },
      })),
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: colorMap[opts.status] ?? 'blue',
    },
    elements,
  };
}

export function buildTaskCard(opts: {
  agentName: string;
  taskId: string;
  taskTitle: string;
  description: string;
  priority: string;
  status: string;
}) {
  const priorityEmoji: Record<string, string> = {
    urgent: '🔴', high: '🟠', medium: '🔵', low: '⚪',
  };

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 ${opts.taskTitle}` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Priority:** ${priorityEmoji[opts.priority] ?? ''} ${opts.priority}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Status:** ${opts.status}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Agent:** ${opts.agentName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Task ID:** ${opts.taskId}` } },
        ],
      },
      { tag: 'div', text: { tag: 'lark_md', content: opts.description } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Mark Complete' },
            type: 'primary',
            value: { action: 'complete_task', taskId: opts.taskId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Reassign' },
            type: 'default',
            value: { action: 'reassign_task', taskId: opts.taskId },
          },
        ],
      },
    ],
  };
}

export function buildProgressCard(opts: {
  agentName: string;
  title: string;
  steps: Array<{ name: string; done: boolean }>;
  summary?: string;
}) {
  const stepsContent = opts.steps
    .map((s) => `${s.done ? '✅' : '⬜'} ${s.name}`)
    .join('\n');

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: stepsContent } },
  ];

  if (opts.summary) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: opts.summary } });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: 'blue',
    },
    elements,
  };
}

// ── Agent Response Cards (Phase 2: Streaming Status) ───────────────────

export type AgentCardPhase = 'thinking' | 'tool_calling' | 'responding' | 'done' | 'error';

export interface ToolCallEntry {
  name: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

/**
 * Build an interactive card showing agent processing status.
 * This card is sent once and then updated in-place as the agent progresses.
 */
export function buildAgentResponseCard(opts: {
  agentName: string;
  phase: AgentCardPhase;
  toolCalls?: ToolCallEntry[];
  content?: string;
  errorMessage?: string;
  elapsedMs?: number;
}) {
  const { agentName, phase, toolCalls, content, errorMessage, elapsedMs } = opts;

  const headerMap: Record<AgentCardPhase, { title: string; template: string }> = {
    thinking:     { title: `💭 ${agentName} 正在思考...`, template: 'blue' },
    tool_calling: { title: `🔧 ${agentName} 正在执行...`, template: 'blue' },
    responding:   { title: `✍️ ${agentName} 正在回复...`, template: 'blue' },
    done:         { title: `✅ ${agentName}`, template: 'green' },
    error:        { title: `❌ ${agentName} 处理失败`, template: 'red' },
  };

  const header = headerMap[phase];
  const elements: unknown[] = [];

  if (toolCalls?.length) {
    const toolLines = toolCalls.map(tc => {
      if (tc.status === 'running') return `⏳ 正在调用 \`${tc.name}\`...`;
      if (tc.status === 'error') return `❌ \`${tc.name}\` 失败`;
      const dur = tc.durationMs !== null && tc.durationMs !== undefined ? ` (${tc.durationMs}ms)` : '';
      return `✅ \`${tc.name}\` 完成${dur}`;
    }).join('\n');
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: toolLines } });
  }

  if (phase === 'thinking' && !toolCalls?.length && !content) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '正在分析您的消息...' } });
  }

  if (content) {
    if (toolCalls?.length) {
      elements.push({ tag: 'hr' });
    }
    elements.push({ tag: 'div', text: { tag: 'lark_md', content } });
  }

  if (errorMessage) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**错误:** ${errorMessage}` } });
  }

  if (phase === 'done' && elapsedMs !== null && elapsedMs !== undefined) {
    const seconds = (elapsedMs / 1000).toFixed(1);
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `耗时 ${seconds}s` }],
    });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '...' } });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: header.title },
      template: header.template,
    },
    elements,
  };
}
