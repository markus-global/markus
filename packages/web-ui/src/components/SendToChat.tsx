import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAGE } from '../routes.ts';
import { navBus } from '../navBus.ts';
import type { AgentInfo, HumanUserInfo } from '../api.ts';

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
 */
export function SendToChatModal({ chipLabel, chipContent, agents, users, defaultTarget, onClose }: {
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

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (label: string) => !q || label.toLowerCase().includes(q);
    return [
      ...agents.filter(a => hit(a.name)).map(a => ({ value: `agent:${a.id}`, name: a.name, meta: a.status, isAgent: true })),
      ...users.filter(u => hit(u.name)).map(u => ({ value: `human:${u.id}`, name: u.name, meta: '', isAgent: false })),
    ];
  }, [agents, users, query]);

  const [targetType, targetId] = target.split(':');
  const targetName = targetType === 'agent'
    ? (agents.find(a => a.id === targetId)?.name ?? '')
    : (users.find(u => u.id === targetId)?.name ?? '');

  const handleSend = () => {
    if (!target) return;
    const [type, id] = target.split(':');
    const params: Record<string, string> = {
      chatChips: JSON.stringify([{ label: chipLabel, content: chipContent }]),
    };
    if (type === 'agent') params.agentId = id;
    else params.dm = id;
    navBus.navigate(PAGE.TEAM, params);
    onClose();
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

        {/* Target picker */}
        <div className="px-5 pt-3 pb-2 shrink-0">
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
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
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
                  className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors ${
                    selected ? 'bg-brand-500/15 text-brand-500 font-medium' : 'text-fg-secondary hover:bg-surface-elevated'
                  }`}
                >
                  <span className="w-5 h-5 flex items-center justify-center text-sm shrink-0">{r.isAgent ? '🤖' : '👤'}</span>
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
          >
            <span className="truncate">{chipLabel}</span>
          </span>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-border-default text-fg-secondary hover:bg-surface-elevated transition-colors"
            >
              {t('common:cancel')}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={!target}
              className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('work:task.sendToChatConfirm', { defaultValue: '发送到对话' })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
