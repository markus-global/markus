/**
 * teamPanels — Self-contained display panels for the Team chat page.
 *
 * Extracted from Team.tsx (the 2000+-line orchestration component) so that
 * genuinely independent UI surfaces can be tested and evolved on their own.
 * These panels are pure: every mutation (search, membership changes) is
 * delegated to callbacks provided by the owner, keeping Team.tsx as the single
 * owner of state and side effects.
 */
import { useTranslation } from 'react-i18next';
import { Avatar } from '../components/Avatar.tsx';
import type { SearchResult } from '../api.ts';

/** Group-chat member row handed to the panel (a safe projection of groupChats. */ 
export interface PanelMember { id: string; name: string; type: 'human' | 'agent' }
/** Candidate to add to a group chat (union of agents + humans not yet members). */
export interface PanelCandidate extends PanelMember { subtitle: string }

/* ── Chat search panel ─────────────────────────────────────────────────────── */

export interface ChatSearchPanelProps {
  searchQuery: string;
  searchLoading: boolean;
  searchResults: SearchResult[];
  onInputChange: (q: string) => void;
  onResultClick: (r: SearchResult) => void;
  onClose: () => void;
}

export function ChatSearchPanel({
  searchQuery, searchLoading, searchResults,
  onInputChange, onResultClick, onClose,
}: ChatSearchPanelProps) {
  const { t } = useTranslation(['team', 'common']);
  return (
    <div className="border-b border-border-default bg-surface-secondary/50 px-4 py-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            autoFocus
            value={searchQuery}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
            placeholder={t('page.searchPlaceholder')}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg outline-none focus:border-brand-500/50 transition-colors"
          />
        </div>
        <button
          onClick={onClose}
          className="text-fg-tertiary hover:text-fg-secondary text-xs px-1"
        >✕</button>
      </div>
      {searchLoading && (
        <div className="flex items-center gap-2 text-xs text-fg-tertiary py-1">
          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          {t('page.searching')}
        </div>
      )}
      {!searchLoading && searchQuery.length >= 2 && searchResults.length === 0 && (
        <div className="text-xs text-fg-tertiary py-1">{t('page.noSearchResults')}</div>
      )}
      {searchResults.length > 0 && (
        <div className="max-h-60 overflow-y-auto space-y-0.5">
          {searchResults.map(r => (
            <button
              key={r.id}
              onClick={() => onResultClick(r)}
              className="w-full text-left px-3 py-2 rounded-lg hover:bg-surface-elevated transition-colors group"
            >
              <div className="flex items-center gap-2 text-[11px] text-fg-tertiary mb-0.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${r.source === 'channel' ? 'bg-blue-500/10 text-blue-500' : 'bg-emerald-500/10 text-emerald-500'}`}>
                  {r.source === 'channel' ? '#' : '1:1'}
                </span>
                {r.senderName && <span>{r.senderName}</span>}
                <span>{new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              </div>
              <div className="text-xs text-fg-secondary line-clamp-2 group-hover:text-fg-primary transition-colors">
                {r.text.length > 200 ? r.text.slice(0, 200) + '…' : r.text}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Group chat member management panel ───────────────────────────────────── */

export interface GroupMemberPanelProps {
  members: PanelMember[];
  candidates: PanelCandidate[];
  currentUserId?: string;
  memberCount: number;
  onClose: () => void;
  onRemoveMember: (memberId: string) => void;
  onAddMember: (candidateId: string) => void;
}

export function GroupMemberPanel({
  members, candidates, currentUserId, memberCount,
  onClose, onRemoveMember, onAddMember,
}: GroupMemberPanelProps) {
  const { t } = useTranslation(['team', 'common']);
  return (
    <div className="bg-surface-secondary/80 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-fg-secondary">{t('page.members')} ({memberCount})</span>
        <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-xs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {members.map(m => (
          <span key={m.id} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium ${
            m.type === 'agent' ? 'bg-brand-500/10 text-brand-500' : 'bg-green-500/10 text-green-600'
          }`}>
            <Avatar name={m.name} size={16} bgClass={m.type === 'agent' ? 'bg-brand-500/15 text-brand-500' : 'bg-green-500/15 text-green-600'} />
            {m.name}
            {m.id !== currentUserId && (
              <button
                onClick={() => onRemoveMember(m.id)}
                className="ml-0.5 hover:text-red-500 transition-colors"
                title={t('common:remove')}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            )}
          </span>
        ))}
      </div>
      {candidates.length > 0 && (
        <div className="mt-1">
          <select
            className="w-full bg-surface-primary border border-border-default rounded-lg px-2.5 py-1.5 text-xs text-fg-primary outline-none focus:ring-1 focus:ring-brand-500/50"
            value=""
            onChange={e => { if (e.target.value) onAddMember(e.target.value); }}
          >
            <option value="">{t('page.addMemberPlaceholder')}</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>[{c.type === 'agent' ? 'Agent' : 'Human'}] {c.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}