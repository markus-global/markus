import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAGE } from '../routes.ts';
import { navBus } from '../navBus.ts';
import { api, type AgentInfo, type HumanUserInfo } from '../api.ts';
import { Avatar } from './Avatar.tsx';
import { inferChipKind, type ChipKind } from '../lib/chatChips.ts';

/**
 * One row of the conversation picker.
 *
 * `snippet` needs a per-session last message, which `listByAgent` does not return
 * (it carries title + lastMessageAt only). Rather than invent a new backend
 * contract, the picker reuses the existing `GET /sessions/:id/messages?limit=1`
 * — at most one lightweight request per session, fired only after the user has
 * picked an agent, and a failure simply leaves the row without a snippet.
 */
export interface SendToSessionRow {
  id: string;
  title: string | null;
  lastMessageAt: string;
  snippet: string | null;
  snippetFailed: boolean;
}

const SNIPPET_MAX = 80;

function snippetFrom(content: string): string {
  const flat = content
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/\[(?:terminal|html|file|deliverable|task|requirement)-?[a-z]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat;
}

/** Load the agent's conversations (bounded) with one snippet request each. */
export async function loadSendToSessions(agentId: string): Promise<SendToSessionRow[]> {
  const res = await api.sessions.listByAgent(agentId, 20, 1);
  const rows = res.sessions ?? [];
  const withSnippets = await Promise.all(rows.map(async (s): Promise<SendToSessionRow> => {
    try {
      const got = await api.sessions.getMessages(s.id, 1);
      const latest = got.messages?.[0];
      return {
        id: s.id,
        title: s.title,
        lastMessageAt: s.lastMessageAt,
        snippet: latest?.content ? snippetFrom(latest.content) || null : null,
        snippetFailed: false,
      };
    } catch {
      // A missing snippet must not hide the conversation — the row stays usable.
      return { id: s.id, title: s.title, lastMessageAt: s.lastMessageAt, snippet: null, snippetFailed: true };
    }
  }));
  return withSnippets;
}

/**
 * "Send to conversation" — one implementation, shared by every detail surface
 * (task, requirement, deliverable).
 *
 * The contract is deliberately narrow: the caller hands over the context CHIP
 * that will ride above the chat input, and this module handles the target
 * picker + navigation. Keeping one implementation means the chip format, the
 * default recipient rule and the "adds a chip, does not prefill text" behaviour
 * can never drift between surfaces.
 */

/** Minimal shape of anything sendable (requirement / task / deliverable). */
export type ChatSendableEntity = {
  id: string;
  title?: string;
  status?: string;
  priority?: string;
  createdBy?: string;
  projectId?: string | null;
};

/** Default recipient = creator (agent or human); fall back to the first agent. */
export function resolveDefaultChatTarget(
  createdBy: string | undefined,
  agents: AgentInfo[],
  users: HumanUserInfo[],
): string {
  if (createdBy) {
    if (agents.some(a => a.id === createdBy)) return `agent:${createdBy}`;
    if (users.some(u => u.id === createdBy)) return `human:${createdBy}`;
  }
  if (agents[0]) return `agent:${agents[0].id}`;
  if (users[0]) return `human:${users[0].id}`;
  return '';
}

/** Shorten a title for a chip label without losing its tail. */
export function shortForChip(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 24)}…${trimmed.slice(-12)}` : trimmed;
}

/** Detail-panel header button that opens the picker. */
export function SendToChatButton({ onClick, label, className }: {
  onClick: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={className ?? 'shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border-default text-xs text-fg-secondary hover:text-brand-500 hover:border-brand-500/40 hover:bg-brand-500/10 transition-colors'}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <line x1="12" y1="7" x2="12" y2="11" />
        <line x1="10" y1="9" x2="14" y2="9" />
      </svg>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/**
 * Pick an agent / member, then land in Team Chat with the context chip already
 * attached above the input — the user can add their own words before sending.
 *
 * Card 7 ② adds the SESSION dimension: an agent usually owns several
 * conversations, so after picking the agent the picker asks WHICH one — but only
 * when there is more than one (a single-conversation agent must not cost an extra
 * click). The chosen session travels as `sessionId` on the navigation params and
 * Team.tsx switches to it.
 */
export function SendToChatModal({ chipKind, chipLabel, chipContent, agents, users, defaultTarget, onClose }: {
  chipKind?: ChipKind;
  chipLabel: string;
  chipContent: string;
  agents: AgentInfo[];
  users: HumanUserInfo[];
  defaultTarget?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['work', 'common']);
  const [target, setTarget] = useState(() => defaultTarget || resolveDefaultChatTarget(undefined, agents, users));
  const [query, setQuery] = useState('');
  // Second level: which conversation of the picked agent.
  const [sessionStep, setSessionStep] = useState(false);
  const [sessionState, setSessionState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [sessionRows, setSessionRows] = useState<SendToSessionRow[]>([]);
  const sessionLoadSeq = useRef(0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (label: string) => !q || label.toLowerCase().includes(q);
    return [
      ...agents.filter(a => hit(a.name)).map(a => ({ value: `agent:${a.id}`, name: a.name, meta: a.status, isAgent: true, avatarUrl: a.avatarUrl })),
      ...users.filter(u => hit(u.name)).map(u => ({ value: `human:${u.id}`, name: u.name, meta: '', isAgent: false, avatarUrl: u.avatarUrl })),
    ];
  }, [agents, users, query]);

  // Open the picker on the *selected* row: with 20+ agents the current target
  // used to sit below the fold, so the modal looked like nothing was chosen.
  // Scroll once on open; after that the list belongs to the user.
  const listRef = useRef<HTMLDivElement | null>(null);
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current) return;
    const list = listRef.current;
    if (!list) return;
    const selectedRow = list.querySelector<HTMLElement>('[data-selected="true"]');
    if (!selectedRow) return;
    didInitialScroll.current = true;
    // `block: 'nearest'` keeps an already-visible row still.
    try {
      selectedRow.scrollIntoView({ block: 'nearest' });
    } catch { /* jsdom / older engines: no layout, nothing to scroll */ }
  }, [rows]);

  const [targetType, targetId] = target.split(':');
  const targetName = targetType === 'agent'
    ? (agents.find(a => a.id === targetId)?.name ?? '')
    : (users.find(u => u.id === targetId)?.name ?? '');

  // Legacy callers pass only a label: resolve the kind ONCE, here, so everything
  // downstream (pill + payload) uses the structured value.
  const kind: ChipKind = chipKind ?? inferChipKind(chipContent, chipLabel);

  const sendTo = (sessionId?: string) => {
    if (!target) return;
    const [type, id] = target.split(':');
    const params: Record<string, string> = {
      chatChips: JSON.stringify([{ kind, label: chipLabel, content: chipContent }]),
    };
    if (type === 'agent') params.agentId = id;
    else params.dm = id;
    // Only agents own conversations; a human DM has no session dimension.
    if (sessionId) params.sessionId = sessionId;
    navBus.navigate(PAGE.TEAM, params);
    onClose();
  };

  const loadSessions = async (agentId: string) => {
    const seq = ++sessionLoadSeq.current;
    setSessionState('loading');
    try {
      const rows = await loadSendToSessions(agentId);
      if (seq !== sessionLoadSeq.current) return;
      setSessionRows(rows);
      setSessionState('ok');
    } catch {
      if (seq !== sessionLoadSeq.current) return;
      setSessionRows([]);
      // The failure is VISIBLE (banner + retry); sending still works and lands in
      // the agent's default conversation — never a silent no-op.
      setSessionState('error');
    }
  };

  const handleSend = () => {
    if (!target) return;
    const [type, id] = target.split(':');
    if (type !== 'agent') { sendTo(); return; }
    // Ask "which conversation" only when there is a real choice.
    void (async () => {
      const seq = ++sessionLoadSeq.current;
      setSessionStep(true);
      setSessionState('loading');
      try {
        const rows = await loadSendToSessions(id);
        if (seq !== sessionLoadSeq.current) return;
        setSessionRows(rows);
        setSessionState('ok');
        if (rows.length === 0) { sendTo(); return; }              // no history → new conversation
        if (rows.length === 1) { sendTo(rows[0]!.id); return; }   // the only one → no extra click
      } catch {
        if (seq !== sessionLoadSeq.current) return;
        setSessionRows([]);
        setSessionState('error');
      }
    })();
  };

  const formatWhen = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return t('common:justNow', { defaultValue: 'just now' });
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return d.toLocaleDateString();
  };

  return (
    <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[85vh] flex flex-col bg-surface-primary border border-border-default rounded-2xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b border-border-default shrink-0">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold text-fg-primary">
              {t('work:task.sendToChatTitle', { defaultValue: '发送到对话' })}
            </h3>
            <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-xl leading-none -mt-1" aria-label={t('common:close')}>&times;</button>
          </div>
          <p className="mt-1 text-xs text-fg-tertiary leading-relaxed">
            {t('work:task.sendToChatHint', { defaultValue: '选择要发送到的对话，它会作为上下文标签加入输入框，你可以接着补充说明。' })}
          </p>
        </div>

        {/* Session step (②): which conversation of the picked agent. */}
        {sessionStep && (
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2" data-send-to-sessions>
            <div className="px-2 pb-1 text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider">
              {t('work:task.sendToChatSessions', { defaultValue: 'Conversation' })}
            </div>
            <p className="px-2 pb-2 text-[11px] text-fg-tertiary leading-relaxed">
              {t('work:task.sendToChatSessionHint', { defaultValue: 'This agent has several conversations — pick the one to send into.' })}
            </p>
            {sessionState === 'loading' && (
              <div className="px-3 py-6 text-center text-xs text-fg-tertiary" data-send-to-sessions-loading>
                {t('common:loading', { defaultValue: 'Loading…' })}
              </div>
            )}
            {sessionState === 'error' && (
              <div className="mx-1 mb-2 px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-500 leading-relaxed" data-send-to-sessions-error>
                {t('work:task.sendToChatSessionError', { defaultValue: 'Could not load the conversations — sending to the default conversation instead.' })}
                <div className="mt-1.5 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => { const [, id] = target.split(':'); if (id) void loadSessions(id); }}
                    className="underline hover:no-underline"
                    data-send-to-sessions-retry
                  >
                    {t('work:task.sendToChatSessionRetry', { defaultValue: 'Retry' })}
                  </button>
                  {/* A load failure must never dead-end the send: the same "send
                      anyway (default conversation)" escape is one click away. */}
                  <button
                    type="button"
                    onClick={() => sendTo()}
                    className="underline hover:no-underline"
                    data-send-to-default-session
                  >
                    {t('work:task.sendToChatConfirm', { defaultValue: '发送到对话' })}
                  </button>
                </div>
              </div>
            )}
            {sessionState === 'ok' && sessionRows.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-fg-tertiary" data-send-to-sessions-empty>
                {t('work:task.sendToChatSessionEmpty', { defaultValue: 'No conversations yet — this goes to a new one.' })}
              </div>
            )}
            {sessionState === 'ok' && sessionRows.map(row => (
              <button
                key={row.id}
                type="button"
                onClick={() => sendTo(row.id)}
                data-session-id={row.id}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-surface-elevated transition-colors"
              >
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 min-w-0 truncate text-sm text-fg-primary">
                    {row.title?.trim() || t('work:task.sendToChatSessionNoSummary', { defaultValue: 'No message yet' })}
                  </span>
                  <span className="text-[10px] text-fg-tertiary shrink-0">{formatWhen(row.lastMessageAt)}</span>
                </div>
                <div className="text-[11px] text-fg-tertiary truncate">
                  {row.snippetFailed
                    ? t('work:task.sendToChatSessionNoSummary', { defaultValue: 'No message yet' })
                    : (row.snippet ?? t('work:task.sendToChatSessionNoSummary', { defaultValue: 'No message yet' }))}
                </div>
              </button>
            ))}
            {sessionState === 'ok' && sessionRows.length > 0 && (
              <button
                type="button"
                onClick={() => sendTo()}
                className="w-full text-left px-3 py-2 mt-1 rounded-lg text-xs text-fg-secondary hover:bg-surface-elevated transition-colors"
                data-send-to-new-session
              >
                + {t('work:task.sendToChatSessionEmpty', { defaultValue: 'No conversations yet — this goes to a new one.' })}
              </button>
            )}
          </div>
        )}

        {/* Target picker */}
        <div className={`px-5 pt-3 pb-2 shrink-0 ${sessionStep ? 'hidden' : ''}`}>
          <label className="block text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1">
            {t('work:task.sendToChatTarget', { defaultValue: '发送给' })}
          </label>
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-tertiary pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('work:task.sendToChatSearch', { defaultValue: '搜索智能体或成员…' })}
              className="w-full pl-8 pr-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary outline-none focus:border-brand-500 placeholder:text-fg-tertiary"
            />
          </div>
          <div className="mt-1.5 text-[11px] text-fg-tertiary truncate">
            {targetName
              ? `${t('work:task.sendToChatTarget', { defaultValue: '发送给' })}：${targetName}`
              : t('work:task.sendToChatNoTarget', { defaultValue: '当前没有可发送的对象' })}
          </div>
        </div>

        {/* Target list */}
        <div className={`flex-1 min-h-0 overflow-y-auto px-2 pb-2 ${sessionStep ? 'hidden' : ''}`} ref={listRef}>
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-fg-tertiary">
              {t('work:task.sendToChatEmpty', { defaultValue: '没有匹配的对象' })}
            </div>
          ) : rows.map((r, i) => {
            const newGroup = i === 0 || rows[i - 1]!.isAgent !== r.isAgent;
            const selected = r.value === target;
            return (
              <div key={r.value}>
                {newGroup && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider">
                    {r.isAgent
                      ? t('work:task.sendToChatAgents', { defaultValue: '智能体' })
                      : t('work:task.sendToChatHumans', { defaultValue: '成员' })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setTarget(r.value)}
                  data-selected={selected ? 'true' : 'false'}
                  aria-current={selected ? 'true' : undefined}
                  className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                    selected ? 'bg-brand-500/15 text-brand-500 font-medium' : 'text-fg-secondary hover:bg-surface-elevated'
                  }`}
                >
                  <Avatar
                    name={r.name}
                    avatarUrl={r.avatarUrl}
                    size={22}
                    fallback={r.isAgent ? 'initials' : 'icon'}
                  />
                  <span className="flex-1 min-w-0 truncate text-sm">{r.name}</span>
                  {r.meta && <span className="text-[10px] text-fg-tertiary shrink-0">{r.meta}</span>}
                  {selected && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer: context preview + actions */}
        <div className="px-5 py-3 border-t border-border-default bg-surface-secondary/40 shrink-0">
          <span className="block text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1">
            {t('work:task.sendToChatContext', { defaultValue: '将加入的上下文标签' })}
          </span>
          <span
            className="inline-flex items-center gap-1 max-w-full pl-2 pr-2 py-1 rounded-lg bg-brand-500/10 text-brand-500 text-xs border border-brand-500/20"
            title={chipContent}
            data-chip-kind={kind}
          >
            <span className="truncate">{chipLabel}</span>
          </span>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={sessionStep ? () => setSessionStep(false) : onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-border-default text-fg-secondary hover:bg-surface-elevated transition-colors"
            >
              {sessionStep
                ? t('common:back', { defaultValue: 'Back' })
                : t('common:cancel')}
            </button>
            {!sessionStep && (
              <button
                type="button"
                onClick={handleSend}
                disabled={!target}
                className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 text-on-brand font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('work:task.sendToChatConfirm', { defaultValue: '发送到对话' })}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
