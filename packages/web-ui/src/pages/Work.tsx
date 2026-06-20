import { useState, useEffect, useCallback, useMemo, useRef, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, wsClient, ApiError, invalidateApiCache, type ProjectInfo, type TaskInfo, type AgentInfo, type TaskLogEntry, type TaskComment, type RequirementComment, type RequirementInfo, type HumanUserInfo, type RoundSummary, type AuthUser, type ActivityRecord, type StatusTransitionInfo, type WorkflowInfo, type WorkflowRunInfo, type WorkflowTemplateInfo } from '../api.ts';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { MemoExecEntryRow, ThinkingDots, StreamingText, filterCompletedStarts, streamEntryToExecEntry, attachSubagentLogsToEntries, FullExecutionLog, type ExecEntry, type ExecutionStreamEntryUI } from '../components/ExecutionTimeline.tsx';
import { taskLogToStreamEntry, activityLogToStreamEntry } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';
import { ContentRenderer } from '../components/ContentRenderer.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { ActivityIndicator, type ActivityStep } from '../components/ActivityIndicator.tsx';
import { TaskDAG } from '../components/TaskDAG.tsx';
import { NewProjectModal } from '../components/NewProjectModal.tsx';
import { CommentInput, type PendingImage } from '../components/CommentInput.tsx';
import { navBus } from '../navBus.ts';
import { PAGE, resolvePageId, hashPath } from '../routes.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { usePageActive } from '../hooks/usePageActive.ts';
import { useResizablePanel } from '../hooks/useResizablePanel.ts';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import { MobileMenuButton } from '../components/MobileMenuButton.tsx';

/* ── useDropdownPosition: compute fixed position for dropdown escaping overflow containers ── */
function useDropdownPosition(triggerRef: React.RefObject<HTMLDivElement | null>, open: boolean) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number; flipUp?: boolean } | null>(null);
  useEffect(() => {
    if (!open || !triggerRef.current) { setPos(null); return; }
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxH = 240; // max-h-60 = 15rem = 240px
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const flipUp = spaceBelow < maxH && spaceAbove > spaceBelow;
      if (flipUp) {
        setPos({ top: rect.top - 4, left: rect.left, width: rect.width, flipUp: true });
      } else {
        setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width, flipUp: false });
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [open, triggerRef]);
  return pos;
}

/* ── SearchableSelect: filterable dropdown for create modals ── */
function SearchableSelect({ options, value, onChange, placeholder, noMatchesText, className }: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  noMatchesText?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pos = useDropdownPosition(triggerRef, open);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const selectedLabel = options.find(o => o.value === value)?.label ?? '';
  const filtered = query
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  return (
    <div ref={ref} className={className ?? ''}>
      <div
        ref={triggerRef}
        onClick={() => { setOpen(!open); setQuery(''); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus-within:border-brand-500 outline-none flex items-center cursor-pointer"
      >
        {open ? (
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onClick={e => e.stopPropagation()}
            className="w-full bg-transparent outline-none text-fg-primary text-sm"
            placeholder={selectedLabel || placeholder}
            autoFocus
          />
        ) : (
          <span className={selectedLabel ? 'text-fg-primary' : 'text-fg-tertiary'}>
            {selectedLabel || placeholder}
          </span>
        )}
        <svg className="w-4 h-4 ml-auto text-fg-tertiary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </div>
      {open && pos && (
        <div ref={dropdownRef} className="fixed z-[100] max-h-60 overflow-y-auto bg-surface-elevated border border-border-default rounded-lg shadow-lg"
          style={pos.flipUp
            ? { bottom: window.innerHeight - pos.top, left: pos.left, width: pos.width }
            : { top: pos.top, left: pos.left, width: pos.width }}>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-fg-tertiary">{noMatchesText ?? 'No matches'}</div>
          ) : filtered.map(o => (
            <div
              key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); setQuery(''); }}
              className={`px-3 py-2 text-sm cursor-pointer hover:bg-brand-500/10 ${o.value === value ? 'bg-brand-500/10 text-brand-500 font-medium' : 'text-fg-primary'}`}
            >{o.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── MultiSearchableSelect: filterable dropdown for multi-value selection ── */
function MultiSearchableSelect({ options, selected, onAdd, placeholder, noMatchesText, className }: {
  options: { value: string; label: string }[];
  selected: string[];
  onAdd: (v: string) => void;
  placeholder?: string;
  noMatchesText?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pos = useDropdownPosition(triggerRef, open);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const available = options.filter(o => !selected.includes(o.value));
  const filtered = query
    ? available.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : available;

  return (
    <div ref={ref} className={className ?? ''}>
      <div
        ref={triggerRef}
        onClick={() => { setOpen(!open); setQuery(''); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus-within:border-brand-500 outline-none flex items-center cursor-pointer"
      >
        {open ? (
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onClick={e => e.stopPropagation()}
            className="w-full bg-transparent outline-none text-fg-primary text-sm"
            placeholder={placeholder}
            autoFocus
          />
        ) : (
          <span className="text-fg-tertiary">{placeholder}</span>
        )}
        <svg className="w-4 h-4 ml-auto text-fg-tertiary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </div>
      {open && pos && (
        <div ref={dropdownRef} className="fixed z-[100] max-h-60 overflow-y-auto bg-surface-elevated border border-border-default rounded-lg shadow-lg"
          style={pos.flipUp
            ? { bottom: window.innerHeight - pos.top, left: pos.left, width: pos.width }
            : { top: pos.top, left: pos.left, width: pos.width }}>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-fg-tertiary">{noMatchesText ?? 'No matches'}</div>
          ) : filtered.map(o => (
            <div
              key={o.value}
              onClick={() => { onAdd(o.value); setQuery(''); }}
              className="px-3 py-2 text-sm cursor-pointer hover:bg-brand-500/10 text-fg-primary"
            >{o.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function resolveActorName(id: string | undefined, agents: AgentInfo[], users: HumanUserInfo[], adminLabel = 'Admin'): string | null {
  if (!id) return null;
  const agent = agents.find(a => a.id === id);
  if (agent) return agent.name;
  const user = users.find(u => u.id === id);
  if (user) return user.name;
  if (id === 'anonymous') return adminLabel;
  return null;
}

function AgentNameLink({ agentId, agents }: { agentId: string; agents: AgentInfo[] }) {
  const { t } = useTranslation(['work', 'common']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const agent = agents.find(a => a.id === agentId);
  const displayName = agent?.name ?? agentId.slice(0, 10);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-block">
      <button onClick={() => setOpen(!open)} className="text-brand-500 hover:text-brand-500 hover:underline cursor-pointer">
        {displayName}
      </button>
      {open && agent && (
        <div className="absolute left-0 bottom-full mb-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-40 w-56 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-brand-600/30 flex items-center justify-center text-[10px] font-bold text-brand-500">
              {agent.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-fg-primary font-medium truncate">{agent.name}</div>
              <div className="text-[10px] text-fg-tertiary">{agent.role} · {agent.agentRole ?? t('work:task.workerRole')}</div>
            </div>
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              agent.status === 'working' ? 'bg-blue-400 animate-pulse'
              : agent.status === 'error' ? 'bg-red-400'
              : (agent.lastError && agent.lastErrorAt && (Date.now() - new Date(agent.lastErrorAt).getTime()) < 30 * 60 * 1000) ? 'bg-amber-400'
              : 'bg-green-400'
            }`} />
          </div>
          <button
            onClick={() => { setOpen(false); navBus.navigate(PAGE.TEAM, { selectAgent: agent.id }); }}
            className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1 transition-colors"
          >
            {t('work:task.viewProfile')}
          </button>
        </div>
      )}
      {open && !agent && (
        <div className="absolute left-0 bottom-full mb-1.5 bg-surface-secondary border border-border-default rounded-xl shadow-2xl z-40 w-40 p-2">
          <div className="text-[10px] text-fg-tertiary">{t('work:task.agentNotFound', { id: agentId.slice(0, 12) })}</div>
        </div>
      )}
    </span>
  );
}

// ─── Inline Editable Text ────────────────────────────────────────────────────────

function InlineEditableText({ value, onSave, className, placeholder }: {
  value: string;
  onSave: (v: string) => Promise<void>;
  className?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation(['work', 'common']);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = async () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      try { await onSave(trimmed); } catch { setDraft(value); }
    } else {
      setDraft(value);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className={`bg-transparent border-b border-brand-500/50 outline-none ${className ?? ''}`}
        placeholder={placeholder}
      />
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      className={`cursor-pointer hover:border-b hover:border-gray-600 transition-colors ${className ?? ''}`}
      title={t('work:task.clickToEdit')}
    >{value || <span className="text-fg-tertiary italic">{placeholder ?? t('work:task.clickToEdit')}</span>}</span>
  );
}

function InlineEditableTextarea({ value, onSave, className, placeholder }: {
  value: string;
  onSave: (v: string) => Promise<void>;
  className?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation(['work', 'common']);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.style.height = 'auto'; ref.current.style.height = ref.current.scrollHeight + 'px'; } }, [editing]);

  const commit = async () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) {
      try { await onSave(trimmed); } catch { setDraft(value); }
    } else {
      setDraft(value);
    }
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        onChange={e => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
        onBlur={() => void commit()}
        onKeyDown={e => { if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className={`bg-transparent border border-brand-500/30 rounded-lg p-2 outline-none resize-none w-full ${className ?? ''}`}
        placeholder={placeholder}
        rows={2}
      />
    );
  }

  return (
    <p
      onClick={() => setEditing(true)}
      className={`cursor-pointer hover:bg-surface-elevated/50 rounded-lg transition-colors px-2 py-1 -mx-2 -my-1 ${className ?? ''}`}
      title={t('work:task.clickToEdit')}
    >{value || <span className="text-fg-tertiary italic">{placeholder ?? t('work:task.addDescription')}</span>}</p>
  );
}

// ─── Note Parser & Comment ──────────────────────────────────────────────────────

interface ParsedNote {
  timestamp: string;
  author: string;
  content: string;
}

const NOTE_RE = /^\[([^\]]+?)(?:\s+by\s+([^\]]+))?\]\s*([\s\S]*)$/;

function parseNote(raw: string): ParsedNote {
  const m = raw.match(NOTE_RE);
  if (m) {
    return { timestamp: m[1]!.trim(), author: m[2]?.trim() ?? 'System', content: m[3]!.trim() };
  }
  return { timestamp: '', author: '', content: raw };
}

function formatNoteTime(ts: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!ts) return '';
  const dateMatch = ts.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!dateMatch) return ts;
  const now = new Date();
  const year = +dateMatch[1]!;
  const month = +dateMatch[2]! - 1;
  const day = +dateMatch[3]!;
  const hour = +dateMatch[4]!;
  const min = +dateMatch[5]!;
  const noteDate = new Date(year, month, day, hour, min);
  const diff = now.getTime() - noteDate.getTime();
  if (diff < 60000) return t('work:relative.justNow');
  if (diff < 3600000) return t('work:relative.minutesAgo', { count: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('work:relative.hoursAgo', { count: Math.floor(diff / 3600000) });
  if (diff < 604800000) return t('work:relative.daysAgo', { count: Math.floor(diff / 86400000) });
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const AUTHOR_COLORS = [
  { bg: 'bg-brand-600/30', text: 'text-brand-500', border: 'border-brand-500/30' },
  { bg: 'bg-blue-600/30', text: 'text-blue-400', border: 'border-blue-500/30' },
  { bg: 'bg-green-600/30', text: 'text-green-400', border: 'border-green-500/30' },
  { bg: 'bg-amber-600/30', text: 'text-amber-400', border: 'border-amber-500/30' },
  { bg: 'bg-purple-600/30', text: 'text-purple-400', border: 'border-purple-500/30' },
  { bg: 'bg-pink-600/30', text: 'text-pink-400', border: 'border-pink-500/30' },
];

function authorColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return AUTHOR_COLORS[Math.abs(hash) % AUTHOR_COLORS.length]!;
}

function NoteComment({ note, compact }: { note: string; compact?: boolean }) {
  const { t } = useTranslation(['work', 'common']);
  const parsed = parseNote(note);
  const systemLabel = t('work:task.systemAuthor');
  const c = authorColor(parsed.author || systemLabel);
  const initials = parsed.author
    ? parsed.author.split(/[\s_-]+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : 'SY';
  const timeLabel = formatNoteTime(parsed.timestamp, t);
  const isSystem = !parsed.author || parsed.author === 'System';

  if (compact) {
    return (
      <div className="flex gap-2.5 group">
        <div className={`w-6 h-6 rounded-full ${c.bg} flex items-center justify-center text-[9px] font-bold ${c.text} shrink-0 mt-0.5`}>{initials}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 mb-0.5">
            <span className={`text-[11px] font-medium ${isSystem ? 'text-fg-tertiary' : c.text}`}>{isSystem ? systemLabel : parsed.author}</span>
            {timeLabel && <span className="text-[10px] text-fg-tertiary">{timeLabel}</span>}
          </div>
          <div className="text-xs text-fg-secondary"><MarkdownMessage content={parsed.content} className="text-xs text-fg-secondary" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 group">
      <div className="flex flex-col items-center shrink-0">
        <div className={`w-7 h-7 rounded-full ${c.bg} flex items-center justify-center text-[10px] font-bold ${c.text}`}>{initials}</div>
        <div className="w-px flex-1 bg-border-default/60 mt-1.5" />
      </div>
      <div className="flex-1 min-w-0 pb-4">
        <div className={`border ${c.border} rounded-lg overflow-hidden`}>
          <div className={`flex items-center gap-2 px-3 py-1.5 ${c.bg} border-b ${c.border}`}>
            <span className={`text-[11px] font-medium ${isSystem ? 'text-fg-secondary' : c.text}`}>{isSystem ? systemLabel : parsed.author}</span>
            {timeLabel && <span className="text-[10px] text-fg-tertiary">{timeLabel}</span>}
          </div>
          <div className="px-3 py-2.5">
            <MarkdownMessage content={parsed.content} className="text-xs text-fg-secondary" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const ALL_STATUSES = ['pending', 'in_progress', 'blocked', 'review', 'completed', 'failed', 'rejected', 'cancelled', 'archived'] as const;
const CLOSED_STATUSES_SET = new Set(['rejected', 'cancelled', 'archived']);

const BOARD_COLUMNS_BASE = [
  { id: 'failed',      statuses: ['failed'],                  accent: 'border-t-red-500',    dropStatus: 'failed' },
  { id: 'todo',        statuses: ['pending'],                 accent: 'border-t-amber-500',  dropStatus: 'pending' },
  { id: 'in_progress', statuses: ['in_progress', 'blocked'],  accent: 'border-t-brand-500',  dropStatus: 'in_progress' },
  { id: 'review',      statuses: ['review'],                  accent: 'border-t-purple-500', dropStatus: 'review' },
  { id: 'done',        statuses: ['completed'],               accent: 'border-t-green-500',  dropStatus: 'completed' },
  { id: 'closed',      statuses: ['rejected', 'cancelled', 'archived'], accent: 'border-t-gray-500',   dropStatus: 'cancelled' },
] as const;

const SUB_STATUS_BADGE_CLS: Record<string, string> = {
  pending:  'bg-amber-500/15 text-amber-600',
  blocked:  'bg-amber-500/15 text-amber-600',
  failed:   'bg-red-500/15 text-red-500',
  rejected: 'bg-red-500/15 text-red-500',
};
const TASK_STATUS_BADGE_CLS: Record<string, string> = {
  pending:     'bg-amber-500/15 text-amber-600',
  in_progress: 'bg-blue-500/15 text-blue-500',
  blocked:     'bg-orange-500/15 text-orange-500',
  review:      'bg-purple-500/15 text-purple-500',
  revision:    'bg-amber-500/15 text-amber-600',
  completed:   'bg-green-500/15 text-green-600',
  failed:      'bg-red-500/15 text-red-500',
  rejected:    'bg-red-500/15 text-red-500',
  cancelled:   'bg-gray-500/15 text-fg-tertiary',
  archived:    'bg-gray-500/15 text-fg-tertiary',
};
const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'border-l-red-500', high: 'border-l-amber-500', medium: 'border-l-blue-500', low: 'border-l-gray-500',
};
const PRIORITY_BADGE_CLS: Record<string, string> = {
  low:    'bg-gray-500/15 text-fg-tertiary',
  medium: 'bg-blue-500/15 text-blue-500',
  high:   'bg-amber-500/15 text-amber-600',
  urgent: 'bg-red-500/15 text-red-500',
};
const REQ_STATUS_BADGE_CLS: Record<string, string> = {
  pending:     'bg-amber-500/15 text-amber-600',
  in_progress: 'bg-brand-500/15 text-brand-500',
  completed:   'bg-green-500/15 text-green-600',
  rejected:    'bg-red-500/15 text-red-500',
  cancelled:   'bg-gray-600/15 text-fg-tertiary',
  archived:    'bg-gray-600/10 text-fg-tertiary/60',
};

function buildTaskStatusBadges(t: (key: string, opts?: Record<string, unknown>) => string): Record<string, { label: string; cls: string }> {
  return (Object.keys(TASK_STATUS_BADGE_CLS) as string[]).reduce((acc, k) => {
    acc[k] = { label: t(`work:status.task.${k}`), cls: TASK_STATUS_BADGE_CLS[k]! };
    return acc;
  }, {} as Record<string, { label: string; cls: string }>);
}
function buildSubStatusBadges(t: (key: string, opts?: Record<string, unknown>) => string): Record<string, { label: string; cls: string }> {
  return (Object.keys(SUB_STATUS_BADGE_CLS) as string[]).reduce((acc, k) => {
    acc[k] = { label: t(`work:status.sub.${k}`), cls: SUB_STATUS_BADGE_CLS[k]! };
    return acc;
  }, {} as Record<string, { label: string; cls: string }>);
}
function buildPriorityBadges(t: (key: string, opts?: Record<string, unknown>) => string): Record<string, { label: string; cls: string }> {
  return (Object.keys(PRIORITY_BADGE_CLS) as string[]).reduce((acc, k) => {
    acc[k] = { label: t(`work:priority.${k}`), cls: PRIORITY_BADGE_CLS[k]! };
    return acc;
  }, {} as Record<string, { label: string; cls: string }>);
}
function buildReqStatusBadges(t: (key: string, opts?: Record<string, unknown>) => string): Record<string, { label: string; cls: string }> {
  return (Object.keys(REQ_STATUS_BADGE_CLS) as string[]).reduce((acc, k) => {
    acc[k] = { label: t(`work:status.requirement.${k}`), cls: REQ_STATUS_BADGE_CLS[k]! };
    return acc;
  }, {} as Record<string, { label: string; cls: string }>);
}
const PRIORITY_CYCLE = ['low', 'medium', 'high', 'urgent'] as const;
const TASK_STATUS_CYCLE = ['pending', 'in_progress', 'blocked', 'review', 'completed', 'failed', 'rejected', 'cancelled'] as const;
const REQ_STATUS_CYCLE = ['pending', 'in_progress', 'completed', 'rejected', 'cancelled'] as const;

// Mirror of TASK_TRANSITIONS from @markus/shared — kept in sync manually
const TASK_ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending:     new Set(['in_progress', 'blocked', 'rejected', 'cancelled']),
  in_progress: new Set(['review', 'blocked', 'failed', 'cancelled']),
  blocked:     new Set(['in_progress', 'cancelled']),
  review:      new Set(['completed', 'in_progress', 'cancelled']),
  completed:   new Set(['archived', 'in_progress']),
  failed:      new Set(['in_progress', 'archived']),
  rejected:    new Set(['archived']),
  cancelled:   new Set(['archived']),
  archived:    new Set([]),
};
const REQ_ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending:     new Set(['in_progress', 'rejected', 'cancelled']),
  in_progress: new Set(['completed', 'cancelled']),
  completed:   new Set([]),
  rejected:    new Set([]),
  cancelled:   new Set([]),
};
const STATUS_DOT: Record<string, string> = {
  idle: 'bg-green-400', working: 'bg-blue-400', error: 'bg-red-400', paused: 'bg-amber-400', offline: 'bg-gray-600',
  pending: 'bg-amber-400',
  in_progress: 'bg-brand-400', blocked: 'bg-amber-400',
  review: 'bg-brand-400', completed: 'bg-green-400',
  failed: 'bg-red-400', rejected: 'bg-red-400', cancelled: 'bg-gray-600', archived: 'bg-surface-overlay',
};
const AGENT_STATUS_TEXT: Record<string, string> = {
  idle: 'text-green-500', working: 'text-blue-500', error: 'text-red-500', paused: 'text-amber-500', offline: 'text-fg-muted',
};

type ViewMode = 'all' | 'project';

// ─── Comment Bubble ──────────────────────────────────────────────────────────────

function MentionPopover({ agent, anchorRect, onClose }: {
  agent: AgentInfo;
  anchorRect: { top: number; left: number };
  onClose: () => void;
}) {
  const { t } = useTranslation(['work', 'common']);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const hasRecentError = agent.status !== 'error' && !!agent.lastError && !!agent.lastErrorAt
    && (Date.now() - new Date(agent.lastErrorAt).getTime()) < 30 * 60 * 1000;
  const statusColor = agent.status === 'idle' && !hasRecentError ? 'bg-green-400'
    : agent.status === 'working' && !hasRecentError ? 'bg-blue-400 animate-pulse'
    : agent.status === 'error' ? 'bg-red-400'
    : hasRecentError ? 'bg-amber-400'
    : 'bg-gray-500';
  const statusLabel = agent.status === 'idle' ? t('work:task.online') : agent.status === 'working' ? t('work:task.working') : agent.status === 'error' ? t('work:task.error') : t('work:task.offline');

  return (
    <div
      ref={ref}
      className="fixed z-50 w-56 bg-surface-secondary border border-border-default rounded-xl shadow-2xl p-3 space-y-2"
      style={{ top: anchorRect.top + 4, left: anchorRect.left }}
    >
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-brand-500/15 flex items-center justify-center text-[10px] font-bold text-brand-600 shrink-0">
          {agent.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-fg-primary font-medium truncate">{agent.name}</div>
          <div className="text-[10px] text-fg-tertiary">{agent.role}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[10px] text-fg-secondary">{statusLabel}</span>
          </div>
        </div>
      </div>
      <button
        onClick={() => { onClose(); navBus.navigate(PAGE.TEAM, { selectAgent: agent.id }); }}
        className="w-full text-center text-[10px] text-brand-500 hover:text-brand-500 border border-border-default hover:border-gray-600 rounded-lg py-1 transition-colors"
      >
        {t('work:task.viewProfile')}
      </button>
    </div>
  );
}

function CommentBubble({ comment, agents, onReply }: {
  comment: TaskComment | RequirementComment;
  agents: AgentInfo[];
  onReply?: (comment: TaskComment | RequirementComment) => void;
}) {
  const { t } = useTranslation(['work', 'common']);
  const isAgent = comment.authorType === 'agent' || comment.authorType === 'system';
  const ts = new Date(comment.createdAt);
  const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = ts.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const [mentionPopover, setMentionPopover] = useState<{ agent: AgentInfo; top: number; left: number } | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const [logEntries, setLogEntries] = useState<ExecutionStreamEntryUI[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  const handleMentionClick = useCallback((name: string, event: React.MouseEvent) => {
    const agent = agents.find(a => a.name.toLowerCase() === name.toLowerCase());
    if (agent) {
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      setMentionPopover({ agent, top: rect.bottom, left: rect.left });
    }
  }, [agents]);

  const agentNames = useMemo(() => agents.map(a => a.name), [agents]);

  const handleAvatarClick = useCallback((e: React.MouseEvent) => {
    const agent = agents.find(a => a.name.toLowerCase() === comment.authorName.toLowerCase());
    if (agent) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMentionPopover({ agent, top: rect.bottom, left: rect.left });
    }
  }, [agents, comment.authorName]);

  const toggleExecutionLog = useCallback(async () => {
    if (logExpanded) { setLogExpanded(false); return; }
    const aid = comment.activityId;
    if (!aid) return;
    setLogExpanded(true);
    if (logEntries.length > 0) return;
    setLogLoading(true);
    try {
      const { logs } = await api.agents.getActivityLogs(comment.authorId, aid);
      const entries = logs
        .map(l => activityLogToStreamEntry(l, aid, comment.authorId))
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map(e => ({ ...e, ts: new Date(e.createdAt).getTime() }));
      setLogEntries(entries);
    } catch { /* ignore */ }
    setLogLoading(false);
  }, [logExpanded, logEntries.length, comment]);

  const execEntries = useMemo(
    () => filterCompletedStarts(logEntries.map(streamEntryToExecEntry).filter((e): e is ExecEntry => e !== null)),
    [logEntries],
  );

  return (
    <div className="flex gap-2.5 group py-1" id={`comment-${comment.id}`}>
      <div
        onClick={handleAvatarClick}
        className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] mt-0.5 cursor-pointer transition-all hover:ring-1 hover:ring-brand-500/40 ${
          isAgent ? 'bg-indigo-500/20 text-indigo-400' : 'bg-blue-500/20 text-blue-400'
        }`}
      >
        {comment.authorName.slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span
            className={`text-[11px] font-medium cursor-pointer hover:underline ${isAgent ? 'text-indigo-400' : 'text-blue-400'}`}
            onClick={handleAvatarClick}
          >
            {comment.authorName}
          </span>
          <span className="text-fg-tertiary text-[10px]">{dateStr} {timeStr}</span>
          {onReply && (
            <button
              onClick={() => onReply(comment)}
              className="text-fg-tertiary hover:text-fg-secondary text-[10px] opacity-0 group-hover:opacity-100 transition-opacity ml-1"
            >
              {t('work:task.reply')}
            </button>
          )}
          {comment.activityId && isAgent && (
            <button
              onClick={toggleExecutionLog}
              className="text-fg-tertiary hover:text-brand-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity ml-1"
            >
              {logExpanded ? t('work:task.hideLog') : t('work:task.viewLog')}
            </button>
          )}
        </div>
        {comment.replyTo && comment.replyToAuthor && (
          <button
            onClick={() => {
              const el = document.getElementById(`comment-${comment.replyTo}`);
              if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('bg-brand-500/10'); setTimeout(() => el.classList.remove('bg-brand-500/10'), 1500); }
            }}
            className="flex items-center gap-1.5 mb-1 pl-2 py-0.5 border-l-2 border-brand-500/40 text-[10px] text-fg-tertiary hover:text-fg-secondary transition-colors cursor-pointer"
          >
            <span className="font-medium text-brand-500/70">{comment.replyToAuthor}</span>
            <span className="truncate max-w-[200px]">{comment.replyToContent ?? '...'}</span>
          </button>
        )}
        <MarkdownMessage content={comment.content} className="text-xs text-fg-primary" onMentionClick={handleMentionClick} knownNames={agentNames} />
        {comment.attachments?.map((att, i) => (
          att.type === 'image' ? <img key={i} src={att.url} alt={att.name} className="mt-1 max-w-[200px] rounded" /> : null
        ))}
        {logExpanded && (
          <div className="mt-2 border border-border-subtle rounded-lg overflow-hidden bg-surface-secondary/30">
            {logLoading ? (
              <div className="p-3 text-xs text-fg-tertiary">{t('work:task.loadingExecutionLog')}</div>
            ) : execEntries.length === 0 ? (
              <div className="p-3 text-xs text-fg-tertiary">{t('work:task.noExecutionLogAvailable')}</div>
            ) : (
              <FullExecutionLog entries={logEntries} isActive={false} onCollapse={() => setLogExpanded(false)} embedded />
            )}
          </div>
        )}
      </div>
      {mentionPopover && (
        <MentionPopover
          agent={mentionPopover.agent}
          anchorRect={{ top: mentionPopover.top, left: mentionPopover.left }}
          onClose={() => setMentionPopover(null)}
        />
      )}
    </div>
  );
}

// ─── Unified Activity & Comments Section (Details tab) ─────────────────────────

type ActivityItem = { type: 'note'; note: string; ts: Date } | { type: 'comment'; comment: TaskComment; ts: Date };

function TaskActivitySection({ task, agents, users, authUser }: {
  task: TaskInfo;
  agents: AgentInfo[];
  users: HumanUserInfo[];
  authUser?: { id: string; name: string };
}) {
  const { t } = useTranslation(['work', 'common']);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [thinkingAgents, setThinkingAgents] = useState<Array<{ id: string; name: string; avatarUrl?: string }>>([]);
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [agentActivities, setAgentActivities] = useState<Map<string, ActivityStep[]>>(new Map());

  useEffect(() => {
    setThinkingAgents([]);
    setAgentActivities(new Map());
    if (thinkingTimeoutRef.current) { clearTimeout(thinkingTimeoutRef.current); thinkingTimeoutRef.current = null; }
    api.tasks.getComments(task.id).then(r => setComments(r.comments)).catch(() => {});
  }, [task.id]);

  useEffect(() => {
    const unsub = wsClient.on('task:comment', (msg: { payload?: { taskId?: string; comment?: TaskComment } }) => {
      if (msg.payload?.taskId === task.id && msg.payload.comment) {
        const c = msg.payload.comment;
        setComments(prev => {
          if (prev.some(x => x.id === c.id)) return prev;
          return [...prev, c];
        });
        if (c.authorType === 'agent' || c.authorId?.startsWith('agt_')) {
          setThinkingAgents(prev => {
            const next = prev.filter(a => a.id !== c.authorId);
            if (next.length === 0 && thinkingTimeoutRef.current) {
              clearTimeout(thinkingTimeoutRef.current);
              thinkingTimeoutRef.current = null;
            }
            return next;
          });
          setAgentActivities(prev => {
            const next = new Map(prev);
            next.delete(c.authorId);
            return next;
          });
        }
      }
    });
    return unsub;
  }, [task.id]);

  // Subscribe to agent activity logs during thinking period
  useEffect(() => {
    if (thinkingAgents.length === 0) return;
    const thinkingIds = new Set(thinkingAgents.map(a => a.id));
    const unsub = wsClient.on('agent:activity_log', (event: { payload?: Record<string, unknown> }) => {
      const p = event.payload as Record<string, unknown> | undefined;
      if (!p) return;
      const agentId = p['agentId'] as string;
      if (!thinkingIds.has(agentId)) return;
      const evtType = p['type'] as string;
      if (evtType === 'tool_start' || evtType === 'tool_end') {
        const tool = (p['content'] as string) ?? (p['metadata'] as Record<string, unknown>)?.['tool'] as string ?? '';
        const step: ActivityStep = {
          tool,
          phase: evtType === 'tool_start' ? 'start' : 'end',
          success: evtType === 'tool_end' ? (p['metadata'] as Record<string, unknown>)?.['success'] !== false : undefined,
          ts: Date.now(),
        };
        setAgentActivities(prev => {
          const next = new Map(prev);
          const list = [...(next.get(agentId) ?? []), step];
          next.set(agentId, list);
          return next;
        });
      }
    });
    return unsub;
  }, [thinkingAgents]);

  const items = useMemo<ActivityItem[]>(() => {
    const result: ActivityItem[] = [];
    for (const note of (task.notes ?? [])) {
      const parsed = parseNote(note);
      let ts: Date;
      if (parsed.timestamp) {
        const m = parsed.timestamp.match(/^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
        ts = m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)) : new Date(0);
      } else {
        ts = new Date(0);
      }
      result.push({ type: 'note', note, ts });
    }
    for (const c of comments) {
      result.push({ type: 'comment', comment: c, ts: new Date(c.createdAt) });
    }
    result.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    return result;
  }, [task.notes, comments]);

  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; content: string } | null>(null);

  const handleSubmit = async (content: string, mentions: string[], images: PendingImage[], replyToId?: string) => {
    let attachments: Array<{ type: string; url: string; name: string }> | undefined;
    if (images.length > 0) {
      const uploaded = await api.uploads.upload(images.map(img => ({ dataUrl: img.dataUrl, name: img.name })), 'comments');
      attachments = uploaded.files.map(f => ({ type: 'image', url: f.url, name: f.name }));
    }
    await api.tasks.addComment(task.id, content, authUser?.name, attachments, authUser?.id, mentions.length > 0 ? mentions : undefined, replyToId);
    const notified: Array<{ id: string; name: string; avatarUrl?: string }> = [];
    const seen = new Set<string>();
    const tryAdd = (agentId: string) => {
      if (seen.has(agentId) || agentId === authUser?.id) return;
      seen.add(agentId);
      const a = agents.find(ag => ag.id === agentId);
      if (a) notified.push({ id: a.id, name: a.name, avatarUrl: a.avatarUrl });
    };
    for (const name of mentions) {
      const a = agents.find(ag => ag.name.toLowerCase() === name.toLowerCase());
      if (a) tryAdd(a.id);
    }
    if (task.assignedAgentId) tryAdd(task.assignedAgentId);
    if (task.createdBy?.startsWith('agt_') && task.status !== 'in_progress') tryAdd(task.createdBy);
    if (notified.length > 0) {
      if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current);
      setThinkingAgents(notified);
      thinkingTimeoutRef.current = setTimeout(() => setThinkingAgents([]), 120_000);
    }
  };

  const handleReply = useCallback((c: TaskComment | RequirementComment) => {
    setReplyTo({ id: c.id, authorName: c.authorName, content: c.content.slice(0, 100) });
  }, []);

  return (
    <div className="mt-5">
      <p className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider mb-3">{t('work:task.activityCommentsHeading')}</p>
      <div className="space-y-0.5 mb-3">
        {items.length === 0 && (
          <div className="text-xs text-fg-tertiary text-center py-6">{t('work:task.noActivityYet')}</div>
        )}
        {items.map((item, i) => {
          if (item.type === 'note') {
            return <NoteComment key={`n-${i}`} note={item.note} compact />;
          }
          return <CommentBubble key={`c-${item.comment.id}`} comment={item.comment} agents={agents} onReply={handleReply} />;
        })}
        {thinkingAgents.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            {thinkingAgents.map(ta => {
              const activities = agentActivities.get(ta.id) ?? [];
              return (
                <div
                  key={ta.id}
                  className="px-2 py-1.5 rounded-lg cursor-pointer hover:bg-surface-elevated/60 transition-colors"
                  onClick={() => navBus.navigate(PAGE.TEAM, { agentId: ta.id, profileTab: 'mind' })}
                >
                  <div className="flex items-center gap-2">
                    <div className="relative shrink-0">
                      <Avatar name={ta.name} avatarUrl={ta.avatarUrl} size={22} bgClass="bg-brand-500/15 text-brand-600" />
                      <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse ring-2 ring-surface-primary" />
                    </div>
                    <span className="text-xs font-medium text-fg-secondary">{ta.name}</span>
                    {activities.length === 0 && (
                      <span className="flex items-center gap-0.5">
                        <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" />
                        <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.15s' }} />
                        <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.3s' }} />
                      </span>
                    )}
                    <span className="text-[10px] text-fg-tertiary">{t('work:task.agentProcessing')}</span>
                    <span className="ml-auto text-[10px] text-fg-tertiary">→</span>
                  </div>
                  {activities.length > 0 && (
                    <div className="ml-8 mt-1">
                      <ActivityIndicator activities={activities} isActive={true} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <CommentInput agents={agents} humans={users} onSubmit={handleSubmit} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} placeholder={t('work:task.commentPlaceholder')} />
    </div>
  );
}

// ─── Execution Log Panel ────────────────────────────────────────────────────────

function TaskExecutionLogs({ task, isRunning, authUser, agents }: { task: TaskInfo; isRunning: boolean; authUser?: { id: string; name: string }; agents: AgentInfo[] }) {
  const taskId = task.id;
  const { t } = useTranslation(['work', 'common']);
  const [roundsSummary, setRoundsSummary] = useState<RoundSummary[]>([]);
  const [roundLogs, setRoundLogs] = useState<Map<number, TaskLogEntry[]>>(new Map());
  const [loadingRounds, setLoadingRounds] = useState<Set<number>>(new Set());
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [isExecuting, setIsExecuting] = useState(isRunning);
  const [loading, setLoading] = useState(true);
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(new Set());
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [thinkingAgents, setThinkingAgents] = useState<Array<{ id: string; name: string; avatarUrl?: string }>>([]);
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [agentActivities, setAgentActivities] = useState<Map<string, ActivityStep[]>>(new Map());
  const [imageAttachments, setImageAttachments] = useState<Array<{ type: string; url: string; name: string }>>([]);
  const [relatedActivities, setRelatedActivities] = useState<ActivityRecord[]>([]);
  const [loadingActivities, setLoadingActivities] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setIsExecuting(isRunning); }, [isRunning]);

  useEffect(() => {
    setThinkingAgents([]);
    setAgentActivities(new Map());
    if (thinkingTimeoutRef.current) { clearTimeout(thinkingTimeoutRef.current); thinkingTimeoutRef.current = null; }
  }, [taskId]);

  // On mount: fetch rounds summary + latest round logs + comments (lightweight)
  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.tasks.getLogsSummary(taskId).catch(() => ({ rounds: [] as RoundSummary[] })),
      api.tasks.getComments(taskId).catch(() => ({ comments: [] as TaskComment[] })),
    ]).then(([summaryData, commentData]) => {
      const summaries = summaryData.rounds;
      setRoundsSummary(summaries);
      setComments(commentData.comments);
      if (summaries.length === 0) {
        setLoading(false);
        return;
      }
      const latestRound = summaries[summaries.length - 1]!.round;
      setExpandedRounds(new Set([latestRound]));
      api.tasks.getLogs(taskId, latestRound)
        .catch(() => ({ logs: [] as TaskLogEntry[] }))
        .then(logData => {
          setRoundLogs(new Map([[latestRound, logData.logs]]));
          setLoading(false);
        });
    });
  }, [taskId]);

  // Fetch related activities from the assigned agent (shown when no direct execution logs)
  useEffect(() => {
    const agentId = task.assignedAgentId;
    if (!agentId) return;
    setLoadingActivities(true);
    api.agents.getActivities(agentId, { taskId, limit: 20 })
      .then(d => setRelatedActivities(d.activities))
      .catch(() => setRelatedActivities([]))
      .finally(() => setLoadingActivities(false));
  }, [taskId, task.assignedAgentId]);

  // Load a specific round's logs on demand
  const loadRound = useCallback((round: number) => {
    if (roundLogs.has(round) || loadingRounds.has(round)) return;
    setLoadingRounds(prev => new Set(prev).add(round));
    api.tasks.getLogs(taskId, round)
      .catch(() => ({ logs: [] as TaskLogEntry[] }))
      .then(data => {
        setRoundLogs(prev => new Map(prev).set(round, data.logs));
        setLoadingRounds(prev => { const n = new Set(prev); n.delete(round); return n; });
      });
  }, [taskId, roundLogs, loadingRounds]);

  const toggleRound = useCallback((round: number) => {
    setExpandedRounds(prev => {
      const next = new Set(prev);
      if (next.has(round)) {
        next.delete(round);
      } else {
        next.add(round);
        if (!roundLogs.has(round)) loadRound(round);
      }
      return next;
    });
  }, [roundLogs, loadRound]);

  // WS: append live logs to the current (latest) round
  useEffect(() => {
    const unsubLog = wsClient.on('task:log', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      const entry: TaskLogEntry = {
        id: p.id as string, taskId: p.taskId as string, agentId: p.agentId as string,
        seq: p.seq as number, type: p.logType as string, content: p.content as string,
        metadata: p.metadata as Record<string, unknown> | undefined,
        executionRound: p.executionRound as number | undefined,
        createdAt: p.createdAt as string,
      };
      const round = entry.executionRound ?? 1;

      // Update summary if this round is new
      setRoundsSummary(prev => {
        const existing = prev.find(r => r.round === round);
        if (existing) return prev;
        return [...prev, { round, logCount: 0, toolCount: 0, firstAt: entry.createdAt, lastAt: entry.createdAt, status: 'running' }];
      });

      // Auto-expand and append to the round
      setExpandedRounds(prev => { if (prev.has(round)) return prev; return new Set(prev).add(round); });
      setRoundLogs(prev => {
        const existing = prev.get(round) ?? [];
        if (entry.id && existing.some(e => e.id === entry.id)) return prev;
        return new Map(prev).set(round, [...existing, entry]);
      });

      if (entry.type === 'text') setStreamingText('');
      if (entry.type === 'status') {
        if (entry.content === 'started' || entry.content === 'resumed') setIsExecuting(true);
        else if (['completed', 'failed', 'cancelled', 'execution_finished'].includes(entry.content)) {
          setIsExecuting(false);
          setRoundsSummary(prev => prev.map(r => r.round === round ? { ...r, status: entry.content } : r));
        }
      }
      if (entry.type === 'error') setIsExecuting(false);
    });
    const unsubDelta = wsClient.on('task:log:delta', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      setStreamingText(prev => prev + (p.text as string));
    });
    const unsubComment = wsClient.on('task:comment', (event) => {
      const p = event.payload;
      if (p.taskId !== taskId) return;
      const c = p.comment as TaskComment;
      setComments(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c]);
      if (c.authorType === 'agent' || c.authorId?.startsWith('agt_')) {
        setThinkingAgents(prev => {
          const next = prev.filter(a => a.id !== c.authorId);
          if (next.length === 0 && thinkingTimeoutRef.current) {
            clearTimeout(thinkingTimeoutRef.current);
            thinkingTimeoutRef.current = null;
          }
          return next;
        });
        setAgentActivities(prev => {
          const next = new Map(prev);
          next.delete(c.authorId);
          return next;
        });
      }
    });
    return () => { unsubLog(); unsubDelta(); unsubComment(); };
  }, [taskId]);

  // Subscribe to agent activity logs during thinking period
  useEffect(() => {
    if (thinkingAgents.length === 0) return;
    const thinkingIds = new Set(thinkingAgents.map(a => a.id));
    const unsub = wsClient.on('agent:activity_log', (event: { payload?: Record<string, unknown> }) => {
      const p = event.payload as Record<string, unknown> | undefined;
      if (!p) return;
      const agentId = p['agentId'] as string;
      if (!thinkingIds.has(agentId)) return;
      const evtType = p['type'] as string;
      if (evtType === 'tool_start' || evtType === 'tool_end') {
        const tool = (p['content'] as string) ?? (p['metadata'] as Record<string, unknown>)?.['tool'] as string ?? '';
        const step: ActivityStep = {
          tool,
          phase: evtType === 'tool_start' ? 'start' : 'end',
          success: evtType === 'tool_end' ? (p['metadata'] as Record<string, unknown>)?.['success'] !== false : undefined,
          ts: Date.now(),
        };
        setAgentActivities(prev => {
          const next = new Map(prev);
          const list = [...(next.get(agentId) ?? []), step];
          next.set(agentId, list);
          return next;
        });
      }
    });
    return unsub;
  }, [thinkingAgents]);

  // All logs from loaded rounds merged (for compact card / single-round view)
  const allLoadedLogs = useMemo(() => {
    const all: TaskLogEntry[] = [];
    for (const [, logs] of roundLogs) all.push(...logs);
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }, [roundLogs]);

  const streamEntries = useMemo<ExecutionStreamEntryUI[]>(() =>
    allLoadedLogs.map(l => taskLogToStreamEntry(l)),
    [allLoadedLogs],
  );

  const hasMultipleRounds = roundsSummary.length > 1;

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setImageAttachments(prev => [...prev, { type: 'image', url: reader.result as string, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  const submitComment = async () => {
    if (!commentText.trim() && imageAttachments.length === 0) return;
    setSubmitting(true);
    try {
      let attachments: Array<{ type: string; url: string; name: string }> | undefined;
      if (imageAttachments.length > 0) {
        const uploaded = await api.uploads.upload(imageAttachments.map(a => ({ dataUrl: a.url, name: a.name })), 'comments');
        attachments = uploaded.files.map(f => ({ type: 'image', url: f.url, name: f.name }));
      }
      const result = await api.tasks.addComment(taskId, commentText, authUser?.name, attachments, authUser?.id);
      if (result.comment) {
        setComments(prev => prev.some(x => x.id === result.comment.id) ? prev : [...prev, result.comment]);
      }
      setCommentText('');
      setImageAttachments([]);
      const notified: Array<{ id: string; name: string; avatarUrl?: string }> = [];
      const seen = new Set<string>();
      const tryAdd = (agentId: string) => {
        if (seen.has(agentId) || agentId === authUser?.id) return;
        seen.add(agentId);
        const a = agents.find(ag => ag.id === agentId);
        if (a) notified.push({ id: a.id, name: a.name, avatarUrl: a.avatarUrl });
      };
      if (task.assignedAgentId) tryAdd(task.assignedAgentId);
      if (task.createdBy?.startsWith('agt_') && task.status !== 'in_progress') tryAdd(task.createdBy);
      if (notified.length > 0) {
        if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current);
        setThinkingAgents(notified);
        thinkingTimeoutRef.current = setTimeout(() => setThinkingAgents([]), 120_000);
      }
    } catch { /* ignore */ }
    setSubmitting(false);
  };

  const commentInput = (
    <div className="border-t border-border-default px-4 py-3 sticky bottom-0 bg-surface-primary z-10">
      {imageAttachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {imageAttachments.map((att, i) => (
            <div key={i} className="relative group">
              <img src={att.url} alt={att.name} className="w-16 h-16 object-cover rounded-lg border border-border-default" />
              <button onClick={() => setImageAttachments(prev => prev.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100">×</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitComment(); } }}
          placeholder={t('work:task.commentInstructionPlaceholder')}
          className="flex-1 px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-blue-500 outline-none text-fg-primary placeholder-gray-600" />
        <input type="file" ref={fileInputRef} accept="image/*" multiple onChange={handleImageUpload} className="hidden" />
        <button onClick={() => fileInputRef.current?.click()} className="px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-fg-secondary hover:text-fg-primary text-sm" title={t('work:task.attachImage')}>📎</button>
        <button onClick={() => void submitComment()} disabled={submitting || (!commentText.trim() && imageAttachments.length === 0)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-xs disabled:opacity-50">{t('common:send')}</button>
      </div>
    </div>
  );

  if (loading) return <div className="flex-1 flex items-center justify-center text-xs text-fg-tertiary">{t('work:task.loadingLogs')}</div>;
  if (roundsSummary.length === 0 && !streamingText) {
    const agent = task.assignedAgentId ? agents.find(a => a.id === task.assignedAgentId) : undefined;
    const hasRelated = relatedActivities.length > 0;
    const agentBusy = agent && agent.currentTaskId && agent.currentTaskId !== task.id;
    const isPending = task.status === 'pending';
    const isInProgress = task.status === 'in_progress';
    const noAgent = !task.assignedAgentId;

    let emptyIcon = '📋';
    let emptyMsg = t('work:task.emptyLogs.default');
    let emptyHint = t('work:task.emptyLogs.defaultHint');

    if (noAgent) {
      emptyIcon = '👤';
      emptyMsg = t('work:task.emptyLogs.noAgent');
      emptyHint = t('work:task.emptyLogs.noAgentHint');
    } else if (isPending) {
      emptyIcon = '⏳';
      emptyMsg = t('work:task.emptyLogs.pending');
      emptyHint = t('work:task.emptyLogs.pendingHint');
    } else if (isInProgress && agentBusy) {
      emptyIcon = '🔄';
      emptyMsg = t('work:task.emptyLogs.agentBusy', { agent: agent?.name ?? task.assignedAgentId });
      emptyHint = t('work:task.emptyLogs.agentBusyHint');
    } else if (isInProgress) {
      emptyIcon = '⏳';
      emptyMsg = t('work:task.emptyLogs.starting');
      emptyHint = t('work:task.emptyLogs.startingHint');
    }

    return (
      <div className="flex flex-col min-h-full">
        <div className="flex-1 overflow-y-auto">
          {loadingActivities ? (
            <div className="flex items-center justify-center py-8 text-xs text-fg-tertiary">{t('work:task.loadingLogs')}</div>
          ) : hasRelated ? (
            <div className="px-4 py-4">
              <div className="text-xs text-fg-secondary mb-3 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
                {t('work:task.relatedSessions', { agent: agent?.name ?? t('work:task.agent'), count: relatedActivities.length })}
              </div>
              <div className="space-y-1.5">
                {relatedActivities.map(act => {
                  const isLive = !act.endedAt;
                  const typeIcon = act.type === 'task' ? '🔧' : act.type === 'chat' ? '💬' : act.type === 'respond_in_session' ? '💬' : act.type === 'heartbeat' ? '💓' : '📋';
                  return (
                    <button
                      key={act.id}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-elevated hover:bg-surface-elevated/80 border border-border-default/50 text-left transition-colors group"
                      onClick={() => navBus.navigate(PAGE.TEAM, { agentId: task.assignedAgentId })}
                    >
                      <span className="text-sm shrink-0">{typeIcon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-fg-primary truncate">{act.label}</div>
                        <div className="text-[10px] text-fg-tertiary">
                          {new Date(act.startedAt).toLocaleString()}
                          {act.endedAt ? ` — ${act.totalTools} tools, ${act.totalTokens.toLocaleString()} tokens` : ''}
                        </div>
                      </div>
                      {isLive && (
                        <span className="shrink-0 flex items-center gap-1 text-[10px] text-green-500 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          {t('work:task.sessionLive')}
                        </span>
                      )}
                      {!isLive && (
                        <span className={`shrink-0 text-[10px] ${act.success ? 'text-fg-tertiary' : 'text-red-400'}`}>
                          {act.success ? '✓' : '✗'}
                        </span>
                      )}
                      <span className="shrink-0 text-fg-tertiary text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <div className="text-center text-fg-tertiary">
                <div className="text-2xl mb-2">{emptyIcon}</div>
                <div className="text-xs">{emptyMsg}<br /><span className="text-fg-muted">{emptyHint}</span></div>
              </div>
            </div>
          )}
        </div>
        {commentInput}
      </div>
    );
  }

  // Single round — render log entries with comments interleaved chronologically
  if (!hasMultipleRounds) {
    const exec = streamEntries.map(e => streamEntryToExecEntry(e)).filter((e): e is ExecEntry => e !== null);
    const filtered = attachSubagentLogsToEntries(allLoadedLogs, filterCompletedStarts(exec));

    type TimelineItem = { kind: 'entry'; entry: ExecEntry; ts: number } | { kind: 'comment'; comment: TaskComment; ts: number };
    const timeline: TimelineItem[] = [
      ...filtered.map(e => ({ kind: 'entry' as const, entry: e, ts: e.timestamp ? new Date(e.timestamp).getTime() : 0 })),
      ...comments.map(c => ({ kind: 'comment' as const, comment: c, ts: new Date(c.createdAt).getTime() })),
    ];
    timeline.sort((a, b) => a.ts - b.ts);

    return (
      <div className="flex flex-col min-h-full">
        <div className="px-4 py-3 flex-1 space-y-0.5">
          {timeline.map((item, i) =>
            item.kind === 'comment'
              ? <CommentBubble key={`c-${item.comment.id}`} comment={item.comment} agents={agents} />
              : <MemoExecEntryRow key={`e-${i}`} entry={item.entry} showTime isLast={i === timeline.length - 1} />
          )}
          {isExecuting && streamingText && <StreamingText content={streamingText} />}
          {isExecuting && !streamingText && filtered.length > 0 && <ThinkingDots />}
        </div>
        {commentInput}
      </div>
    );
  }

  // Assign comments to rounds based on timestamps
  const getCommentsForRound = (rs: RoundSummary, nextRs?: RoundSummary) => {
    const roundStart = rs.firstAt ? new Date(rs.firstAt).getTime() : 0;
    const roundEnd = nextRs?.firstAt ? new Date(nextRs.firstAt).getTime() : Infinity;
    return comments.filter(c => {
      const ct = new Date(c.createdAt).getTime();
      return ct >= roundStart && ct < roundEnd;
    });
  };
  const commentsBeforeFirstRound = roundsSummary.length > 0
    ? comments.filter(c => new Date(c.createdAt).getTime() < new Date(roundsSummary[0]!.firstAt).getTime())
    : [];

  // Multiple rounds — show round headers with lazy loading + comments
  return (
    <div className="flex flex-col min-h-full">
      <div ref={topRef} />
      <div className="px-4 py-3 flex-1 space-y-2">
        {commentsBeforeFirstRound.length > 0 && (
          <div className="space-y-0.5">
            {commentsBeforeFirstRound.map(c => <CommentBubble key={c.id} comment={c} agents={agents} />)}
          </div>
        )}
        {roundsSummary.map((rs, rsIdx) => {
          const isExpanded = expandedRounds.has(rs.round);
          const isLatest = rs.round === roundsSummary[roundsSummary.length - 1]!.round;
          const logs = roundLogs.get(rs.round);
          const isLoading = loadingRounds.has(rs.round);
          const roundComments = getCommentsForRound(rs, roundsSummary[rsIdx + 1]);
          const statusIcon = rs.status === 'completed' || rs.status === 'execution_finished' ? '✅'
            : rs.status === 'failed' ? '❌'
            : rs.status === 'cancelled' ? '⏹'
            : '🔄';
          const elapsed = rs.lastAt && rs.firstAt
            ? Math.max(0, new Date(rs.lastAt).getTime() - new Date(rs.firstAt).getTime())
            : 0;
          const elapsedStr = elapsed >= 60000
            ? `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`
            : elapsed >= 1000 ? `${Math.floor(elapsed / 1000)}s` : '';

          return (
            <div key={rs.round} className="border border-border-default/50 rounded-lg overflow-hidden">
              <button
                onClick={() => toggleRound(rs.round)}
                className="w-full flex items-center justify-between px-3 py-2 bg-surface-elevated/30 hover:bg-surface-elevated/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{statusIcon}</span>
                  <span className="text-xs text-fg-secondary font-medium">{t('work:task.roundHeader', { n: rs.round })}</span>
                  {roundComments.length > 0 && (
                    <span className="text-[10px] text-blue-400">💬 {roundComments.length}</span>
                  )}
                  {isLatest && isExecuting && (
                    <svg className="w-3 h-3 animate-spin text-brand-500" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-fg-tertiary">{t('work:task.toolCount', { count: rs.toolCount })}</span>
                  {elapsedStr && <span className="text-[10px] text-fg-tertiary tabular-nums">{elapsedStr}</span>}
                  <svg className={`w-3 h-3 text-fg-tertiary transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                  </svg>
                </div>
              </button>
              {isExpanded && (
                <div className="px-3 py-1.5 space-y-0.5">
                  {isLoading && <div className="text-xs text-fg-tertiary py-2 text-center">{t('work:task.loadingRound', { n: rs.round })}</div>}
                  {logs && (() => {
                    const entries = logs.map(l => taskLogToStreamEntry(l));
                    const exec = entries.map(e => streamEntryToExecEntry(e)).filter((e): e is ExecEntry => e !== null);
                    const filtered = attachSubagentLogsToEntries(logs, filterCompletedStarts(exec));

                    type TimelineItem = { kind: 'entry'; entry: ExecEntry; ts: number } | { kind: 'comment'; comment: TaskComment; ts: number };
                    const tl: TimelineItem[] = [
                      ...filtered.map(e => ({ kind: 'entry' as const, entry: e, ts: e.timestamp ? new Date(e.timestamp).getTime() : 0 })),
                      ...roundComments.map(c => ({ kind: 'comment' as const, comment: c, ts: new Date(c.createdAt).getTime() })),
                    ];
                    tl.sort((a, b) => a.ts - b.ts);
                    return tl.map((item, i) =>
                      item.kind === 'comment'
                        ? <CommentBubble key={`c-${item.comment.id}`} comment={item.comment} agents={agents} />
                        : <MemoExecEntryRow key={`e-${i}`} entry={item.entry} showTime isLast={i === tl.length - 1} />
                    );
                  })()}
                  {isLatest && isExecuting && streamingText && <StreamingText content={streamingText} />}
                  {isLatest && isExecuting && !streamingText && !isLoading && <ThinkingDots />}
                </div>
              )}
            </div>
          );
        })}
        {thinkingAgents.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-2">
            {thinkingAgents.map(ta => {
              const activities = agentActivities.get(ta.id) ?? [];
              return (
                <div
                  key={ta.id}
                  className="px-3 py-2 rounded-lg cursor-pointer hover:bg-surface-elevated/60 transition-colors"
                  onClick={() => navBus.navigate(PAGE.TEAM, { agentId: ta.id, profileTab: 'mind' })}
                >
                  <div className="flex items-center gap-2.5">
                    <div className="relative shrink-0">
                      <Avatar name={ta.name} avatarUrl={ta.avatarUrl} size={24} bgClass="bg-brand-500/15 text-brand-600" />
                      <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse ring-2 ring-surface-primary" />
                    </div>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-medium text-fg-secondary truncate">{ta.name}</span>
                      {activities.length === 0 && (
                        <span className="flex items-center gap-0.5">
                          <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" />
                          <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.15s' }} />
                          <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.3s' }} />
                        </span>
                      )}
                      <span className="text-[10px] text-fg-tertiary">{t('work:task.agentProcessing')}</span>
                    </div>
                    <span className="ml-auto text-[10px] text-fg-tertiary">→</span>
                  </div>
                  {activities.length > 0 && (
                    <div className="ml-9 mt-1">
                      <ActivityIndicator activities={activities} isActive={true} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {commentInput}
    </div>
  );
}

// ─── File Preview Modal ─────────────────────────────────────────────────────────

type DirEntry = { name: string; path: string; isDirectory: boolean; size?: number; ext: string };
type PreviewData = { type: string; name: string; content: string; mimeType?: string; entries?: DirEntry[]; path?: string };

const PREVIEWABLE_EXTS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.sh', '.log', '.env', '.cfg', '.ini', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function fmtSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilePreviewModal({ filePath: initialPath, onClose, onOpenExternal }: { filePath: string; onClose: () => void; onOpenExternal?: () => void }) {
  const { t } = useTranslation(['work', 'common']);
  const [pathStack, setPathStack] = useState<string[]>([initialPath]);
  const currentPath = pathStack[pathStack.length - 1]!;
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    api.files.preview(currentPath)
      .then(d => setData(d as PreviewData))
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, [currentPath]);

  const navigateTo = (p: string) => setPathStack(prev => [...prev, p]);
  const goBack = () => setPathStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
  const canGoBack = pathStack.length > 1;

  const openInFinder = (p: string) => {
    api.files.reveal(p).catch(() => {});
  };

  const handleEntryClick = (entry: DirEntry) => {
    if (entry.isDirectory) {
      navigateTo(entry.path);
    } else if (PREVIEWABLE_EXTS.has(entry.ext)) {
      navigateTo(entry.path);
    } else {
      openInFinder(entry.path);
    }
  };

  const fileName = currentPath.split('/').pop() ?? currentPath;
  const isDir = data?.type === 'directory';

  const extIcon = (ext: string, isDirectory: boolean) => {
    if (isDirectory) return '📁';
    const mdExts = ['.md', '.markdown'];
    const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    if (mdExts.includes(ext)) return '📝';
    if (imgExts.includes(ext)) return '🖼';
    if (['.json', '.yaml', '.yml', '.toml', '.xml'].includes(ext)) return '⚙';
    if (['.js', '.ts', '.jsx', '.tsx', '.py', '.sh'].includes(ext)) return '💻';
    return '📄';
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-surface-secondary border border-border-default rounded-xl w-[720px] max-w-[92vw] max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {canGoBack && (
              <button onClick={goBack} className="text-fg-tertiary hover:text-fg-primary text-sm shrink-0 p-1 -ml-1 rounded hover:bg-surface-elevated/60 transition-colors" title={t('common:back')}>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
            )}
            {isDir
              ? <svg className="w-4 h-4 text-amber-500 shrink-0" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l.872.87A.5.5 0 008.665 3.5H13.5A1.5 1.5 0 0115 5v8.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-10z"/></svg>
              : <svg className="w-4 h-4 text-fg-tertiary shrink-0" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h7l4 4v10H3V1zm7 1H4v12h10V5.5L10 2z"/><path d="M10 1v4h4" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
            }
            <span className="text-sm font-medium text-fg-primary truncate">{fileName}</span>
            {isDir && data.entries && <span className="text-[10px] text-fg-tertiary shrink-0">({data.entries.length})</span>}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-3">
            <button onClick={() => onOpenExternal ? onOpenExternal() : openInFinder(currentPath)} className="text-fg-tertiary hover:text-fg-primary p-1.5 rounded hover:bg-surface-elevated/60 transition-colors" title={onOpenExternal ? t('work:task.openInDeliverables') : t('work:task.openInFinder')}>
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
            </button>
            <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-lg shrink-0">×</button>
          </div>
        </div>
        <div className="px-4 py-1 border-b border-border-default/60">
          <p className="text-[10px] text-fg-tertiary font-mono truncate">{currentPath}</p>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {loading && <div className="text-sm text-fg-tertiary text-center py-8">{t('work:task.filePreviewLoading')}</div>}
          {error && <div className="text-sm text-red-500 text-center py-8">{error}</div>}

          {/* Directory listing */}
          {data?.type === 'directory' && data.entries && (
            <div className="divide-y divide-border-default/50">
              {data.entries.length === 0 && (
                <div className="text-sm text-fg-tertiary text-center py-8">{t('work:task.emptyDirectory')}</div>
              )}
              {data.entries.map(entry => (
                <button
                  key={entry.path}
                  onClick={() => handleEntryClick(entry)}
                  className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-surface-elevated/40 transition-colors text-left group"
                >
                  <span className="text-sm shrink-0">{extIcon(entry.ext, entry.isDirectory)}</span>
                  <span className="flex-1 min-w-0 truncate text-sm text-fg-primary group-hover:text-brand-400 transition-colors">{entry.name}</span>
                  {!entry.isDirectory && entry.size != null && (
                    <span className="text-[10px] text-fg-tertiary shrink-0">{fmtSize(entry.size)}</span>
                  )}
                  {entry.isDirectory && (
                    <svg className="w-3.5 h-3.5 text-fg-tertiary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                  )}
                  {!entry.isDirectory && !PREVIEWABLE_EXTS.has(entry.ext) && (
                    <svg className="w-3 h-3 text-fg-tertiary shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* File preview */}
          {data && data.type !== 'directory' && (
            <div className="p-5">
              {data.type === 'image' ? (
                <div className="flex justify-center">
                  <img src={`data:${data.mimeType};base64,${data.content}`} alt={data.name} className="max-w-full max-h-[60vh] rounded-lg" />
                </div>
              ) : (
                <ContentRenderer content={data.content} format={data.type === 'text' ? 'text' : data.type} className="text-sm text-fg-secondary leading-relaxed" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Task Detail Modal ──────────────────────────────────────────────────────────

function TaskDetailPanel({
  task, agents, projects, requirements, allTasks, users, onClose, onRefresh, authUser, scrollToComments, onScrollToCommentsDone, onReqClick, onProjectClick,
}: {
  task: TaskInfo;
  agents: AgentInfo[];
  projects: ProjectInfo[];
  requirements: RequirementInfo[];
  allTasks: TaskInfo[];
  users: HumanUserInfo[];
  onClose: () => void;
  onRefresh: () => void;
  authUser?: { id: string; name: string; role: string; orgId: string };
  scrollToComments?: boolean;
  onScrollToCommentsDone?: () => void;
  onReqClick?: (req: RequirementInfo) => void;
  onProjectClick?: (projectId: string) => void;
}) {
  const { t } = useTranslation(['work', 'common']);
  const taskStatusBadges = useMemo(() => buildTaskStatusBadges(t), [t]);
  const [subtasks, setSubtasks] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const [newSubtask, setNewSubtask] = useState('');
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [showAllSubtasks, setShowAllSubtasks] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string; status: string } | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<{ dependentCount: number } | null>(null);
  const [rejectConfirm, setRejectConfirm] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<'every' | 'cron'>('every');
  const [scheduleEveryDraft, setScheduleEveryDraft] = useState('');
  const [scheduleCronDraft, setScheduleCronDraft] = useState('');
  const [scheduleMaxRunsDraft, setScheduleMaxRunsDraft] = useState('');
  const [actionInFlight, setActionInFlight] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'logs' | 'deliverables' | 'history'>('details');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<'top' | 'bottom' | 'middle' | 'none'>('none');
  const switchTab = useCallback((tab: 'details' | 'logs' | 'deliverables' | 'history') => {
    setActiveTab(tab);
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    });
  }, []);
  const detailTabs = useMemo(() => [{ id: 'details' as const }, { id: 'logs' as const }, { id: 'deliverables' as const }, { id: 'history' as const }], []);
  const detailSwipe = useSwipeTabs(detailTabs, activeTab, switchTab);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const scrollable = scrollHeight > clientHeight + 50;
      if (!scrollable) { setScrollState('none'); return; }
      const atTop = scrollTop < 30;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 30;
      setScrollState(atTop ? 'top' : atBottom ? 'bottom' : 'middle');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, [activeTab]);
  useEffect(() => {
    if (!scrollToComments) return;
    setActiveTab('details');
    const timer = setTimeout(() => {
      const el = scrollContainerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      onScrollToCommentsDone?.();
    }, 300);
    return () => clearTimeout(timer);
  }, [scrollToComments, onScrollToCommentsDone]);

  const [runError, setRunError] = useState<string | null>(null);
  const [scheduleApproveModal, setScheduleApproveModal] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description);
  const descRef = useRef<HTMLDivElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descHeightRef = useRef(80);
  useEffect(() => {
    if (editingDesc && descTextareaRef.current) {
      const el = descTextareaRef.current;
      el.style.height = 'auto';
      el.style.height = Math.max(el.scrollHeight, descHeightRef.current) + 'px';
      el.focus();
    }
  }, [editingDesc]);
  const [showRevision, setShowRevision] = useState(false);
  const [revisionReason, setRevisionReason] = useState('');
  const [deliverablesPage, setDeliverablesPage] = useState(1);
  const [unifiedDeliverables, setUnifiedDeliverables] = useState<Array<{ id: string; type: string; title: string; summary: string; reference: string; status: string }>>([]);
  const loadUnifiedDeliverables = useCallback(async () => {
    try {
      const { results } = await api.deliverables.search({ taskId: task.id, limit: 200 });
      setUnifiedDeliverables(results.filter((d: any) => d.status !== 'outdated'));
    } catch { /* ok */ }
  }, [task.id]);
  useEffect(() => { void loadUnifiedDeliverables(); }, [loadUnifiedDeliverables]);
  const [descExpanded, setDescExpanded] = useState(false);
  const isMobile = useIsMobile();
  const PAGE_SIZE = 20;
  const loadSubtasks = useCallback(async () => {
    try { const d = await api.tasks.listSubtasks(task.id); setSubtasks(d.subtasks); } catch { /* ok */ }
  }, [task.id]);

  useEffect(() => { void loadSubtasks(); }, [loadSubtasks]);

  const doUpdate = async (fn: () => Promise<unknown>) => {
    if (actionInFlight) return; setActionInFlight(true);
    try { await fn(); onRefresh(); await loadSubtasks(); } catch (err) {
      setRunError(String(err).replace('Error: ', ''));
    } finally { setActionInFlight(false); }
  };

  const updateStatus = (taskId: string, status: string) => doUpdate(() => api.tasks.updateStatus(taskId, status));
  const updatePriority = (priority: string) => doUpdate(() => api.tasks.update(task.id, { priority }));
  const assignAgent = (agentId: string) => doUpdate(() => api.tasks.assign(task.id, agentId || null));
  const updateProject = (projectId: string) => doUpdate(() => api.tasks.update(task.id, { projectId: projectId || null }));

  const pauseTask = async () => {
    if (actionInFlight) return; setActionInFlight(true);
    try {
      await api.tasks.pause(task.id);
      onRefresh();
    } finally { setActionInFlight(false); }
  };

  const resumeTask = async () => {
    if (actionInFlight) return; setActionInFlight(true); setRunError(null); switchTab('logs');
    try { await api.tasks.resume(task.id); onRefresh(); } catch (err) {
      setRunError(String(err).replace('Error: API error: 400', 'Server error').replace('Error: ', ''));
    } finally { setActionInFlight(false); }
  };

  const addSubtask = async () => {
    if (!newSubtask.trim()) return;
    await api.tasks.createSubtask(task.id, newSubtask.trim());
    setNewSubtask(''); setAddingSubtask(false);
    void loadSubtasks(); onRefresh();
  };

  const toggleSubtask = async (sub: { id: string; title: string; status: string }) => {
    if (sub.status === 'completed') {
      await api.tasks.cancelSubtask(task.id, sub.id);
    } else {
      await api.tasks.completeSubtask(task.id, sub.id);
    }
    void loadSubtasks(); onRefresh();
  };

  const deleteSubtask = async (sub: { id: string; title: string; status: string }) => {
    await api.tasks.deleteSubtask(task.id, sub.id); setPendingDelete(null);
    void loadSubtasks(); onRefresh();
  };

  const reopenTask = async () => {
    if (actionInFlight) return; setActionInFlight(true);
    try { await api.tasks.updateStatus(task.id, 'in_progress'); onRefresh(); } finally { setActionInFlight(false); }
  };

  const retryFresh = async () => {
    if (actionInFlight) return; setActionInFlight(true); setRunError(null); switchTab('logs');
    try { await api.tasks.retry(task.id); onRefresh(); } catch (err) {
      setRunError(String(err).replace('Error: API error: 400', 'Server error').replace('Error: ', ''));
    } finally { setActionInFlight(false); }
  };

  const runScheduledNow = async () => {
    if (actionInFlight) return; setActionInFlight(true); setRunError(null); switchTab('logs');
    try { await api.tasks.runNow(task.id); onRefresh(); } catch (err) {
      setRunError(String(err).replace('Error: API error: 400', 'Server error').replace('Error: ', ''));
      onRefresh();
    } finally { setActionInFlight(false); }
  };

  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const unsub = wsClient.on('task:update', (event) => {
      const p = event.payload as Record<string, unknown>;
      if ((p.taskId as string) !== task.id) return;
      void loadSubtasks();
      onRefreshRef.current();
    });
    return unsub;
  }, [task.id, loadSubtasks]);

  const completedCount = subtasks.filter(s => s.status === 'completed').length;
  const isRunning = task.status === 'in_progress';
  const isBlocked = task.status === 'blocked';
  const isAbnormallyBlocked = isBlocked && (!task.blockedBy || task.blockedBy.length === 0 || task.blockedBy.every(id => {
    const dep = allTasks.find(t => t.id === id);
    return dep && dep.status === 'completed';
  }));
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';
  const isRejected = task.status === 'rejected';
  const isCancelled = task.status === 'cancelled';
  const isArchived = task.status === 'archived';
  const isTerminal = isCompleted || isFailed || isRejected || isCancelled || isArchived;
  const isScheduled = task.taskType === 'scheduled' && !!task.scheduleConfig;
  const schedPaused = isScheduled && !!task.scheduleConfig?.paused;

  const taskProject = (() => {
    const p = projects.find(p => p.id === task.projectId);
    return p && p.name !== 'default' ? p : undefined;
  })();
  const taskRequirement = requirements.find(r => r.id === task.requirementId);
  const assignedAgent = agents.find(a => a.id === task.assignedAgentId);

  return (
    <div className="flex flex-col w-full h-full overflow-hidden bg-surface-primary shadow-xl shadow-black/8 ring-1 ring-border-default/20">
      {/* Header – status, title & close */}
      <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 border-b border-border-default shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isMobile && (
            <button onClick={() => history.back()} className="text-fg-secondary hover:text-fg-primary transition-colors p-1 -ml-1 shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
          )}
          <h3 className="flex-1 min-w-0 text-base font-semibold leading-snug text-fg-primary">
            {task.title}
            {' '}
            {(() => {
              const badge = taskStatusBadges[task.status];
              return badge ? (
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap align-middle ${badge.cls}`}>{badge.label}</span>
              ) : (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-500/15 text-fg-tertiary whitespace-nowrap align-middle">{task.status.replace(/_/g, ' ')}</span>
              );
            })()}
            {isAbnormallyBlocked && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap align-middle bg-red-500/15 text-red-500">{t('work:task.abnormalBlock')}</span>
            )}
          </h3>
        </div>
        <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-xl leading-none shrink-0 mt-1">×</button>
      </div>

        {/* Tabs — fixed at top */}
        <div className="flex gap-1 px-6 pt-2 pb-0 shrink-0">
          <button onClick={() => switchTab('details')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${activeTab === 'details' ? 'bg-surface-elevated text-fg-primary font-medium' : 'text-fg-tertiary hover:text-fg-secondary'}`}>{t('work:task.detailsTab')}</button>
          <button onClick={() => switchTab('logs')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${activeTab === 'logs' ? 'bg-surface-elevated text-fg-primary font-medium' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
            {t('work:task.executionLogTab')}
            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />}
          </button>
          <button onClick={() => switchTab('deliverables')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors flex items-center gap-1.5 ${activeTab === 'deliverables' ? 'bg-surface-elevated text-fg-primary font-medium' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
            {(() => { const c = unifiedDeliverables.filter(d => typeof d.reference === 'string' && d.reference.length > 0).length; return c > 0 ? t('work:task.deliverablesCount', { count: c }) : t('work:task.deliverables'); })()}
          </button>
          <button onClick={() => switchTab('history')} className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${activeTab === 'history' ? 'bg-surface-elevated text-fg-primary font-medium' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
            {t('work:task.historyTab')}
          </button>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 min-h-0 relative">
        <div ref={scrollContainerRef} className="h-full overflow-y-auto overflow-x-hidden" onTouchStart={detailSwipe.onTouchStart} onTouchEnd={detailSwipe.onTouchEnd}>

          <div className={activeTab === 'logs' ? 'min-w-0 min-h-full' : 'hidden'}>
              {runError && (
                <div className="mx-4 mt-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-500">
                  <span className="font-medium">{t('work:task.failedToStart')}</span> {runError}
                </div>
              )}
              <TaskExecutionLogs task={task} isRunning={task.status === 'in_progress'} authUser={authUser} agents={agents} />
          </div>

          <div className={activeTab === 'details' ? '' : 'hidden'}>
              {/* Description */}
              <div className="px-6 pt-4 pb-3 border-b border-border-default">
                {editingDesc ? (
                  <textarea
                    ref={descTextareaRef}
                    value={descDraft}
                    onChange={e => {
                      setDescDraft(e.target.value);
                      const el = e.target;
                      el.style.height = 'auto';
                      el.style.height = el.scrollHeight + 'px';
                    }}
                    onBlur={() => {
                      if (descDraft !== task.description) {
                        void doUpdate(() => api.tasks.update(task.id, { description: descDraft }));
                      }
                      setEditingDesc(false);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setDescDraft(task.description);
                        setEditingDesc(false);
                      }
                    }}
                    className="w-full bg-transparent border border-brand-500/30 rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none resize-none -mx-2 px-2 -my-1 py-1"
                    placeholder={t('work:task.addDescription')}
                  />
                ) : (
                  <div
                    ref={descRef}
                    className="group relative cursor-pointer rounded-lg -mx-2 px-2 -my-1 py-1 hover:bg-surface-elevated/50 transition-colors"
                    onClick={(e) => { if ((e.target as HTMLElement).closest('a, button, [data-entity-link]')) return; descHeightRef.current = Math.max(descRef.current?.offsetHeight ?? 80, 60); setDescDraft(task.description); setEditingDesc(true); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && (setDescDraft(task.description), setEditingDesc(true))}
                  >
                    {task.description ? (
                      <div>
                        <div className={isMobile && !descExpanded ? 'line-clamp-3' : ''}>
                          <MarkdownMessage content={task.description} className="text-sm text-fg-secondary leading-relaxed" />
                        </div>
                        {isMobile && task.description.length > 150 && (
                          <button onClick={(e) => { e.stopPropagation(); setDescExpanded(!descExpanded); }}
                            className="text-[11px] text-brand-500 mt-1 font-medium">
                            {descExpanded ? t('work:task.collapse') : t('common:showMore')}
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-fg-tertiary italic">{t('work:task.noDescription')}</p>
                    )}
                  </div>
                )}
              </div>

              {/* Context badges — project, requirement */}
              {(taskProject || taskRequirement) && (
                <div className="px-6 py-2.5 border-b border-border-default flex flex-wrap items-center gap-2">
                  {taskProject && (
                    <span
                      className={`flex items-center gap-1 text-[11px] px-2 py-0.5 bg-brand-500/10 text-brand-500 rounded-full ${onProjectClick ? 'cursor-pointer hover:bg-brand-500/20 transition-colors' : ''}`}
                      onClick={onProjectClick ? () => onProjectClick(taskProject.id) : undefined}
                      role={onProjectClick ? 'button' : undefined}
                      tabIndex={onProjectClick ? 0 : undefined}
                      onKeyDown={onProjectClick ? e => e.key === 'Enter' && onProjectClick(taskProject.id) : undefined}
                    >
                      <span className="text-[9px] text-brand-500/60">{t('work:task.projectLabel')}</span>
                      {taskProject.name}
                    </span>
                  )}
                  {taskRequirement && (
                    <span
                      className={`flex items-center gap-1 text-[11px] px-2 py-0.5 bg-brand-500/10 text-brand-500 rounded-full ${onReqClick ? 'cursor-pointer hover:bg-brand-500/20 transition-colors' : ''}`}
                      onClick={onReqClick ? () => onReqClick(taskRequirement) : undefined}
                      role={onReqClick ? 'button' : undefined}
                      tabIndex={onReqClick ? 0 : undefined}
                      onKeyDown={onReqClick ? e => e.key === 'Enter' && onReqClick(taskRequirement) : undefined}
                    >
                      <span className="text-[9px] text-brand-500/60">{t('work:task.requirementLabel')}</span>
                      {taskRequirement.title.length > 40 ? taskRequirement.title.slice(0, 40) + '…' : taskRequirement.title}
                    </span>
                  )}
                </div>
              )}

              {/* Dependencies — editable */}
              <div className="px-6 py-2.5 border-b border-border-default">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider">{t('work:task.dependencies')}</span>
                </div>
                {task.blockedBy && task.blockedBy.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {task.blockedBy.map(blockerId => {
                      const blockerTask = allTasks.find(t => t.id === blockerId);
                      const blockerDone = blockerTask && (blockerTask.status === 'completed' || blockerTask.status === 'cancelled');
                      return (
                        <span key={blockerId} className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full ${blockerDone ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-600'}`}>
                          <span className="text-[9px]">{blockerDone ? '✓' : '⏳'}</span>
                          <span className={`font-mono ${blockerDone ? 'line-through opacity-60' : ''}`}>{blockerTask ? blockerTask.title.slice(0, 30) : blockerId.slice(-8)}</span>
                          {!isTerminal && (
                            <button
                              onClick={async () => {
                                const newBlockedBy = (task.blockedBy ?? []).filter(id => id !== blockerId);
                                await api.tasks.update(task.id, { blockedBy: newBlockedBy });
                                onRefresh();
                              }}
                              className="ml-0.5 text-current opacity-40 hover:opacity-100 transition-opacity"
                              title={t('work:task.removeDependency')}
                            >×</button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-fg-tertiary mb-2">{t('work:task.noDependencies')}</p>
                )}
                {isAbnormallyBlocked && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-500 mb-2">
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span>{t('work:task.abnormalBlockHint')}</span>
                  </div>
                )}
                {!isTerminal && (
                  <select
                    value=""
                    onChange={async (e) => {
                      const depId = e.target.value;
                      if (!depId) return;
                      const newBlockedBy = [...(task.blockedBy ?? []), depId];
                      await api.tasks.update(task.id, { blockedBy: newBlockedBy });
                      onRefresh();
                    }}
                    className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-[11px] text-fg-secondary focus:border-brand-500 outline-none"
                  >
                    <option value="">{t('work:task.addDependency')}</option>
                    {allTasks
                      .filter(t => t.id !== task.id && !(task.blockedBy ?? []).includes(t.id))
                      .map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                )}
              </div>

              {/* Editable fields */}
              <div className="px-6 py-4 border-b border-border-default/60 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1">{t('work:task.projectLabel')}</label>
                    <select value={task.projectId ?? ''} onChange={e => void updateProject(e.target.value)} disabled={actionInFlight}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-primary focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="">{t('work:task.noProject')}</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1">{t('work:task.requirementLabel')}</label>
                    <select value={task.requirementId ?? ''} onChange={e => doUpdate(() => api.tasks.update(task.id, { requirementId: e.target.value || null }))} disabled={actionInFlight}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-primary focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="">{t('work:task.noRequirement')}</option>
                      {requirements.filter(r => !task.projectId || r.projectId === task.projectId).map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1">{t('work:task.assignee')}</label>
                    <select value={task.assignedAgentId ?? ''} onChange={e => void assignAgent(e.target.value)} disabled={actionInFlight}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-primary focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="">{t('work:task.unassigned')}</option>
                      {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.status})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1">{t('work:task.reviewer')}</label>
                    <select value={`${task.reviewerType ?? 'agent'}:${task.reviewerId ?? ''}`} onChange={e => {
                      const val = e.target.value;
                      if (!val) return;
                      const isHuman = val.startsWith('human:');
                      const id = val.replace(/^(human|agent):/, '');
                      if (id !== task.reviewerId || (isHuman ? 'human' : 'agent') !== (task.reviewerType ?? 'agent')) {
                        void doUpdate(() => api.tasks.update(task.id, { reviewerId: id, reviewerType: isHuman ? 'human' : 'agent' }));
                      }
                    }} disabled={actionInFlight}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-primary focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      {users.map(u => <option key={`human:${u.id}`} value={`human:${u.id}`}>{u.name}</option>)}
                      {agents.map(a => <option key={`agent:${a.id}`} value={`agent:${a.id}`}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1">{t('work:task.priority')}</label>
                    <select value={task.priority} onChange={e => void updatePriority(e.target.value)} disabled={actionInFlight}
                      className="w-full px-2 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-primary focus:border-brand-500 outline-none disabled:opacity-50 cursor-pointer">
                      <option value="low">{t('work:priority.low')}</option><option value="medium">{t('work:priority.medium')}</option><option value="high">{t('work:priority.high')}</option><option value="urgent">{t('work:priority.urgent')}</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Metadata */}
              <div className="px-6 py-3 border-b border-border-default/60 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-fg-tertiary">
                {task.createdBy && (
                  <span>{t('work:task.createdBy', { name: resolveActorName(task.createdBy, agents, users) ?? task.createdBy })}</span>
                )}
                {task.updatedBy && (
                  <span>{t('work:task.updatedBy', { name: resolveActorName(task.updatedBy, agents, users) ?? task.updatedBy })}</span>
                )}
                {task.createdAt && <span>{new Date(task.createdAt).toLocaleDateString()}</span>}
                {task.startedAt && <span>{t('work:task.started', { date: new Date(task.startedAt).toLocaleDateString() })}</span>}
                {task.updatedAt && <span>{t('work:task.updatedMeta', { date: new Date(task.updatedAt).toLocaleDateString() })}</span>}
                {task.projectId && (
                  <span className="font-mono text-blue-600/70">task/{task.id}</span>
                )}
                {(task.executionRound ?? 1) > 1 && (
                  <span className="text-amber-600">{t('work:task.executionRound', { n: task.executionRound })}</span>
                )}
              </div>

              <div className="px-6 py-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">
                    {t('work:task.subtasks')} {subtasks.length > 0 && <span className="ml-1.5 text-fg-tertiary font-normal normal-case">{t('work:task.subtasksProgress', { done: completedCount, total: subtasks.length })}</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    {completedCount > 0 && (
                      <button
                        onClick={() => setShowAllSubtasks(v => !v)}
                        className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${showAllSubtasks ? 'bg-brand-500/15 text-brand-500 border-brand-500/30' : 'text-fg-tertiary border-border-default hover:text-fg-secondary'}`}
                      >
                        {showAllSubtasks ? t('work:task.hideCompleted') : t('work:task.showCompleted', { count: completedCount })}
                      </button>
                    )}
                    <button onClick={() => setAddingSubtask(true)} className="text-xs text-brand-500 hover:text-brand-500 transition-colors">{t('work:task.addSubtask')}</button>
                  </div>
                </div>
                {(() => {
                  const visible = showAllSubtasks ? subtasks : subtasks.filter(s => s.status !== 'completed');
                  return visible.length > 0 ? (
                    <div className="space-y-1.5 mb-3">
                      {visible.map(sub => (
                        <div key={sub.id} className="group flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-surface-elevated/50 transition-colors">
                          <button onClick={() => void toggleSubtask(sub)} className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${sub.status === 'completed' ? 'bg-green-600 border-green-600 text-white' : 'border-gray-600 hover:border-brand-500'}`}>
                            {sub.status === 'completed' && <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                          </button>
                          <span className={`flex-1 text-sm ${sub.status === 'completed' ? 'line-through text-fg-tertiary' : 'text-fg-secondary'}`}>{sub.title}</span>
                          <button onClick={() => setPendingDelete(sub)} className="shrink-0 opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-red-500 transition-all text-xs">✕</button>
                        </div>
                      ))}
                    </div>
                  ) : null;
                })()}
                {subtasks.length === 0 && !addingSubtask && <div className="text-xs text-fg-tertiary text-center py-4">{t('work:task.noSubtasksYet')}</div>}
                {addingSubtask && (
                  <div className="flex gap-2 mt-2">
                    <input autoFocus value={newSubtask} onChange={e => setNewSubtask(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void addSubtask(); if (e.key === 'Escape') { setAddingSubtask(false); setNewSubtask(''); } }}
                      placeholder={t('work:task.subtaskTitlePlaceholder')} className="flex-1 px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none" />
                    <button onClick={() => void addSubtask()} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg">{t('work:task.add')}</button>
                    <button onClick={() => { setAddingSubtask(false); setNewSubtask(''); }} className="px-3 py-1.5 border border-border-default text-xs rounded-lg hover:bg-surface-elevated">{t('common:cancel')}</button>
                  </div>
                )}
                {/* Deliverables preview — latest 3 (newest first) */}
                {(() => {
                  const validDeliverables = unifiedDeliverables.filter(
                    d => typeof d.reference === 'string' && d.reference.length > 0
                  );
                  if (validDeliverables.length === 0) return null;
                  const typeColors: Record<string, string> = {
                    file: 'bg-blue-500/15 text-blue-600',
                    document: 'bg-blue-500/15 text-blue-600',
                    report: 'bg-brand-500/15 text-brand-500',
                    directory: 'bg-green-500/15 text-green-600',
                    url: 'bg-brand-500/15 text-brand-500',
                    text: 'bg-gray-500/15 text-fg-secondary',
                  };
                  const latest3 = validDeliverables.slice(0, 3);
                  return (
                    <div className="mt-5">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('work:task.deliverablesCount', { count: validDeliverables.length })}</p>
                        {validDeliverables.length > 3 && (
                          <button onClick={() => switchTab('deliverables')} className="text-[10px] text-brand-500 hover:text-brand-500">{t('work:task.viewAll')}</button>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        {latest3.map((d) => {
                          const isUrl = /^https?:\/\//i.test(d.reference);
                          const fileName = isUrl ? (d.summary || d.reference) : (d.reference.split('/').pop() ?? d.reference);
                          return (
                            <div key={d.id} className="flex items-start gap-2.5 bg-surface-elevated/60 rounded-lg px-3 py-2 group hover:bg-surface-elevated/80 transition-colors">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${typeColors[d.type] ?? 'bg-gray-500/15 text-fg-secondary'}`}>{d.type}</span>
                              <div className="flex-1 min-w-0">
                                {isUrl ? (
                                  <a
                                    href={d.reference}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-brand-500 hover:text-brand-500 font-medium truncate block max-w-full text-left hover:underline"
                                    title={d.reference}
                                  >
                                    {fileName} <svg className="w-3 h-3 inline -mt-0.5 ml-0.5 opacity-60" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6.5v3a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-6A.5.5 0 0 1 2.5 3H6"/><path d="M7 2h3v3"/><path d="M5 7 10 2"/></svg>
                                  </a>
                                ) : (
                                  <button
                                    onClick={() => setPreviewFile(d.reference)}
                                    className="text-sm text-brand-500 hover:text-brand-500 font-medium truncate block max-w-full text-left hover:underline"
                                    title={d.reference}
                                  >
                                    {fileName}
                                  </button>
                                )}
                                {d.summary && !isUrl && <p className="text-[11px] text-fg-secondary mt-0.5 line-clamp-2">{d.summary}</p>}
                                <p className="text-[10px] text-fg-tertiary font-mono truncate mt-0.5">{d.reference}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
                {/* Unified Activity & Comments — notes + comments chronologically */}
                <TaskActivitySection task={task} agents={agents} users={users} authUser={authUser} />
              </div>
          </div>

          {/* Deliverables tab — full paginated list (newest first) */}
          <div className={activeTab === 'history' ? '' : 'hidden'}>
            <StatusHistoryTimeline entityType="task" entityId={task.id} />
          </div>

          <div className={activeTab === 'deliverables' ? 'px-6 py-4' : 'hidden'}>
              {(() => {
                const validDeliverables = unifiedDeliverables.filter(
                  d => typeof d.reference === 'string' && d.reference.length > 0
                );
                if (validDeliverables.length === 0) return <div className="flex items-center justify-center py-12 text-xs text-fg-tertiary">{t('work:task.noDeliverablesYet')}</div>;
                const typeColors: Record<string, string> = {
                  file: 'bg-blue-500/15 text-blue-600',
                  document: 'bg-blue-500/15 text-blue-600',
                  report: 'bg-brand-500/15 text-brand-500',
                  directory: 'bg-green-500/15 text-green-600',
                  url: 'bg-brand-500/15 text-brand-500',
                  text: 'bg-gray-500/15 text-fg-secondary',
                };
                const totalPages = Math.ceil(validDeliverables.length / PAGE_SIZE);
                const paged = validDeliverables.slice((deliverablesPage - 1) * PAGE_SIZE, deliverablesPage * PAGE_SIZE);
                return (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{t('work:task.deliverablesCount', { count: validDeliverables.length })}</p>
                      {totalPages > 1 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-fg-tertiary">
                          <button disabled={deliverablesPage <= 1} onClick={() => setDeliverablesPage(p => p - 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">‹</button>
                          <span>{deliverablesPage}/{totalPages}</span>
                          <button disabled={deliverablesPage >= totalPages} onClick={() => setDeliverablesPage(p => p + 1)} className="px-1.5 py-0.5 rounded bg-surface-elevated hover:bg-surface-overlay disabled:opacity-30">›</button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {paged.map((d) => {
                        const isUrl = /^https?:\/\//i.test(d.reference);
                        const fileName = isUrl ? (d.summary || d.reference) : (d.reference.split('/').pop() ?? d.reference);
                        return (
                          <div key={d.id} className="flex items-start gap-2.5 bg-surface-elevated/60 rounded-lg px-3 py-2 group hover:bg-surface-elevated/80 transition-colors">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${typeColors[d.type] ?? 'bg-gray-500/15 text-fg-secondary'}`}>{d.type}</span>
                            <div className="flex-1 min-w-0">
                              {isUrl ? (
                                <a
                                  href={d.reference}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-brand-500 hover:text-brand-500 font-medium truncate block max-w-full text-left hover:underline"
                                  title={d.reference}
                                >
                                  {fileName} <svg className="w-3 h-3 inline -mt-0.5 ml-0.5 opacity-60" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6.5v3a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-6A.5.5 0 0 1 2.5 3H6"/><path d="M7 2h3v3"/><path d="M5 7 10 2"/></svg>
                                </a>
                              ) : (
                                <button
                                  onClick={() => setPreviewFile(d.reference)}
                                  className="text-sm text-brand-500 hover:text-brand-500 font-medium truncate block max-w-full text-left hover:underline"
                                  title={d.reference}
                                >
                                  {fileName}
                                </button>
                              )}
                              {d.summary && !isUrl && <p className="text-[11px] text-fg-secondary mt-0.5 line-clamp-2">{d.summary}</p>}
                              <p className="text-[10px] text-fg-tertiary font-mono truncate mt-0.5">{d.reference}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
          </div>
        </div>
        {/* Floating scroll buttons — both bottom-right, fixed positions */}
        {scrollState !== 'none' && scrollState !== 'top' && (
          <button
            onClick={() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            className="absolute bottom-36 right-4 md:bottom-28 md:right-3 z-10 w-12 h-12 md:w-8 md:h-8 rounded-full bg-brand-500 md:bg-brand-600/90 border border-brand-400/60 shadow-xl shadow-brand-500/30 md:shadow-lg md:shadow-brand-500/20 flex items-center justify-center text-white hover:bg-brand-400 transition-colors backdrop-blur-sm"
            title={t('work:task.scrollToTop')}
          >
            <svg className="w-6 h-6 md:w-4 md:h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832l-3.71 3.938a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clipRule="evenodd" /></svg>
          </button>
        )}
        {scrollState !== 'none' && scrollState !== 'bottom' && (
          <button
            onClick={() => { const el = scrollContainerRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-22 right-4 md:bottom-18 md:right-3 z-10 w-12 h-12 md:w-8 md:h-8 rounded-full bg-brand-500 md:bg-brand-600/90 border border-brand-400/60 shadow-xl shadow-brand-500/30 md:shadow-lg md:shadow-brand-500/20 flex items-center justify-center text-white hover:bg-brand-400 transition-colors backdrop-blur-sm"
            title={t('work:task.scrollToBottom')}
          >
            <svg className="w-6 h-6 md:w-4 md:h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
          </button>
        )}
        </div>

        {/* Schedule info banner */}
        {isScheduled && task.scheduleConfig && (
          <div className={`mx-6 mt-3 mb-0 px-4 py-2.5 rounded-lg border text-xs ${schedPaused ? 'bg-amber-500/5 border-amber-500/20' : 'bg-brand-500/5 border-brand-500/20'} ${!isRunning && !editingSchedule && !task.scheduleConfig.runAt ? 'cursor-pointer hover:border-brand-500/40 transition-colors' : ''}`}
            onClick={() => {
              if (isRunning || editingSchedule || task.scheduleConfig?.runAt) return;
              setScheduleMode(task.scheduleConfig?.cron ? 'cron' : 'every');
              setScheduleEveryDraft(task.scheduleConfig?.every ?? '4h');
              setScheduleCronDraft(task.scheduleConfig?.cron ?? '');
              setScheduleMaxRunsDraft(task.scheduleConfig?.maxRuns && task.scheduleConfig.maxRuns > 0 ? String(task.scheduleConfig.maxRuns) : '');
              setEditingSchedule(true);
            }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={schedPaused ? 'text-amber-600' : 'text-brand-500'}>
                {schedPaused ? t('work:task.schedulePaused') : <><svg className="w-3.5 h-3.5 inline -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg> {t('work:task.scheduled')}</>}
              </span>
              <span className="text-fg-tertiary">·</span>
              <span className="text-fg-secondary">
                {task.scheduleConfig.every ? t('work:task.scheduleEvery', { interval: task.scheduleConfig.every }) : task.scheduleConfig.cron ? t('work:task.scheduleCron', { expr: task.scheduleConfig.cron }) : task.scheduleConfig.runAt ? t('work:task.scheduleOneShot') : t('work:task.scheduleNA')}
              </span>
              {!schedPaused && task.scheduleConfig.nextRunAt && (
                <>
                  <span className="text-fg-tertiary">·</span>
                  <span className="text-fg-secondary">{t('work:task.scheduleNext', { when: (() => {
                    const diff = new Date(task.scheduleConfig!.nextRunAt!).getTime() - Date.now();
                    if (diff <= 0) return t('work:task.scheduleDueNow');
                    const m = Math.floor(diff / 60000);
                    if (m < 60) return t('work:task.scheduleInMinutes', { count: m });
                    const h = Math.floor(m / 60);
                    return h < 24 ? t('work:task.scheduleInHoursMinutes', { h, m: m % 60 }) : t('work:task.scheduleInDaysHours', { d: Math.floor(h / 24), h: h % 24 });
                  })() })}</span>
                </>
              )}
              {!isRunning && !editingSchedule && !task.scheduleConfig.runAt && (
                <svg className="w-3 h-3 text-brand-500 ml-auto shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              )}
            </div>
            {editingSchedule ? (
              <div className="mt-2 pt-2 border-t border-border-default/50 space-y-2" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2">
                  <select value={scheduleMode} onChange={e => setScheduleMode(e.target.value as 'every' | 'cron')}
                    className="px-2 py-1 text-xs bg-surface-elevated border border-border-default rounded-lg">
                    <option value="every">{t('work:task.scheduleEveryMode')}</option>
                    <option value="cron">{t('work:task.scheduleCronMode')}</option>
                  </select>
                  {scheduleMode === 'every' ? (
                    <select value={scheduleEveryDraft} onChange={e => setScheduleEveryDraft(e.target.value)}
                      className="flex-1 px-2 py-1 text-xs bg-surface-elevated border border-border-default rounded-lg">
                      <option value="30m">{t('work:task.freq30m')}</option>
                      <option value="1h">{t('work:task.freq1h')}</option>
                      <option value="2h">{t('work:task.freq2h')}</option>
                      <option value="4h">{t('work:task.freq4h')}</option>
                      <option value="8h">{t('work:task.freq8h')}</option>
                      <option value="12h">{t('work:task.freq12h')}</option>
                      <option value="1d">{t('work:task.freq1d')}</option>
                      <option value="1w">{t('work:task.freq1w')}</option>
                    </select>
                  ) : (
                    <input value={scheduleCronDraft} onChange={e => setScheduleCronDraft(e.target.value)}
                      placeholder="0 9 * * 1-5" className="flex-1 px-2 py-1 text-xs bg-surface-elevated border border-border-default rounded-lg outline-none focus:border-brand-500" />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-fg-tertiary shrink-0">{t('work:task.scheduleMaxRuns')}</label>
                  <input value={scheduleMaxRunsDraft} onChange={e => setScheduleMaxRunsDraft(e.target.value.replace(/\D/g, ''))}
                    placeholder={t('work:task.scheduleMaxRunsPlaceholder')} className="w-20 px-2 py-1 text-xs bg-surface-elevated border border-border-default rounded-lg outline-none focus:border-brand-500" />
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button onClick={async () => {
                    const config: { every?: string; cron?: string; maxRuns?: number } = {};
                    if (scheduleMode === 'every') config.every = scheduleEveryDraft;
                    else config.cron = scheduleCronDraft.trim();
                    if (scheduleMaxRunsDraft) config.maxRuns = parseInt(scheduleMaxRunsDraft, 10);
                    await doUpdate(() => api.tasks.updateSchedule(task.id, config));
                    setEditingSchedule(false);
                  }} disabled={actionInFlight} className="px-3 py-1 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50">{t('common:save')}</button>
                  <button onClick={() => setEditingSchedule(false)} className="px-3 py-1 text-xs text-fg-secondary hover:text-fg-primary">{t('common:cancel')}</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1 text-fg-tertiary">
                <span>{t('work:task.scheduleRuns', { current: task.scheduleConfig.currentRuns ?? 0, max: task.scheduleConfig.maxRuns && task.scheduleConfig.maxRuns > 0 ? t('work:task.scheduleRunsMax', { max: task.scheduleConfig.maxRuns }) : '' })}</span>
                {task.scheduleConfig.lastRunAt && (
                  <>
                    <span>·</span>
                    <span>{t('work:task.scheduleLast', { when: (() => {
                      const diff = Date.now() - new Date(task.scheduleConfig!.lastRunAt!).getTime();
                      const m = Math.floor(diff / 60000);
                      if (m < 1) return t('work:task.noteTimeJustNow');
                      if (m < 60) return t('work:task.noteTimeMinutes', { count: m });
                      const h = Math.floor(m / 60);
                      return h < 24 ? t('work:task.noteTimeHours', { count: h }) : t('work:task.noteTimeDays', { count: Math.floor(h / 24) });
                    })() })}</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="px-6 py-4 border-t border-border-default flex items-center justify-between gap-2">
          <div className="flex gap-2 flex-wrap">
            {/* ── Approve / Start Execution (pending) ── */}
            {task.status === 'pending' && (
              <>
                <button onClick={() => {
                  if (isScheduled) { setScheduleApproveModal(true); return; }
                  void doUpdate(() => api.tasks.approve(task.id));
                }} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50">
                  {task.createdBy && !task.createdBy.startsWith('agt_') ? t('work:task.startExecution') : t('work:task.approve')}
                </button>
                {task.createdBy && !task.createdBy.startsWith('agt_') ? (
                  <button onClick={() => void doUpdate(() => api.tasks.cancel(task.id))} disabled={actionInFlight} className="px-3 py-1.5 text-xs text-red-500 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">{t('work:task.cancelTask')}</button>
                ) : (
                  <button onClick={() => setRejectConfirm(true)} disabled={actionInFlight} className="px-3 py-1.5 text-xs text-red-500 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">{t('work:task.reject')}</button>
                )}
              </>
            )}
            {/* ── Review actions ── */}
            {task.status === 'review' && (
              <>
                <button onClick={() => void doUpdate(() => api.tasks.accept(task.id, authUser?.id))} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50">{t('work:task.approveCheck')}</button>
                {!showRevision ? (
                  <button onClick={() => setShowRevision(true)} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 rounded-lg text-white disabled:opacity-50">{t('work:task.requestRevision')}</button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <input type="text" value={revisionReason} onChange={e => setRevisionReason(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && revisionReason.trim()) { void doUpdate(() => api.tasks.revision(task.id, revisionReason.trim(), authUser?.id)); setShowRevision(false); setRevisionReason(''); } }}
                      placeholder={t('work:task.revisionReasonPlaceholder')} autoFocus
                      className="px-2 py-1 text-xs bg-surface-elevated border border-amber-500/40 rounded-lg text-fg-primary focus:border-amber-400 outline-none w-48" />
                    <button onClick={() => { void doUpdate(() => api.tasks.revision(task.id, revisionReason.trim() || t('work:task.revisionsNeededDefault'), authUser?.id)); setShowRevision(false); setRevisionReason(''); }}
                      disabled={actionInFlight} className="px-2.5 py-1 text-xs bg-amber-600 hover:bg-amber-500 rounded-lg text-white disabled:opacity-50">{t('common:send')}</button>
                    <button onClick={() => { setShowRevision(false); setRevisionReason(''); }}
                      className="px-1.5 py-1 text-xs text-fg-secondary hover:text-fg-primary">✕</button>
                  </div>
                )}
              </>
            )}
            {/* ── Execution controls (in_progress / blocked / failed) ── */}
            {isRunning && (
              <>
                <button onClick={() => void pauseTask()} disabled={actionInFlight} className="px-3 py-1.5 text-xs border border-amber-500/30 text-amber-600 rounded-lg hover:bg-amber-500/10 disabled:opacity-50 flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="3" height="9" rx="0.5"/><rect x="7" y="1.5" width="3" height="9" rx="0.5"/></svg>{t('work:task.pause')}
                </button>
                <button onClick={() => void retryFresh()} disabled={actionInFlight} className="px-3 py-1.5 text-xs border border-blue-500/30 text-blue-600 rounded-lg hover:bg-blue-500/10 disabled:opacity-50 flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 6a4.5 4.5 0 1 1 1.3 3.2" strokeLinecap="round"/><path d="M1 3.5V6h2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>{t('work:task.retry')}
                </button>
              </>
            )}
            {isBlocked && (
              <button onClick={() => void resumeTask()} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1">
                {actionInFlight ? <>{t('work:task.resuming')}</> : <><svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>{t('work:task.resume')}</>}
              </button>
            )}
            {/* ── Failed: Retry (fresh) + Continue (keep context) — not for scheduled tasks ── */}
            {isFailed && !isScheduled && (
              <>
                <button onClick={() => void retryFresh()} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 6a4.5 4.5 0 1 1 1.3 3.2" strokeLinecap="round"/><path d="M1 3.5V6h2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>{t('work:task.retry')}
                </button>
                <button onClick={() => void reopenTask()} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>{t('work:task.continueTask')}
                </button>
              </>
            )}
            {/* ── Scheduled task: Run Now / Schedule controls ── */}
            {isScheduled && (isCompleted || isFailed) && !isArchived && (
              <button onClick={() => void runScheduledNow()} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5">
                {actionInFlight ? <>{t('work:task.running')}</> : <><svg className="w-3 h-3" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5z" /></svg>{t('work:task.runNow')}</>}
              </button>
            )}
            {isScheduled && !isRunning && !isArchived && !isRejected && (
              schedPaused
                ? <button onClick={() => void doUpdate(() => api.tasks.resumeSchedule(task.id))} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded-lg text-white disabled:opacity-50">{t('work:task.resumeSchedule')}</button>
                : <button onClick={() => void doUpdate(() => api.tasks.pauseSchedule(task.id))} disabled={actionInFlight} className="px-3 py-1.5 text-xs border border-amber-500/30 text-amber-600 rounded-lg hover:bg-amber-500/10 disabled:opacity-50">{t('work:task.pauseSchedule')}</button>
            )}
            {/* ── Archive (all archivable terminal states) — requires confirmation ── */}
            {(isCompleted || isFailed || isRejected || isCancelled) && (
              <button onClick={() => setArchiveConfirm(true)} disabled={actionInFlight} className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 rounded-lg text-white disabled:opacity-50">{t('work:task.archive')}</button>
            )}
            {/* ── Reopen (completed standard task only) ── */}
            {isCompleted && !isScheduled && (
              <button onClick={() => void reopenTask()} disabled={actionInFlight} className="px-3 py-1.5 text-xs border border-border-default hover:bg-surface-elevated rounded-lg text-fg-secondary disabled:opacity-50">{t('work:task.reopen')}</button>
            )}
            {/* ── Cancel (non-terminal, non-pending) — always requires confirmation ── */}
            {!isTerminal && task.status !== 'pending' && (
              <button onClick={async () => {
                const { count } = await api.tasks.getDependentCount(task.id);
                setCancelConfirm({ dependentCount: count });
              }} disabled={actionInFlight} className="px-3 py-1.5 text-xs text-red-500 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50">{t('work:task.cancelTask')}</button>
            )}
          </div>
        </div>

      {pendingDelete && <ConfirmModal title={t('work:task.deleteSubtaskTitle', { title: pendingDelete.title })} message={t('work:task.deleteSubtaskMessage')} confirmLabel={t('common:delete')} onConfirm={() => void deleteSubtask(pendingDelete)} onCancel={() => setPendingDelete(null)} />}
      {rejectConfirm && (
        <ConfirmModal
          title={t('work:task.rejectConfirmTitle')}
          message={t('work:task.rejectConfirmMessage')}
          confirmLabel={t('work:task.reject')}
          onConfirm={() => { setRejectConfirm(false); void doUpdate(() => api.tasks.reject(task.id)); }}
          onCancel={() => setRejectConfirm(false)}
        />
      )}
      {archiveConfirm && (
        <ConfirmModal
          title={t('work:task.archiveConfirmTitle')}
          message={isScheduled ? t('work:task.archiveScheduledConfirmMessage') : t('work:task.archiveConfirmMessage')}
          confirmLabel={t('work:task.archive')}
          onConfirm={() => { setArchiveConfirm(false); void doUpdate(() => api.tasks.archive(task.id)); }}
          onCancel={() => setArchiveConfirm(false)}
        />
      )}
      {cancelConfirm && cancelConfirm.dependentCount > 0 ? (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={() => setCancelConfirm(null)}>
          <div className="bg-surface-default border border-border-default rounded-xl p-6 max-w-md w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-fg-primary mb-2">{t('work:task.cancelTaskModalTitle')}</h3>
            <p className="text-sm text-fg-secondary mb-4">
              {t('work:task.cancelTaskDependent', { count: cancelConfirm.dependentCount })}
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={() => { setCancelConfirm(null); void doUpdate(() => api.tasks.cancel(task.id, false)); }}
                className="w-full px-4 py-2.5 text-sm bg-surface-elevated border border-border-default rounded-lg hover:bg-surface-overlay text-fg-primary text-left">
                <span className="font-medium">{t('work:task.cancelTaskOnly')}</span>
                <span className="block text-xs text-fg-tertiary mt-0.5">{t('work:task.cancelTaskOnlyHint')}</span>
              </button>
              <button onClick={() => { setCancelConfirm(null); void doUpdate(() => api.tasks.cancel(task.id, true)); }}
                className="w-full px-4 py-2.5 text-sm bg-red-500/10 border border-red-500/30 rounded-lg hover:bg-red-500/20 text-red-500 text-left">
                <span className="font-medium">{t('work:task.cancelWithDependents')}</span>
                <span className="block text-xs text-red-500/70 mt-0.5">{t('work:task.cancelWithDependentsHint', { count: cancelConfirm.dependentCount })}</span>
              </button>
              <button onClick={() => setCancelConfirm(null)} className="w-full px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary">
                {t('work:task.keepTaskRunning')}
              </button>
            </div>
          </div>
        </div>
      ) : cancelConfirm && (
        <ConfirmModal
          title={t('work:task.cancelTaskModalTitle')}
          message={t('work:task.cancelConfirmMessage')}
          confirmLabel={t('work:task.cancelTask')}
          onConfirm={() => { setCancelConfirm(null); void doUpdate(() => api.tasks.cancel(task.id)); }}
          onCancel={() => setCancelConfirm(null)}
        />
      )}
      {previewFile && <FilePreviewModal filePath={previewFile} onClose={() => setPreviewFile(null)} onOpenExternal={() => {
        setPreviewFile(null);
        api.deliverables.search({ taskId: task.id, limit: 100 }).then(({ results }) => {
          const match = results.find(d => d.reference === previewFile);
          if (match) navBus.navigate(PAGE.DELIVERABLES, { openDeliverable: match.id });
          else navBus.navigate(PAGE.DELIVERABLES);
        }).catch(() => navBus.navigate(PAGE.DELIVERABLES));
      }} />}
      {scheduleApproveModal && task.scheduleConfig && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={() => setScheduleApproveModal(false)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[380px] shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-base mb-2">{t('work:task.scheduleApproveTitle')}</h3>
            <p className="text-sm text-fg-secondary mb-5 leading-relaxed">{t('work:task.scheduleApproveDesc', {
              schedule: task.scheduleConfig.cron
                ? `Cron: ${task.scheduleConfig.cron}`
                : task.scheduleConfig.every
                  ? t('work:task.scheduleEvery', { interval: task.scheduleConfig.every })
                  : '',
              nextRun: task.scheduleConfig.nextRunAt
                ? new Date(task.scheduleConfig.nextRunAt).toLocaleString()
                : t('work:task.scheduleNA'),
            })}</p>
            <div className="flex flex-col gap-2">
              <button
                disabled={actionInFlight}
                onClick={() => { setScheduleApproveModal(false); void doUpdate(() => api.tasks.approve(task.id, true)); }}
                className="w-full px-4 py-2.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                {t('work:task.scheduleApproveRunNow')}
              </button>
              <button
                disabled={actionInFlight}
                onClick={() => { setScheduleApproveModal(false); void doUpdate(() => api.tasks.approve(task.id, false)); }}
                className="w-full px-4 py-2.5 text-sm bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                {t('work:task.scheduleApproveWait')}
              </button>
              <button onClick={() => setScheduleApproveModal(false)} className="w-full px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary">
                {t('common:cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Project Settings Panel ─────────────────────────────────────────────────────

function ProjectSettingsPanel({ project, tasks, requirements, agents, onDeleteProject, onUpdateProject, onRefresh }: {
  project: ProjectInfo;
  tasks: TaskInfo[];
  requirements: RequirementInfo[];
  agents: AgentInfo[];
  onDeleteProject: () => void;
  onUpdateProject: (data: Partial<ProjectInfo>) => Promise<void>;
  onRefresh: () => void;
}) {
  const projTasks = useMemo(() => tasks.filter(t => t.projectId === project.id), [tasks, project.id]);
  const projReqs = useMemo(() => requirements.filter(r => r.projectId === project.id), [requirements, project.id]);
  const stats = useMemo(() => {
    const s = { total: projTasks.length, completed: 0, inProgress: 0, inReview: 0, blocked: 0, pending: 0, failed: 0, reqs: projReqs.length, reqsDone: 0 };
    for (const t of projTasks) {
      if (t.status === 'completed' || t.status === 'accepted') s.completed++;
      else if (t.status === 'in_progress') s.inProgress++;
      else if (t.status === 'review' || t.status === 'revision') s.inReview++;
      else if (t.status === 'blocked') s.blocked++;
      else if (t.status === 'failed') s.failed++;
      else s.pending++;
    }
    for (const r of projReqs) { if (r.status === 'completed') s.reqsDone++; }
    return s;
  }, [projTasks, projReqs]);
  const assignedAgentIds = useMemo(() => new Set(projTasks.map(t => t.assignedAgentId).filter(Boolean)), [projTasks]);
  const projAgents = useMemo(() => agents.filter(a => assignedAgentIds.has(a.id)), [agents, assignedAgentIds]);

  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState('');
  const [newRepoBranch, setNewRepoBranch] = useState('main');
  const [statusUpdating, setStatusUpdating] = useState(false);
  const { t } = useTranslation(['work', 'common']);

  const PROJECT_STATUSES: Array<{ value: string; label: string; desc: string }> = [
    { value: 'active', label: t('work:project.statusActive'), desc: t('work:project.statusActiveDesc') },
    { value: 'paused', label: t('work:project.statusPaused'), desc: t('work:project.statusPausedDesc') },
    { value: 'archived', label: t('work:project.statusArchived'), desc: t('work:project.statusArchivedDesc') },
  ];

  const handleStatusChange = async (newStatus: string) => {
    if (newStatus === project.status) return;
    setStatusUpdating(true);
    try {
      await onUpdateProject({ status: newStatus } as Partial<ProjectInfo>);
      onRefresh();
    } finally { setStatusUpdating(false); }
  };

  const handleAddRepo = async () => {
    const path = newRepoPath.trim();
    if (!path) return;
    const repos = [...(project.repositories ?? []), { url: '', localPath: path, defaultBranch: newRepoBranch || 'main' }];
    await onUpdateProject({ repositories: repos } as Partial<ProjectInfo>);
    setNewRepoPath('');
    setNewRepoBranch('main');
    setAddRepoOpen(false);
    onRefresh();
  };

  const handleRemoveRepo = async (idx: number) => {
    const repos = (project.repositories ?? []).filter((_, i) => i !== idx);
    await onUpdateProject({ repositories: repos } as Partial<ProjectInfo>);
    onRefresh();
  };

  return (
    <div className="p-5 space-y-5 max-w-3xl">
      {/* Description + metadata */}
      <div className="space-y-3">
        <InlineEditableTextarea
          value={project.description ?? ''}
          onSave={async (desc) => { await onUpdateProject({ description: desc }); onRefresh(); }}
          className="text-sm text-fg-secondary"
          placeholder={t('work:project.descriptionPlaceholderLong')}
        />
        <div className="flex items-center gap-3 text-xs text-fg-tertiary">
          {project.createdAt && <span>{t('work:project.createdLabel')} {new Date(project.createdAt).toLocaleDateString()}</span>}
          {project.updatedAt && <span>{t('work:project.updatedLabel')} {new Date(project.updatedAt).toLocaleDateString()}</span>}
        </div>
      </div>

      {/* Status toggle */}
      <div className="bg-surface-elevated rounded-xl p-4">
        <h4 className="text-xs font-semibold text-fg-secondary mb-3">{t('work:project.projectStatusHeading')}</h4>
        <div className="flex gap-2">
          {PROJECT_STATUSES.map(s => (
            <button
              key={s.value}
              disabled={statusUpdating}
              onClick={() => handleStatusChange(s.value)}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                project.status === s.value
                  ? s.value === 'active' ? 'bg-green-500/15 text-green-600 ring-1 ring-green-500/30'
                    : s.value === 'paused' ? 'bg-amber-500/15 text-amber-600 ring-1 ring-amber-500/30'
                    : 'bg-gray-500/15 text-fg-tertiary ring-1 ring-gray-500/30'
                  : 'bg-surface-elevated text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay'
              } ${statusUpdating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div>{s.label}</div>
              <div className="text-[10px] opacity-70 mt-0.5">{s.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Task Statistics */}
      <div className="bg-surface-elevated rounded-xl p-4">
        <h4 className="text-xs font-semibold text-fg-secondary mb-3">{t('work:project.taskOverview')}</h4>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          <StatCard label={t('work:project.statTotal')} value={stats.total} color="text-fg-primary" />
          <StatCard label={t('work:project.statCompleted')} value={stats.completed} color="text-green-600" />
          <StatCard label={t('work:project.statInProgress')} value={stats.inProgress} color="text-brand-500" />
          <StatCard label={t('work:project.statInReview')} value={stats.inReview} color="text-brand-500" />
          <StatCard label={t('work:project.statBlocked')} value={stats.blocked} color="text-amber-600" />
          <StatCard label={t('work:project.statFailed')} value={stats.failed} color="text-red-500" />
        </div>
        {stats.total > 0 && (
          <div className="mt-3 flex h-2 rounded-full overflow-hidden bg-surface-elevated">
            {stats.completed > 0 && <div className="bg-green-500" style={{ width: `${(stats.completed / stats.total) * 100}%` }} />}
            {stats.inProgress > 0 && <div className="bg-brand-500" style={{ width: `${(stats.inProgress / stats.total) * 100}%` }} />}
            {stats.inReview > 0 && <div className="bg-brand-500" style={{ width: `${(stats.inReview / stats.total) * 100}%` }} />}
            {stats.blocked > 0 && <div className="bg-amber-500" style={{ width: `${(stats.blocked / stats.total) * 100}%` }} />}
            {stats.pending > 0 && <div className="bg-blue-500/40" style={{ width: `${(stats.pending / stats.total) * 100}%` }} />}
            {stats.failed > 0 && <div className="bg-red-500" style={{ width: `${(stats.failed / stats.total) * 100}%` }} />}
          </div>
        )}
      </div>

      {/* Requirement Stats */}
      <div className="bg-surface-elevated rounded-xl p-4">
        <h4 className="text-xs font-semibold text-fg-secondary mb-3">{t('work:project.requirementsHeading')}</h4>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label={t('work:project.statTotal')} value={stats.reqs} color="text-fg-primary" />
          <StatCard label={t('work:project.statCompleted')} value={stats.reqsDone} color="text-green-600" />
          <StatCard label={t('work:project.statActive')} value={stats.reqs - stats.reqsDone} color="text-brand-500" />
        </div>
      </div>

      {/* Agents working on this project */}
      {projAgents.length > 0 && (
        <div className="bg-surface-elevated rounded-xl p-4">
          <h4 className="text-xs font-semibold text-fg-secondary mb-3">{t('work:project.agentsHeading', { count: projAgents.length })}</h4>
          <div className="flex flex-wrap gap-2">
            {projAgents.map(a => {
              const agentTasks = projTasks.filter(t => t.assignedAgentId === a.id);
              const activeTasks = agentTasks.filter(t => !['completed', 'failed', 'cancelled', 'archived'].includes(t.status));
              return (
                <div key={a.id} className="flex items-center gap-2 px-3 py-2 bg-surface-elevated/60 rounded-lg">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${a.status === 'working' ? 'bg-blue-500' : a.status === 'idle' ? 'bg-green-500' : 'bg-gray-500'}`} />
                  <span className="text-xs text-fg-secondary">{a.name}</span>
                  <span className="text-[10px] text-fg-tertiary">{t('work:project.agentTaskCounts', { active: activeTasks.length, total: agentTasks.length })}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Repositories */}
      <div className="bg-surface-elevated rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-semibold text-fg-secondary">{t('work:project.repositories')}</h4>
          <button onClick={() => setAddRepoOpen(!addRepoOpen)} className="text-[10px] text-brand-500 hover:text-brand-500">
            {addRepoOpen ? t('common:cancel') : t('work:project.addRepo')}
          </button>
        </div>
        {(project.repositories ?? []).length === 0 && !addRepoOpen && (
          <p className="text-xs text-fg-tertiary">{t('work:project.noReposLinked')}</p>
        )}
        {(project.repositories ?? []).map((r, i) => (
          <div key={i} className="flex items-center gap-2 py-1.5 group">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-tertiary shrink-0"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" /><path d="M9 18c-4.51 2-5-2-7-2" /></svg>
            <span className="text-xs text-fg-secondary flex-1 min-w-0 truncate">{r.url || r.localPath}</span>
            <span className="text-[10px] text-fg-tertiary shrink-0">{r.defaultBranch}</span>
            <button
              onClick={() => handleRemoveRepo(i)}
              className="text-fg-tertiary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              title={t('work:project.removeRepo')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        ))}
        {addRepoOpen && (
          <div className="mt-2 space-y-2 p-3 bg-surface-elevated rounded-lg border border-border-default">
            <input
              value={newRepoPath}
              onChange={e => setNewRepoPath(e.target.value)}
              placeholder={t('work:project.repoPathPlaceholder')}
              className="w-full px-2.5 py-1.5 text-xs bg-surface-primary border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary"
            />
            <div className="flex gap-2">
              <input
                value={newRepoBranch}
                onChange={e => setNewRepoBranch(e.target.value)}
                placeholder={t('work:project.repoBranchPlaceholder')}
                className="flex-1 px-2.5 py-1.5 text-xs bg-surface-primary border border-border-default rounded-md text-fg-primary placeholder:text-fg-tertiary"
              />
              <button
                onClick={handleAddRepo}
                disabled={!newRepoPath.trim()}
                className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-md hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >{t('work:task.add')}</button>
            </div>
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div className="border border-red-500/20 rounded-xl p-4">
        <h4 className="text-xs font-semibold text-red-500/80 mb-2">{t('work:project.dangerZone')}</h4>
        <p className="text-[11px] text-fg-tertiary mb-3">{t('work:project.dangerZoneDeleteHint')}</p>
        <button onClick={onDeleteProject} className="px-3 py-1.5 text-xs text-red-500 border border-red-500/30 hover:bg-red-500/10 rounded-lg transition-colors">{t('work:project.deleteProject')}</button>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center py-2">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-fg-tertiary mt-0.5">{label}</div>
    </div>
  );
}

// ─── Requirement → Board Column Mapping ──────────────────────────────────────

const REQ_COLUMN_MAP: Record<string, string> = {
  pending: 'todo',
  in_progress: 'in_progress',
  completed: 'done',
  rejected: 'closed', cancelled: 'closed', archived: 'closed',
};

const REQ_DROP_STATUS: Record<string, string> = {
  failed: 'rejected',
  todo: 'pending',
  in_progress: 'in_progress',
  review: 'in_progress',
  done: 'completed',
  closed: 'cancelled',
};

// ─── Backlog Table View ─────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const GROUP_ORDER: Record<string, number> = { failed: 0, todo: 1, in_progress: 2, review: 3, done: 4, closed: 5 };
const GROUP_ACCENT: Record<string, string> = {
  failed: 'border-l-red-500 bg-red-500/5',
  todo: 'border-l-blue-500 bg-blue-500/5',
  in_progress: 'border-l-brand-500 bg-brand-500/5',
  review: 'border-l-purple-500 bg-brand-500/5',
  done: 'border-l-green-500 bg-green-500/5',
  closed: 'border-l-gray-500 bg-gray-500/5',
};
const GROUP_HEADER_CLS: Record<string, string> = {
  failed: 'border-l-red-500 text-red-500',
  todo: 'border-l-blue-500 text-blue-600',
  in_progress: 'border-l-brand-500 text-brand-500',
  review: 'border-l-purple-500 text-brand-500',
  done: 'border-l-green-500 text-green-600',
  closed: 'border-l-gray-500 text-fg-tertiary',
};

const ALL_REQ_STATUSES = ['pending', 'in_progress', 'completed', 'rejected', 'cancelled', 'archived'] as const;

function taskToGroup(status: string): string {
  for (const col of BOARD_COLUMNS_BASE) {
    if ((col.statuses as readonly string[]).includes(status)) return col.id;
  }
  return 'closed';
}

type BacklogRow =
  | { kind: 'task'; data: TaskInfo; group: string; groupOrder: number }
  | { kind: 'req';  data: RequirementInfo; group: string; groupOrder: number };

function relativeTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('work:relative.justNow');
  if (mins < 60) return t('work:relative.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('work:relative.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  return t('work:relative.daysAgo', { count: days });
}

function TagPicker({ value, options, onSelect, allowedValues }: {
  value: string;
  options: Array<{ value: string; label: string; cls: string }>;
  onSelect: (val: string) => void;
  allowedValues?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        className={`text-[11px] px-2 py-0.5 rounded-full font-medium transition-colors cursor-pointer hover:ring-1 hover:ring-current/30 ${current?.cls ?? 'bg-gray-500/15 text-fg-tertiary'}`}
      >
        {current?.label ?? value}
      </button>
      {open && (
        <div ref={panelRef} className="absolute top-full left-0 mt-1 w-40 bg-surface-overlay border border-border-default rounded-lg shadow-xl z-50 py-1 max-h-64 overflow-y-auto">
          {options.map(o => {
            const isCurrent = o.value === value;
            const isAllowed = isCurrent || !allowedValues || allowedValues.has(o.value);
            return (
              <button
                key={o.value}
                disabled={!isAllowed}
                onClick={() => { if (!isCurrent && isAllowed) onSelect(o.value); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-2 transition-colors ${
                  isCurrent ? 'bg-surface-elevated' : isAllowed ? 'hover:bg-surface-elevated/60' : 'opacity-35 cursor-not-allowed'
                }`}
              >
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${isAllowed ? o.cls.split(' ')[0] : 'bg-gray-600'}`} />
                <span className={`font-medium ${isCurrent ? 'text-fg-primary' : isAllowed ? 'text-fg-secondary' : 'text-fg-muted'}`}>{o.label}</span>
                {isCurrent && <svg className="w-3 h-3 ml-auto text-brand-500" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BacklogRowView({ row, idx, dragIdx, agentMap, projMap, onTaskClick, onReqClick, onRowDragStart, onRowDragEnd, handleStatusChange, handlePriorityChange, selected, isMobile, isAbnormalBlocked }: {
  row: BacklogRow; idx: number; dragIdx: number | null;
  agentMap: Map<string, AgentInfo>; projMap: Map<string, ProjectInfo>;
  onTaskClick: (t: TaskInfo) => void; onReqClick: (r: RequirementInfo) => void;
  onRowDragStart: (e: React.DragEvent, idx: number) => void; onRowDragEnd: (e: React.DragEvent) => void;
  handleStatusChange: (row: BacklogRow, val: string) => Promise<void>;
  handlePriorityChange: (row: BacklogRow, val: string) => Promise<void>;
  selected?: boolean;
  isMobile?: boolean;
  isAbnormalBlocked?: boolean;
}) {
  const { t } = useTranslation(['work', 'common']);
  const taskStatusBadges = useMemo(() => buildTaskStatusBadges(t), [t]);
  const reqStatusBadges = useMemo(() => buildReqStatusBadges(t), [t]);
  const priorityBadges = useMemo(() => buildPriorityBadges(t), [t]);
  const status = row.data.status;
  const priority = row.data.priority;
  const assignee = row.kind === 'task' ? agentMap.get(row.data.assignedAgentId ?? '') : undefined;
  const proj = (() => {
    const p = projMap.get(row.kind === 'task' ? (row.data.projectId ?? '') : (row.data.projectId ?? ''));
    return p && p.name !== 'default' ? p : undefined;
  })();

  const typeBadge = row.kind === 'req' ? (
    <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-amber-500/15 text-amber-600">{t('work:task.requirementShort')}</span>
  ) : row.data.taskType === 'scheduled' ? (
    <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-blue-500/15 text-blue-600">{t('work:task.schedShort')}</span>
  ) : (
    <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-gray-500/15 text-fg-secondary">{t('work:task.taskShort')}</span>
  );

  if (isMobile) {
    return (
      <div
        onClick={() => row.kind === 'task' ? onTaskClick(row.data) : onReqClick(row.data)}
        className={`px-3 py-2 border-b border-border-default/40 cursor-pointer transition-colors border-l-2 ${GROUP_ACCENT[row.group] ?? 'border-l-gray-700'} ${selected ? 'bg-brand-500/10 border-l-brand-500' : 'active:bg-surface-elevated/50'}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {typeBadge}
          {isAbnormalBlocked && <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-red-500/15 text-red-500">⚠</span>}
          <span className="text-sm text-fg-primary truncate flex-1">{row.data.title}</span>
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <div onClick={e => e.stopPropagation()}>
            <TagPicker
              value={status}
              options={
                row.kind === 'task'
                  ? TASK_STATUS_CYCLE.map(s => ({ value: s, label: taskStatusBadges[s]?.label ?? s, cls: taskStatusBadges[s]?.cls ?? 'bg-gray-500/15 text-fg-tertiary' }))
                  : REQ_STATUS_CYCLE.map(s => ({ value: s, label: reqStatusBadges[s]?.label ?? s, cls: reqStatusBadges[s]?.cls ?? 'bg-gray-500/15 text-fg-tertiary' }))
              }
              allowedValues={row.kind === 'task' ? TASK_ALLOWED_TRANSITIONS[status] : REQ_ALLOWED_TRANSITIONS[status]}
              onSelect={val => void handleStatusChange(row, val)}
            />
          </div>
          <div onClick={e => e.stopPropagation()}>
            <TagPicker
              value={priority}
              options={PRIORITY_CYCLE.map(p => ({ value: p, label: priorityBadges[p]?.label ?? p, cls: priorityBadges[p]?.cls ?? 'bg-gray-500/15 text-fg-tertiary' }))}
              onSelect={val => void handlePriorityChange(row, val)}
            />
          </div>
          {assignee && (
            <span className="flex items-center gap-1 text-[10px]">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[assignee.status] ?? 'bg-gray-500'}`} />
              <span className={`${AGENT_STATUS_TEXT[assignee.status] ?? 'text-fg-secondary'}`}>{assignee.name}</span>
            </span>
          )}
          {proj?.name && <span className="text-[10px] text-brand-400/70 truncate max-w-[80px]">{proj.name}</span>}
          <span className="text-[9px] text-fg-muted ml-auto">{relativeTime(row.data.updatedAt ?? '', t)}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={e => onRowDragStart(e, idx)}
      onDragEnd={onRowDragEnd}
      onClick={() => row.kind === 'task' ? onTaskClick(row.data) : onReqClick(row.data)}
      className={`flex items-center gap-2 px-6 py-2 border-b border-border-default/40 cursor-pointer transition-colors border-l-2 ${GROUP_ACCENT[row.group] ?? 'border-l-gray-700'} ${dragIdx === idx ? 'opacity-40' : ''} ${selected ? 'bg-brand-500/10 border-l-brand-500 hover:bg-brand-500/15' : 'hover:bg-surface-elevated/50'}`}
    >
      <div className="w-12 shrink-0">{typeBadge}</div>
      <div className="flex-1 min-w-[200px] text-sm text-fg-primary truncate flex items-center gap-1.5">
        <span className="truncate">{row.data.title}</span>
        {isAbnormalBlocked && <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold bg-red-500/15 text-red-500 shrink-0">⚠</span>}
      </div>
      <div className="w-[130px] shrink-0" onClick={e => e.stopPropagation()}>
        <TagPicker
          value={status}
          options={
            row.kind === 'task'
              ? TASK_STATUS_CYCLE.map(s => ({ value: s, label: taskStatusBadges[s]?.label ?? s, cls: taskStatusBadges[s]?.cls ?? 'bg-gray-500/15 text-fg-tertiary' }))
              : REQ_STATUS_CYCLE.map(s => ({ value: s, label: reqStatusBadges[s]?.label ?? s, cls: reqStatusBadges[s]?.cls ?? 'bg-gray-500/15 text-fg-tertiary' }))
          }
          allowedValues={row.kind === 'task' ? TASK_ALLOWED_TRANSITIONS[status] : REQ_ALLOWED_TRANSITIONS[status]}
          onSelect={val => void handleStatusChange(row, val)}
        />
      </div>
      <div className="w-[100px] shrink-0" onClick={e => e.stopPropagation()}>
        <TagPicker
          value={priority}
          options={PRIORITY_CYCLE.map(p => ({ value: p, label: priorityBadges[p]?.label ?? p, cls: priorityBadges[p]?.cls ?? 'bg-gray-500/15 text-fg-tertiary' }))}
          onSelect={val => void handlePriorityChange(row, val)}
        />
      </div>
      <div className="w-[120px] shrink-0 text-[11px] truncate">
        {assignee ? (
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[assignee.status] ?? 'bg-gray-500'}`} />
            <span className={`font-medium ${AGENT_STATUS_TEXT[assignee.status] ?? 'text-fg-secondary'}`}>{assignee.name}</span>
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </div>
      <div className="w-[120px] shrink-0 text-[11px] truncate">
        {proj?.name ? (
          <span className="text-brand-400/70">{proj.name}</span>
        ) : (
          <span className="text-fg-muted">—</span>
        )}
      </div>
      <div className="w-[90px] shrink-0 text-[10px] text-fg-muted text-right">
        {relativeTime(row.data.updatedAt ?? '', t)}
      </div>
    </div>
  );
}

function BacklogTable({ tasks, requirements, agents, projects, onTaskClick, onReqClick, onRefresh, selectedTaskId, selectedReqId }: {
  tasks: TaskInfo[];
  requirements: RequirementInfo[];
  agents: AgentInfo[];
  projects: ProjectInfo[];
  onTaskClick: (t: TaskInfo) => void;
  onReqClick: (r: RequirementInfo) => void;
  onRefresh: () => void;
  selectedTaskId?: string | null;
  selectedReqId?: string | null;
}) {
  const { t } = useTranslation(['work', 'common']);
  const isMobile = useIsMobile();
  const [sortMode, setSortMode] = useState<'status' | 'priority'>('status');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  const taskMap = useMemo(() => {
    const m = new Map<string, TaskInfo>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const checkAbnormalBlocked = useCallback((task: TaskInfo): boolean => {
    if (task.status !== 'blocked') return false;
    if (!task.blockedBy || task.blockedBy.length === 0) return true;
    return task.blockedBy.every(id => {
      const dep = taskMap.get(id);
      return dep && dep.status === 'completed';
    });
  }, [taskMap]);

  const rows = useMemo(() => {
    const result: BacklogRow[] = [];
    for (const t of tasks) {
      const group = taskToGroup(t.status);
      result.push({ kind: 'task', data: t, group, groupOrder: GROUP_ORDER[group] ?? 5 });
    }
    for (const r of requirements) {
      const group = REQ_COLUMN_MAP[r.status] ?? 'todo';
      result.push({ kind: 'req', data: r, group, groupOrder: GROUP_ORDER[group] ?? 5 });
    }

    if (sortMode === 'status') {
      result.sort((a, b) => {
        if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
        const aT = new Date(a.data.updatedAt ?? 0).getTime();
        const bT = new Date(b.data.updatedAt ?? 0).getTime();
        return bT - aT;
      });
    } else {
      const pA = (r: BacklogRow) => PRIORITY_ORDER[r.data.priority] ?? 2;
      result.sort((a, b) => {
        const pa = pA(a), pb = pA(b);
        if (pa !== pb) return pa - pb;
        return new Date(b.data.updatedAt ?? 0).getTime() - new Date(a.data.updatedAt ?? 0).getTime();
      });
    }
    return result;
  }, [tasks, requirements, sortMode]);

  const handleStatusChange = async (row: BacklogRow, newStatus: string) => {
    try {
      if (row.kind === 'task') {
        await api.tasks.updateStatus(row.data.id, newStatus);
      } else {
        await api.requirements.updateStatus(row.data.id, newStatus);
      }
      onRefresh();
    } catch { /* */ }
  };

  const handlePriorityChange = async (row: BacklogRow, newPriority: string) => {
    try {
      if (row.kind === 'task') {
        await api.tasks.update(row.data.id, { priority: newPriority });
      } else {
        await api.requirements.update(row.data.id, { priority: newPriority });
      }
      onRefresh();
    } catch { /* */ }
  };

  const onRowDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };
  const onRowDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    setDragIdx(null);
    setDragOverGroup(null);
  };
  const onGroupDragOver = (e: DragEvent<HTMLDivElement>, groupId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverGroup !== groupId) setDragOverGroup(groupId);
  };
  const onGroupDrop = async (e: DragEvent<HTMLDivElement>, groupId: string) => {
    e.preventDefault();
    setDragOverGroup(null);
    if (dragIdx == null) return;
    const row = rows[dragIdx];
    if (!row || row.group === groupId) return;
    const col = BOARD_COLUMNS_BASE.find(c => c.id === groupId);
    if (!col) return;
    try {
      if (row.kind === 'task') {
        if (row.data.status === 'pending') return;
        await api.tasks.updateStatus(row.data.id, col.dropStatus);
      } else {
        const reqStatus = REQ_DROP_STATUS[groupId];
        if (reqStatus) await api.requirements.updateStatus(row.data.id, reqStatus);
      }
      onRefresh();
    } catch { /* */ }
    setDragIdx(null);
  };

  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const projMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);

  const ALWAYS_SHOW_GROUPS = ['todo', 'in_progress', 'review', 'done'];
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.group] = (counts[r.group] ?? 0) + 1;
    return counts;
  }, [rows]);
  const { rowsByGroup, rowIndexMap } = useMemo(() => {
    const map = new Map<string, BacklogRow[]>();
    const idxMap = new Map<BacklogRow, number>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      idxMap.set(r, i);
      const list = map.get(r.group) ?? [];
      list.push(r);
      map.set(r.group, list);
    }
    return { rowsByGroup: map, rowIndexMap: idxMap };
  }, [rows]);
  const visibleGroups = useMemo(() => {
    if (sortMode !== 'status') return null;
    const dataGroups = new Set(rows.map(r => r.group));
    const groups: string[] = [];
    const seen = new Set<string>();
    if (dataGroups.has('failed')) { groups.push('failed'); seen.add('failed'); }
    for (const g of ALWAYS_SHOW_GROUPS) { groups.push(g); seen.add(g); }
    for (const r of rows) { if (!seen.has(r.group)) { groups.push(r.group); seen.add(r.group); } }
    return groups;
  }, [rows, sortMode]);

  return (
    <div className={`flex-1 min-h-0 overflow-auto bg-surface-primary ${isMobile ? 'overflow-x-hidden w-full' : ''}`}>
      <div className={isMobile ? 'w-full' : 'w-fit min-w-full'}>
      {/* Table header with integrated sort */}
      {!isMobile && (
      <div className="flex items-center gap-2 px-6 py-2 border-b border-border-default text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider sticky top-0 z-20 bg-surface-primary">
        <div className="w-12 shrink-0 text-fg-muted normal-case font-normal">{rows.length}</div>
        <div className="flex-1 min-w-[200px]">{t('work:task.backlogTitle')}</div>
        <button onClick={() => setSortMode('status')} className={`w-[130px] shrink-0 text-left flex items-center gap-1 transition-colors ${sortMode === 'status' ? 'text-brand-500' : 'hover:text-fg-secondary'}`}>
          {t('work:filters.status')} {sortMode === 'status' && <span className="text-[8px]">▼</span>}
        </button>
        <button onClick={() => setSortMode('priority')} className={`w-[100px] shrink-0 text-left flex items-center gap-1 transition-colors ${sortMode === 'priority' ? 'text-brand-500' : 'hover:text-fg-secondary'}`}>
          {t('work:filters.priority')} {sortMode === 'priority' && <span className="text-[8px]">▼</span>}
        </button>
        <div className="w-[120px] shrink-0">{t('work:filters.assignee')}</div>
        <div className="w-[120px] shrink-0">{t('work:task.projectLabel')}</div>
        <div className="w-[90px] shrink-0 text-right">{t('work:task.backlogUpdated')}</div>
      </div>
      )}

      {/* Table body */}
      <div>
        {sortMode === 'status' && visibleGroups ? (
          visibleGroups.map(groupId => {
            const groupRows = rowsByGroup.get(groupId) ?? [];
            return (
              <div key={groupId}>
                <div
                  className={`flex items-center gap-2 px-6 py-2 border-l-2 bg-surface-primary/80 sticky top-0 z-10 ${GROUP_HEADER_CLS[groupId] ?? ''} ${dragOverGroup === groupId ? 'ring-1 ring-brand-500/40' : ''}`}
                  onDragOver={e => onGroupDragOver(e, groupId)}
                  onDragLeave={() => setDragOverGroup(null)}
                  onDrop={e => void onGroupDrop(e, groupId)}
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wider">{t(`work:boardColumn.${groupId}`)}</span>
                  <span className="text-[10px] text-fg-tertiary">{groupCounts[groupId] ?? 0}</span>
                </div>
                {groupRows.map(row => (
                  <BacklogRowView key={`${row.kind}-${row.data.id}`} row={row} idx={rowIndexMap.get(row) ?? 0} dragIdx={dragIdx} agentMap={agentMap} projMap={projMap} onTaskClick={onTaskClick} onReqClick={onReqClick} onRowDragStart={onRowDragStart} onRowDragEnd={onRowDragEnd} handleStatusChange={handleStatusChange} handlePriorityChange={handlePriorityChange} selected={row.kind === 'task' ? row.data.id === selectedTaskId : row.data.id === selectedReqId} isMobile={isMobile} isAbnormalBlocked={row.kind === 'task' ? checkAbnormalBlocked(row.data) : false} />
                ))}
              </div>
            );
          })
        ) : (
          rows.map((row, idx) => (
            <BacklogRowView key={`${row.kind}-${row.data.id}`} row={row} idx={idx} dragIdx={dragIdx} agentMap={agentMap} projMap={projMap} onTaskClick={onTaskClick} onReqClick={onReqClick} onRowDragStart={onRowDragStart} onRowDragEnd={onRowDragEnd} handleStatusChange={handleStatusChange} handlePriorityChange={handlePriorityChange} selected={row.kind === 'task' ? row.data.id === selectedTaskId : row.data.id === selectedReqId} isMobile={isMobile} isAbnormalBlocked={row.kind === 'task' ? checkAbnormalBlocked(row.data) : false} />
          ))
        )}
        {rows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 max-w-sm mx-auto text-center">
            <svg className="w-10 h-10 text-fg-quaternary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            <p className="text-sm font-medium text-fg-secondary">{t('work:task.backlogEmptyTitle')}</p>
            <p className="text-xs text-fg-tertiary leading-relaxed">{t('work:task.backlogEmptyDesc')}</p>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export interface WorkPreviewData {
  projects?: ProjectInfo[];
  board?: Record<string, TaskInfo[]>;
  agents?: AgentInfo[];
  users?: HumanUserInfo[];
  allRequirements?: RequirementInfo[];
  initialBoardType?: 'backlog' | 'kanban' | 'dag';
  initialSelectedReqId?: string;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workflow';
}

function generateWorkflowSteps(
  tasks: TaskInfo[],
  agentMap: Record<string, string>,
): Array<{ id: string; name: string; role: string; prompt: string; depends_on: string[] }> {
  const taskIdToStepId = new Map<string, string>();
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  const usedIds = new Set<string>();
  for (const t of tasks) {
    let base = slugify(t.title).replace(/[^a-z0-9-]/g, '').slice(0, 30) || `step`;
    if (usedIds.has(base)) base = `${base}-${t.id.slice(-4)}`;
    usedIds.add(base);
    taskIdToStepId.set(t.id, base);
  }

  // Derive abstract role names from agent names (lowercase, no spaces)
  const agentToRole = new Map<string, string>();
  const usedRoles = new Set<string>();
  for (const t of tasks) {
    const aid = t.assignedAgentId;
    if (aid && !agentToRole.has(aid)) {
      const name = agentMap[aid] ?? 'worker';
      let role = slugify(name).replace(/[^a-z0-9-]/g, '') || 'worker';
      if (usedRoles.has(role)) role = `${role}-${aid.slice(-4)}`;
      usedRoles.add(role);
      agentToRole.set(aid, role);
    }
  }

  return tasks.map(t => ({
    id: taskIdToStepId.get(t.id)!,
    name: t.title,
    role: agentToRole.get(t.assignedAgentId) ?? 'worker',
    prompt: t.description || t.title,
    depends_on: (t.blockedBy ?? [])
      .filter(depId => taskMap.has(depId))
      .map(depId => taskIdToStepId.get(depId)!)
      .filter(Boolean),
  }));
}

function yamlSafeStr(s: string): string {
  if (/[:#\[\]{}&*!|>'"%@`\n]/.test(s) || s.startsWith(' ') || s.endsWith(' ')) {
    return JSON.stringify(s);
  }
  return s;
}

function generateWorkflowYaml(
  name: string,
  description: string,
  steps: Array<{ id: string; name: string; role: string; prompt: string; depends_on: string[] }>,
): string {
  const lines: string[] = [];
  lines.push(`name: ${yamlSafeStr(name)}`);
  lines.push(`description: ${yamlSafeStr(description.replace(/\n/g, ' ').slice(0, 200))}`);
  lines.push(`version: "1.0.0"`);
  lines.push('');
  lines.push('steps:');
  for (const step of steps) {
    lines.push(`  - id: ${step.id}`);
    lines.push(`    name: ${yamlSafeStr(step.name)}`);
    lines.push(`    type: agent_task`);
    lines.push(`    role: ${yamlSafeStr(step.role)}`);
    if (step.depends_on.length > 0) {
      lines.push(`    depends_on: [${step.depends_on.join(', ')}]`);
    }
    if (step.depends_on.length > 0) {
      lines.push('    inputs:');
      for (const depId of step.depends_on) {
        lines.push(`      - from: ${depId}`);
        lines.push(`        as: ${depId}_output`);
      }
    }
    lines.push(`    prompt: |`);
    for (const pLine of step.prompt.split('\n')) {
      lines.push(`      ${pLine}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function SaveAsWorkflowModal({
  req, tasks, agents, teamId, onClose, onSaved,
}: {
  req: RequirementInfo;
  tasks: TaskInfo[];
  agents: AgentInfo[];
  teamId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['work']);
  const agentMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of agents) m[a.id] = a.name;
    return m;
  }, [agents]);

  const initialSteps = useMemo(() => generateWorkflowSteps(tasks, agentMap), [tasks, agentMap]);

  const [name, setName] = useState(() => slugify(req.title));
  const [description, setDescription] = useState(req.description || req.title);
  const [steps, setSteps] = useState(initialSteps);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateStep = (idx: number, field: string, value: string) => {
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  };

  const removeStep = (idx: number) => {
    const removedId = steps[idx]?.id;
    setSteps(prev => prev.filter((_, i) => i !== idx).map(s => ({
      ...s,
      depends_on: s.depends_on.filter(d => d !== removedId),
    })));
  };

  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const yaml = generateWorkflowYaml(name.trim(), description, steps);
      await api.workflows.create(teamId, name.trim(), yaml);
      setSaved(true);
      setTimeout(() => onSaved(), 800);
    } catch (err) {
      setError(String(err));
    }
    setSaving(false);
  };

  const uniqueRoles = useMemo(() => [...new Set(steps.map(s => s.role))], [steps]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface-primary border border-border-default rounded-2xl shadow-2xl w-[640px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-default">
          <div>
            <h2 className="text-base font-semibold text-fg-primary">{t('work:task.saveAsWorkflow', 'Save as Workflow')}</h2>
            <p className="text-xs text-fg-tertiary mt-0.5">{t('work:task.saveAsWorkflowDesc', 'Turn this task structure into a reusable workflow template')}</p>
          </div>
          <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary p-1 rounded-lg hover:bg-surface-elevated transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          {/* Name & Description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1 block">{t('work:task.workflowName', 'Name')}</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full text-sm bg-surface-secondary border border-border-default/50 rounded-lg px-3 py-2 text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="content-publishing"
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1 block">{t('work:task.roles', 'Roles')}</label>
              <div className="flex flex-wrap gap-1 py-2">
                {uniqueRoles.map(r => (
                  <span key={r} className="px-2 py-0.5 text-[10px] font-medium bg-brand-500/10 text-brand-500 rounded-full">{r}</span>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1 block">{t('work:task.description', 'Description')}</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full text-sm bg-surface-secondary border border-border-default/50 rounded-lg px-3 py-2 text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {/* Steps visual list */}
          <div>
            <label className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2 block">
              {t('work:task.workflowSteps', 'Steps')} ({steps.length})
            </label>
            <div className="space-y-2">
              {steps.map((step, idx) => (
                <div key={step.id} className="bg-surface-secondary border border-border-default/40 rounded-xl p-3 group">
                  <div className="flex items-start gap-3">
                    {/* Step number */}
                    <div className="shrink-0 w-7 h-7 rounded-full bg-brand-500/15 flex items-center justify-center text-[11px] font-bold text-brand-500 mt-0.5">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      {/* Step name + role */}
                      <div className="flex items-center gap-2">
                        <input
                          value={step.name}
                          onChange={e => updateStep(idx, 'name', e.target.value)}
                          className="flex-1 text-sm font-medium bg-transparent border-b border-transparent hover:border-border-default focus:border-brand-500 text-fg-primary focus:outline-none px-0 py-0.5 transition-colors"
                        />
                        <input
                          value={step.role}
                          onChange={e => updateStep(idx, 'role', e.target.value)}
                          className="w-28 text-[10px] bg-surface-elevated border border-border-default/40 rounded-md px-2 py-1 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-brand-500"
                          title={t('work:task.role', 'Role')}
                        />
                      </div>
                      {/* Dependencies */}
                      {step.depends_on.length > 0 && (
                        <div className="flex items-center gap-1.5 text-[10px] text-fg-tertiary">
                          <span>{t('work:task.dependsOn', 'Depends on')}:</span>
                          {step.depends_on.map(depId => {
                            const depStep = steps.find(s => s.id === depId);
                            return <span key={depId} className="px-1.5 py-0.5 bg-surface-elevated rounded text-fg-secondary">{depStep?.name ?? depId}</span>;
                          })}
                        </div>
                      )}
                      {/* Prompt preview */}
                      <div className="text-xs text-fg-tertiary line-clamp-2 leading-relaxed">{step.prompt}</div>
                    </div>
                    {/* Remove button */}
                    <button
                      onClick={() => removeStep(idx)}
                      className="shrink-0 opacity-0 group-hover:opacity-100 text-fg-quaternary hover:text-red-500 p-1 rounded transition-all"
                      title={t('work:task.removeStep', 'Remove step')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
          {saved && <p className="text-xs text-green-500 font-medium">{t('work:task.workflowSavedSuccess', 'Workflow saved successfully')}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border-default">
          <button onClick={onClose} className="px-4 py-2 text-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-elevated rounded-lg transition-colors">
            {t('work:task.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || saved || !name.trim() || steps.length === 0}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg font-medium transition-colors"
          >
            {saving ? t('work:task.saving', 'Saving...') : saved ? t('work:task.workflowSavedSuccess', 'Saved!') : t('work:task.saveWorkflow', 'Save Workflow')}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkflowHowItWorks({ teamId, agents, compact }: { teamId: string | null; agents: AgentInfo[]; compact?: boolean }) {
  const { t } = useTranslation(['work']);

  const manager = useMemo(
    () => teamId ? agents.find(a => a.teamId === teamId && a.agentRole === 'manager') : agents.find(a => a.agentRole === 'manager'),
    [agents, teamId],
  );

  const handleAskManager = () => {
    if (!manager) return;
    navBus.navigate(PAGE.TEAM, {
      agentId: manager.id,
      prefillMessage: t('work:task.workflowCreatePrompt',
        'Please create a workflow template for our team. Review the team composition, then design a multi-step process that matches our regular work. Use the workflow_create tool to save it. If the user specifies a project, bind the workflow to that project by including a project_id parameter. Otherwise, leave project as an optional runtime parameter so users can choose when starting a run.'),
    });
  };

  return (
    <div className={compact ? 'max-w-4xl space-y-3' : 'max-w-lg w-full text-center space-y-5'}>
      {!compact && (
        <>
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-500/10">
            <svg className="w-8 h-8 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
            </svg>
          </div>

          <div>
            <h3 className="text-base font-semibold text-fg-primary mb-1.5">
              {t('work:task.workflowEmptyTitle', 'No workflow templates yet')}
            </h3>
            <p className="text-sm text-fg-secondary leading-relaxed">
              {t('work:task.workflowEmptyDesc',
                'Workflows automate repeatable multi-step processes. Define a sequence of tasks as a DAG — the system handles dependencies, role assignment, and scheduling automatically.')}
            </p>
          </div>
        </>
      )}

      <details className={compact ? 'group' : ''} open={!compact}>
        <summary className={`text-xs font-medium text-fg-secondary uppercase tracking-wider cursor-pointer select-none list-none flex items-center gap-1.5 ${compact ? 'py-1' : 'sr-only'}`}>
          <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          {t('work:task.workflowHowItWorks', 'How it works')}
        </summary>
        <div className={`bg-surface-secondary border border-border-default/40 rounded-xl p-4 text-left space-y-3 ${compact ? 'mt-2' : ''}`}>
          {!compact && (
            <p className="text-xs font-medium text-fg-secondary uppercase tracking-wider">
              {t('work:task.workflowHowItWorks', 'How it works')}
            </p>
          )}
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full bg-brand-500/15 flex items-center justify-center text-[11px] font-bold text-brand-500">1</div>
            <div className="text-xs text-fg-secondary leading-relaxed">
              <span className="font-medium text-fg-primary">{t('work:task.workflowStep1Title', 'Requirement')}</span>
              {' — '}
              {t('work:task.workflowStep1Desc', 'A workflow run creates a Requirement to group all its tasks under one trackable goal.')}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full bg-brand-500/15 flex items-center justify-center text-[11px] font-bold text-brand-500">2</div>
            <div className="text-xs text-fg-secondary leading-relaxed">
              <span className="font-medium text-fg-primary">{t('work:task.workflowStep2Title', 'Task DAG')}</span>
              {' — '}
              {t('work:task.workflowStep2Desc', 'Each step becomes a Task assigned to the right team member. Dependencies are tracked — downstream tasks wait for upstream ones to finish.')}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full bg-brand-500/15 flex items-center justify-center text-[11px] font-bold text-brand-500">3</div>
            <div className="text-xs text-fg-secondary leading-relaxed">
              <span className="font-medium text-fg-primary">{t('work:task.workflowStep3Title', 'Auto-execution')}</span>
              {' — '}
              {t('work:task.workflowStep3Desc', 'Agents pick up tasks, pass deliverables downstream, and the workflow completes automatically. Optionally, schedule it to run on a recurring basis.')}
            </div>
          </div>
        </div>
      </details>

      {manager && (
        <div className={compact ? '' : 'text-center'}>
          <button
            onClick={handleAskManager}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded-lg font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {t('work:task.workflowAskManager', 'Ask {{name}} to create a workflow', { name: manager.name })}
          </button>
        </div>
      )}
    </div>
  );
}

function WorkflowsPanel({ teamId: propTeamId, projectId: propProjectId, agents, projects, onViewRunTasks }: { teamId: string | null; projectId: string | null; agents: AgentInfo[]; projects: ProjectInfo[]; onViewRunTasks?: (requirementId: string) => void }) {
  const { t } = useTranslation(['work']);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [runs, setRuns] = useState<Record<string, WorkflowRunInfo[]>>({});
  const [loading, setLoading] = useState(false);
  const [runModal, setRunModal] = useState<WorkflowInfo | null>(null);
  const [runParams, setRunParams] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [expandedWorkflow, setExpandedWorkflow] = useState<string | null>(null);
  const [templateDetails, setTemplateDetails] = useState<Record<string, WorkflowTemplateInfo>>({});
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [confirmCancelRunId, setConfirmCancelRunId] = useState<string | null>(null);
  const [pausingRunId, setPausingRunId] = useState<string | null>(null);
  const [roleCandidates, setRoleCandidates] = useState<Array<{ role: string; candidates: Array<{ agentId: string; agentName: string }>; recommended?: string }>>([]);
  const [roleOverrides, setRoleOverrides] = useState<Record<string, string>>({});
  const [runProjectId, setRunProjectId] = useState<string | null>(null);
  const [workflowTeamMap, setWorkflowTeamMap] = useState<Record<string, string>>({});
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

  const teamId = propTeamId ?? selectedTeamId;

  useEffect(() => {
    if (propTeamId) return;
    api.teams.list().then(({ teams: t }) => {
      setTeams(t.map(tm => ({ id: tm.id, name: tm.name })));
    }).catch(() => {});
  }, [propTeamId]);

  const agentMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of agents) m[a.id] = a.name;
    return m;
  }, [agents]);

  const refresh = useCallback(async () => {
    const targetTeams = teamId ? [teamId] : teams.map(t => t.id);
    if (targetTeams.length === 0) return;
    setLoading(true);
    try {
      const allWf: WorkflowInfo[] = [];
      const runsMap: Record<string, WorkflowRunInfo[]> = {};
      const teamMap: Record<string, string> = {};
      await Promise.all(targetTeams.map(async tid => {
        try {
          const { workflows: wf } = await api.workflows.list(tid);
          for (const w of wf) teamMap[w.name] = tid;
          allWf.push(...wf);
          await Promise.all(wf.map(async w => {
            try {
              const { runs: r } = await api.workflows.listRuns(tid, w.name, 5);
              runsMap[w.name] = r;
            } catch { /* ignore */ }
          }));
        } catch { /* ignore */ }
      }));
      setWorkflows(allWf);
      setRuns(runsMap);
      setWorkflowTeamMap(teamMap);
    } catch { /* ignore */ }
    setLoading(false);
  }, [teamId, teams]);

  useEffect(() => { refresh(); }, [refresh]);

  const resolveTeam = (wfName: string) => teamId ?? workflowTeamMap[wfName];

  const toggleExpand = async (wf: WorkflowInfo) => {
    if (expandedWorkflow === wf.name) {
      setExpandedWorkflow(null);
      return;
    }
    setExpandedWorkflow(wf.name);
    const tid = resolveTeam(wf.name);
    if (!templateDetails[wf.name] && tid) {
      try {
        const { template } = await api.workflows.get(tid, wf.name);
        setTemplateDetails(prev => ({ ...prev, [wf.name]: template }));
      } catch { /* ignore */ }
    }
  };

  const openRunModal = (wf: WorkflowInfo) => {
    const defaults: Record<string, string> = {};
    for (const p of wf.params ?? []) {
      if (p.default) defaults[p.name] = p.default;
    }
    setRunParams(defaults);
    setError(null);
    setRoleCandidates([]);
    setRoleOverrides({});
    const lastProject = localStorage.getItem(`markus_wf_project_${wf.name}`) ?? localStorage.getItem('markus_wf_project_last');
    const validLast = lastProject && projects.some(p => p.id === lastProject) ? lastProject : null;
    setRunProjectId(propProjectId ?? validLast ?? projects[0]?.id ?? null);
    setRunModal(wf);

    const tid = resolveTeam(wf.name);
    if (tid) {
      api.workflows.roles(tid, wf.name)
        .then(({ roles }) => setRoleCandidates(roles))
        .catch(() => {});
    }
  };

  const startRun = async () => {
    const effectiveProjectId = runProjectId ?? projects[0]?.id;
    const effectiveTeamId = runModal ? resolveTeam(runModal.name) : undefined;
    if (!runModal || !effectiveTeamId || !effectiveProjectId) {
      setError(!effectiveProjectId
        ? t('work:task.workflowNoProject', 'Please select a project')
        : t('work:task.workflowNoTeam', 'Cannot determine team for this workflow'));
      return;
    }
    setStarting(true);
    setError(null);
    try {
      let mapping: Record<string, string> | undefined;
      if (roleCandidates.length > 0) {
        mapping = {};
        for (const rc of roleCandidates) {
          mapping[rc.role] = roleOverrides[rc.role] ?? rc.recommended ?? '';
        }
      }
      await api.workflows.startRun(effectiveTeamId, runModal.name, effectiveProjectId, runParams, mapping);
      localStorage.setItem(`markus_wf_project_${runModal.name}`, effectiveProjectId);
      localStorage.setItem('markus_wf_project_last', effectiveProjectId);
      setRunModal(null);
      refresh();
    } catch (err) {
      setError(String(err));
    }
    setStarting(false);
  };

  if (!teamId && teams.length === 0 && !propTeamId) {
    return (
      <div className="flex-1 flex items-center justify-center text-fg-tertiary text-sm">
        {t('work:task.selectProjectForWorkflows', 'Select a project with a team to view workflows')}
      </div>
    );
  }

  if (loading && workflows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-fg-tertiary text-sm">{t('work:task.workflowLoading', 'Loading...')}</div>;
  }

  const cancelRun = async (runId: string) => {
    setCancellingRunId(runId);
    setConfirmCancelRunId(null);
    try {
      await api.workflows.cancelRun(runId);
      refresh();
    } catch { /* ignore */ }
    setCancellingRunId(null);
  };

  const togglePauseRun = async (run: WorkflowRunInfo) => {
    setPausingRunId(run.id);
    try {
      if (run.status === 'running') {
        await api.workflows.pauseRun(run.id);
      } else if ((run.status as string) === 'paused') {
        await api.workflows.resumeRun(run.id);
      }
      refresh();
    } catch { /* ignore */ }
    setPausingRunId(null);
  };

  const viewRunTasks = (run: WorkflowRunInfo) => {
    if (run.requirementId && onViewRunTasks) {
      onViewRunTasks(run.requirementId);
    }
  };

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = { running: 'bg-blue-500/20 text-blue-400', paused: 'bg-amber-500/20 text-amber-400', completed: 'bg-green-500/20 text-green-400', failed: 'bg-red-500/20 text-red-400', cancelled: 'bg-gray-500/20 text-gray-400' };
    return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[s] ?? 'bg-gray-500/20 text-gray-400'}`}>{s}</span>;
  };

  const hasRequiredMissing = runModal && (runModal.params ?? []).some(p => p.required && !runParams[p.name]?.trim());

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 py-5">
      {!propTeamId && teams.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <button
            onClick={() => { if (selectedTeamId !== null) { setSelectedTeamId(null); setWorkflows([]); setRuns({}); } }}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${selectedTeamId === null ? 'bg-brand-600 text-white' : 'bg-surface-secondary border border-border-default/50 text-fg-secondary hover:text-fg-primary hover:border-border-default'}`}
          >
            {t('work:task.all', 'All')}
          </button>
          {teams.map(tm => (
            <button
              key={tm.id}
              onClick={() => { if (selectedTeamId !== tm.id) { setSelectedTeamId(tm.id); setWorkflows([]); setRuns({}); } }}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${selectedTeamId === tm.id ? 'bg-brand-600 text-white' : 'bg-surface-secondary border border-border-default/50 text-fg-secondary hover:text-fg-primary hover:border-border-default'}`}
            >
              {tm.name}
            </button>
          ))}
        </div>
      )}
      {workflows.length === 0 && !loading ? (
        <div className="flex-1 flex items-center justify-center px-4">
          <WorkflowHowItWorks teamId={teamId} agents={agents} />
        </div>
      ) : (
        <div className="grid gap-4 max-w-4xl">
          {workflows.map(wf => {
            const isExpanded = expandedWorkflow === wf.name;
            const detail = templateDetails[wf.name];
            const wfRuns = runs[wf.name] ?? [];
            const hasRunning = wfRuns.some(r => r.status === 'running' || (r.status as string) === 'paused');
            return (
            <div key={wf.name} className="bg-surface-secondary border border-border-default/50 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-2 cursor-pointer" onClick={() => toggleExpand(wf)}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <svg className={`w-3.5 h-3.5 text-fg-tertiary shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    <h3 className="text-sm font-semibold text-fg-primary">{wf.displayName || wf.name}</h3>
                    <span className="text-[11px] text-fg-tertiary">{t('work:task.workflowStepsCount', '{{count}} steps', { count: wf.stepCount })}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className="text-[10px] text-fg-quaternary font-mono cursor-pointer hover:text-fg-tertiary transition-colors"
                    title={t('work:task.workflowSendToAgent', 'Send to agent chat')}
                    onClick={(e) => {
                      e.stopPropagation();
                      const wfTeamId = resolveTeam(wf.name);
                      const teamManager = wfTeamId ? agents.find(a => a.teamId === wfTeamId && a.agentRole === 'manager') : undefined;
                      const targetAgentId = teamManager?.id ?? agents.find(a => a.agentRole === 'manager')?.id ?? agents[0]?.id;
                      if (targetAgentId) {
                        navBus.navigate(PAGE.TEAM, { agentId: targetAgentId, prefillMessage: `@[${wf.displayName || wf.name}](workflow:${wf.name}) ` });
                      }
                    }}
                  >
                    <svg className="w-3.5 h-3.5 inline mr-0.5 -mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                    {wf.name}
                  </span>
                  {wf.hasSchedule && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400">{t('work:task.workflowScheduled', 'Scheduled')}</span>}
                  <span className="text-[10px] text-fg-tertiary">v{wf.version}</span>
                  {hasRunning ? (
                    <span className="px-3 py-1 bg-blue-500/20 text-blue-400 text-xs rounded-lg font-medium inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                      {t('work:task.workflowRunning', 'Running')}
                    </span>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); openRunModal(wf); }} className="px-3 py-1 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg font-medium transition-colors">
                      {t('work:task.workflowRun', 'Run')}
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded detail view */}
              {isExpanded && detail && (
                <div className="border-t border-border-default/30 pt-3 mt-1 ml-5 space-y-3">
                  {wf.description && <p className="text-xs text-fg-tertiary">{wf.description}</p>}
                  <div>
                    <p className="text-[10px] text-fg-tertiary font-medium mb-2 uppercase tracking-wider">{t('work:task.workflowSteps', 'Steps')}</p>
                    <div className="space-y-1.5">
                      {detail.steps.map((step, idx) => (
                        <div key={step.id} className="flex items-start gap-2">
                          <div className="shrink-0 w-5 h-5 rounded-full bg-brand-500/15 flex items-center justify-center text-[9px] font-bold text-brand-500 mt-0.5">
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-fg-primary">{step.name}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-elevated text-fg-tertiary">{step.role}</span>
                              {step.depends_on && step.depends_on.length > 0 && (
                                <span className="text-[10px] text-fg-quaternary">
                                  ← {step.depends_on.join(', ')}
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-fg-tertiary line-clamp-1 mt-0.5">{step.prompt}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Step dependency mini-graph */}
                  {detail.steps.some(s => s.depends_on && s.depends_on.length > 0) && (
                    <div>
                      <p className="text-[10px] text-fg-tertiary font-medium mb-1.5 uppercase tracking-wider">DAG</p>
                      <div className="flex items-center gap-1 flex-wrap text-[10px]">
                        {detail.steps.map((step, idx) => {
                          const hasDeps = step.depends_on && step.depends_on.length > 0;
                          return (
                            <span key={step.id} className="inline-flex items-center gap-0.5">
                              {hasDeps && <span className="text-fg-quaternary">→</span>}
                              <span className="px-1.5 py-0.5 rounded bg-surface-elevated text-fg-secondary font-medium">{step.name}</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Params */}
                  {detail.params && detail.params.length > 0 && (
                    <div>
                      <p className="text-[10px] text-fg-tertiary font-medium mb-1.5 uppercase tracking-wider">{t('work:task.workflowParamsCount', 'Parameters', { count: detail.params.length })}</p>
                      <div className="flex flex-wrap gap-2">
                        {detail.params.map(p => (
                          <span key={p.name} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-surface-elevated border border-border-default/30">
                            <span className="font-medium text-fg-secondary">{p.label || p.name}</span>
                            <span className="text-fg-quaternary">({p.type || 'string'})</span>
                            {p.required && <span className="text-red-400">*</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Schedule */}
                  {detail.schedule && (
                    <div>
                      <p className="text-[10px] text-fg-tertiary font-medium mb-1 uppercase tracking-wider">{t('work:task.workflowScheduled', 'Schedule')}</p>
                      <p className="text-xs text-fg-secondary">
                        {detail.schedule.cron && `cron: ${detail.schedule.cron}`}
                        {detail.schedule.interval && `every: ${detail.schedule.interval}`}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {(() => {
                const allRuns = runs[wf.name] ?? [];
                if (allRuns.length === 0) return null;
                const runsOpen = expandedRuns.has(wf.name);
                const visibleRuns = runsOpen ? allRuns : allRuns.slice(0, 1);
                return (
                <div className="border-t border-border-default/30 pt-2 mt-1">
                  <div
                    className="flex items-center gap-1.5 mb-1.5 cursor-pointer select-none"
                    onClick={() => setExpandedRuns(prev => {
                      const next = new Set(prev);
                      next.has(wf.name) ? next.delete(wf.name) : next.add(wf.name);
                      return next;
                    })}
                  >
                    <svg className={`w-3 h-3 text-fg-quaternary transition-transform ${runsOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    <p className="text-[10px] text-fg-tertiary font-medium uppercase tracking-wider">{t('work:task.workflowRecentRuns', 'Recent Runs')}</p>
                    {allRuns.length > 1 && <span className="text-[10px] text-fg-quaternary">({allRuns.length})</span>}
                  </div>
                  <div className="space-y-1">
                    {visibleRuns.map(run => (
                      <div key={run.id} className="flex flex-wrap items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-surface-elevated/50">
                        <span className="text-fg-secondary font-medium">#{run.runNumber}</span>
                        {statusBadge(run.status)}
                        <span className="text-fg-tertiary">{run.taskIds.length} tasks</span>
                        <span className="text-fg-tertiary">{new Date(run.startedAt).toLocaleDateString()}</span>
                        {run.triggeredBy === 'schedule' && <span className="text-[10px] text-purple-400">auto</span>}
                        <span className="flex-1" />
                        {(run.status === 'running' || (run.status as string) === 'paused') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); togglePauseRun(run); }}
                            disabled={pausingRunId === run.id}
                            className={`px-2.5 py-0.5 text-[10px] rounded-lg font-medium transition-colors ${run.status === 'running' ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30' : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'}`}
                          >
                            {pausingRunId === run.id
                              ? '...'
                              : run.status === 'running'
                                ? t('work:task.workflowPause', 'Pause')
                                : t('work:task.workflowResume', 'Resume')}
                          </button>
                        )}
                        {(run.status === 'running' || (run.status as string) === 'paused') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmCancelRunId(run.id); }}
                            className="px-2.5 py-0.5 text-[10px] rounded-lg font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                          >
                            {t('work:task.workflowCancelRun', 'Cancel Run')}
                          </button>
                        )}
                        <button
                          onClick={() => viewRunTasks(run)}
                          className="px-2.5 py-0.5 text-[10px] rounded-lg font-medium bg-brand-500/20 text-brand-400 hover:bg-brand-500/30 transition-colors"
                        >
                          {t('work:task.workflowViewTasks', 'View Tasks')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
                );
              })()}
            </div>
          );
          })}
          <WorkflowHowItWorks teamId={teamId} agents={agents} compact />
        </div>
      )}

      {/* Run modal */}
      {runModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setRunModal(null)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-fg-primary mb-1">{t('work:task.workflowRunTitle', 'Run: {{name}}', { name: runModal.displayName || runModal.name })}</h3>
            <p className="text-xs text-fg-tertiary mb-4">{runModal.description}</p>
            {(runModal.params ?? []).length > 0 && (
              <div className="space-y-3 mb-4">
                {(runModal.params ?? []).map(p => (
                  <div key={p.name}>
                    <label className="block text-xs text-fg-secondary mb-1">
                      {p.label || p.name}
                      {p.required && <span className="text-red-400 ml-1">*</span>}
                    </label>
                    {p.type === 'enum' && p.options ? (
                      <select
                        value={runParams[p.name] ?? ''}
                        onChange={e => setRunParams(prev => ({ ...prev, [p.name]: e.target.value }))}
                        className="input-field text-xs w-full"
                      >
                        <option value="">—</option>
                        {p.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <textarea
                        value={runParams[p.name] ?? ''}
                        onChange={e => {
                          setRunParams(prev => ({ ...prev, [p.name]: e.target.value }));
                          const el = e.target;
                          el.style.height = 'auto';
                          const lineH = parseFloat(getComputedStyle(el).lineHeight) || 18;
                          el.style.height = Math.min(el.scrollHeight, lineH * 7) + 'px';
                        }}
                        placeholder={p.default ?? ''}
                        rows={1}
                        className="input-field text-xs w-full resize-none overflow-y-auto"
                        style={{ maxHeight: `${7 * 1.5}em` }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {roleCandidates.length > 0 && (
              <div className="mb-4">
                <p className="text-[10px] text-fg-tertiary font-medium mb-2 uppercase tracking-wider">{t('work:task.roles', 'Roles')}</p>
                <div className="space-y-2">
                  {roleCandidates.map(rc => (
                    <div key={rc.role} className="flex items-center gap-2">
                      <span className="text-xs text-fg-secondary w-24 shrink-0 font-medium">{rc.role}</span>
                      <select
                        value={roleOverrides[rc.role] ?? rc.recommended ?? ''}
                        onChange={e => setRoleOverrides(prev => ({ ...prev, [rc.role]: e.target.value }))}
                        className="input-field text-xs flex-1"
                      >
                        {rc.candidates.map(c => (
                          <option key={c.agentId} value={c.agentId}>
                            {c.agentName}{c.agentId === rc.recommended ? ' ★' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-4">
              <label className="block text-xs text-fg-secondary mb-1">
                {t('work:task.workflowProject', 'Project')}
              </label>
              <select
                value={runProjectId ?? ''}
                onChange={e => { const v = e.target.value || null; setRunProjectId(v); setError(null); if (v) localStorage.setItem('markus_wf_project_last', v); }}
                className="input-field text-xs w-full"
              >
                <option value="">{t('work:task.workflowSelectProject', '— Select a project —')}</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setRunModal(null)} className="btn-secondary text-xs px-4 py-1.5">{t('work:task.workflowCancel', 'Cancel')}</button>
              <button onClick={startRun} disabled={starting || !!hasRequiredMissing} className="btn-primary text-xs px-4 py-1.5">
                {starting ? t('work:task.workflowStarting', 'Starting...') : t('work:task.workflowStartRun', 'Start Run')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirmation modal */}
      {confirmCancelRunId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setConfirmCancelRunId(null)}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-fg-primary mb-2">{t('work:task.workflowConfirmCancelTitle', 'Cancel Workflow Run')}</h3>
            <p className="text-xs text-fg-secondary mb-5">{t('work:task.workflowConfirmCancelDesc', 'This will cancel all running and pending tasks in this workflow run. This action cannot be undone.')}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmCancelRunId(null)} className="btn-secondary text-xs px-4 py-1.5">{t('work:task.workflowNo', 'No')}</button>
              <button onClick={() => cancelRun(confirmCancelRunId)} disabled={cancellingRunId === confirmCancelRunId} className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-lg font-medium transition-colors">
                {cancellingRunId === confirmCancelRunId ? t('work:task.workflowCancelling', 'Cancelling...') : t('work:task.workflowConfirmCancelBtn', 'Confirm Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkPage({ authUser, previewMode, previewData }: { authUser?: AuthUser; previewMode?: boolean; previewData?: WorkPreviewData } = {}) {
  const { t } = useTranslation(['work', 'common']);
  const isActive = usePageActive(PAGE.WORK);
  const boardColumns = useMemo(() => BOARD_COLUMNS_BASE.map(c => ({ ...c, label: t(`work:boardColumn.${c.id}`) })), [t]);
  const subStatusBadges = useMemo(() => buildSubStatusBadges(t), [t]);
  const reqStatusBadges = useMemo(() => buildReqStatusBadges(t), [t]);
  const isMobile = useIsMobile();
  const workContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = workContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const availableWidth = containerWidth || window.innerWidth;
  const containerMeasured = useRef(false);
  const detailPanel = useResizablePanel({ side: 'right', defaultWidth: Math.round(availableWidth / 2), minWidth: 380, maxWidth: Math.round(availableWidth * 0.8), storageKey: 'markus_projects_detail_v4' });
  useEffect(() => {
    if (containerWidth > 0 && !containerMeasured.current) {
      containerMeasured.current = true;
      detailPanel.setWidth(Math.round(containerWidth / 2));
    }
  }, [containerWidth]); // eslint-disable-line react-hooks/exhaustive-deps
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const mobileShowDetailRef = useRef(mobileShowDetail);
  mobileShowDetailRef.current = mobileShowDetail;
  // ── State ──
  const [projects, setProjects] = useState<ProjectInfo[]>(previewData?.projects ?? []);
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [board, setBoard] = useState<Record<string, TaskInfo[]>>(previewData?.board ?? {});
  const [agents, setAgents] = useState<AgentInfo[]>(previewData?.agents ?? []);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [users, setUsers] = useState<HumanUserInfo[]>(previewData?.users ?? []);
  const [allRequirements, setAllRequirements] = useState<RequirementInfo[]>(previewData?.allRequirements ?? []);
  const [loading, setLoading] = useState(previewData ? false : true);
  const [flash, setFlash] = useState('');
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const openCreateReq = useCallback(() => {
    setReqProjectId(selectedProjectId ?? '');
    setShowCreateReq(true);
  }, [selectedProjectId]);

  // Create modals
  const [showCreateProject, setShowCreateProject] = useState(false);

  const [showCreateTask, setShowCreateTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskPriority, setTaskPriority] = useState('medium');
  const [taskAssignTo, setTaskAssignTo] = useState('');
  const [taskReviewer, setTaskReviewer] = useState('');
  const [taskProjectId, setTaskProjectId] = useState<string>('');
  const [taskRequirementId, setTaskRequirementId] = useState<string>('');
  const [taskBlockedBy, setTaskBlockedBy] = useState<string[]>([]);
  const [taskType, setTaskType] = useState<'standard' | 'scheduled'>('standard');
  const [taskScheduleEvery, setTaskScheduleEvery] = useState('4h');
  const [taskCreateError, setTaskCreateError] = useState('');

  const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null);
  const [selectedReq, setSelectedReq] = useState<RequirementInfo | null>(() => {
    if (previewData?.initialSelectedReqId && previewData.allRequirements) {
      return previewData.allRequirements.find(r => r.id === previewData.initialSelectedReqId) ?? null;
    }
    return null;
  });
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [myTasksOnly, setMyTasksOnly] = useState(false);
  const [projectFilter, setProjectFilter] = useState<Set<string>>(new Set());
  const savedProjectFilterRef = useRef<Set<string>>(new Set());
  const projectFilterRef = useRef<Set<string>>(new Set());
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [boardType, setBoardType] = useState<'backlog' | 'kanban' | 'dag' | 'workflows'>(previewData?.initialBoardType ?? 'backlog');
  const [dagExpandReqId, setDagExpandReqId] = useState<string | null>(null);
  const boardTabs = useMemo(() => [{ id: 'backlog' as const }, { id: 'kanban' as const }, { id: 'dag' as const }, { id: 'workflows' as const }], []);
  const boardSwipe = useSwipeTabs(boardTabs, boardType, setBoardType);
  const kanbanScrollRef = useRef<HTMLDivElement>(null);
  const kanbanSwipeOpts = useMemo(() => ({ scrollContainerRef: kanbanScrollRef }), []);
  const kanbanSwipe = useSwipeTabs(boardTabs, boardType, setBoardType, kanbanSwipeOpts);
  const [showClosed, setShowClosed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const dragTaskRef = useRef<TaskInfo | null>(null);
  const dragReqRef = useRef<RequirementInfo | null>(null);

  // Requirement create/reject modals
  const [showCreateReq, setShowCreateReq] = useState(false);
  const [reqTitle, setReqTitle] = useState('');
  const [reqDesc, setReqDesc] = useState('');
  const [reqPriority, setReqPriority] = useState('medium');
  const [reqProjectId, setReqProjectId] = useState('');
  const [rejectReqId, setRejectReqId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [reqCreateError, setReqCreateError] = useState('');
  const [rejectReqError, setRejectReqError] = useState('');
  const [pendingDeleteProjectId, setPendingDeleteProjectId] = useState<string | null>(null);

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000); };

  const selectedProject = projects.find(p => p.id === selectedProjectId) ?? null;
  const selectedProjectTeamId = selectedProject?.teamIds?.[0] ?? null;
  const settingsProject = selectedProject ?? projects.find(p => p.id === settingsProjectId) ?? null;

  const closeProjectSettings = useCallback(() => {
    setShowProjectSettings(false);
    setSettingsProjectId(null);
  }, []);

  const openProjectSettings = useCallback((projectId: string) => {
    if (showProjectSettings && (selectedProjectId === projectId || settingsProjectId === projectId)) {
      closeProjectSettings();
      return;
    }
    if (!selectedProjectId) setSettingsProjectId(projectId);
    setShowProjectSettings(true);
  }, [showProjectSettings, selectedProjectId, settingsProjectId, closeProjectSettings]);

  useEffect(() => { projectFilterRef.current = projectFilter; }, [projectFilter]);

  // ── Data fetching ──

  const refreshProjects = useCallback(async () => {
    try { const { projects: p } = await api.projects.list(); setProjects(p); } catch { /* */ }
  }, []);

  const refreshBoard = useCallback(async () => {
    const filters: { projectId?: string } = {};
    if (viewMode === 'project' && selectedProjectId) {
      filters.projectId = selectedProjectId;
    }
    try {
      const { board: b } = await api.tasks.board(filters);
      setBoard(b);
    } catch { /* */ }
  }, [viewMode, selectedProjectId]);

  const refreshAgents = useCallback(async () => {
    try { const { agents: a } = await api.agents.list(); setAgents(a); } catch { /* */ }
  }, []);

  const refreshTeams = useCallback(async () => {
    try { const { teams: t } = await api.teams.list(); setTeams(t.map(tm => ({ id: tm.id, name: tm.name }))); } catch { /* */ }
  }, []);

  const refreshUsers = useCallback(async () => {
    try { const { users: u } = await api.users.list(authUser?.orgId); setUsers(u); } catch { /* */ }
  }, [authUser?.orgId]);

  const refreshRequirements = useCallback(async () => {
    try { const { requirements: r } = await api.requirements.list({}); setAllRequirements(r); } catch { /* */ }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshProjects(), refreshBoard(), refreshAgents(), refreshUsers(), refreshRequirements(), refreshTeams()]);
    setLoading(false);
  }, [refreshProjects, refreshBoard, refreshAgents, refreshUsers, refreshRequirements, refreshTeams]);

  useEffect(() => { if (previewMode) return; refresh(); }, [previewMode, refresh]);

  useEffect(() => {
    if (!previewMode || !previewData) return;
    setProjects(previewData.projects ?? []);
    setBoard(previewData.board ?? {});
    setAgents(previewData.agents ?? []);
    setUsers(previewData.users ?? []);
    setAllRequirements(previewData.allRequirements ?? []);
  }, [previewMode, previewData]);

  const handleSelectTask = useCallback((task: TaskInfo) => {
    setSelectedTask(prev => {
      if (prev?.id === task.id) {
        if (isMobile && mobileShowDetailRef.current) setMobileShowDetail(false);
        return null;
      }
      if (isMobile) {
        setMobileShowDetail(true);
        history.pushState({ mobileDetail: PAGE.WORK }, '', window.location.hash);
      }
      return task;
    });
    setSelectedReq(null);
  }, [isMobile]);

  const handleSelectReq = useCallback((req: RequirementInfo) => {
    setSelectedReq(prev => {
      if (prev?.id === req.id) {
        if (isMobile && mobileShowDetailRef.current) setMobileShowDetail(false);
        return null;
      }
      if (isMobile) {
        setMobileShowDetail(true);
        history.pushState({ mobileDetail: PAGE.WORK }, '', window.location.hash);
      }
      return req;
    });
    setSelectedTask(null);
  }, [isMobile]);

  const handleCloseDetail = useCallback(() => {
    setSelectedTask(null);
    setSelectedReq(null);
    if (isMobile && mobileShowDetailRef.current) {
      setMobileShowDetail(false);
    }
  }, [isMobile]);

  const handleCloseTask = useCallback(() => {
    setSelectedTask(null);
    if (!selectedReqRef.current && isMobile && mobileShowDetailRef.current) {
      setMobileShowDetail(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    const handler = () => {
      if (mobileShowDetailRef.current) {
        setMobileShowDetail(false);
        setSelectedTask(null);
        setSelectedReq(null);
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [isMobile]);

  const selectedTaskRef = useRef(selectedTask);
  selectedTaskRef.current = selectedTask;
  const selectedReqRef = useRef(selectedReq);
  selectedReqRef.current = selectedReq;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (selectedTaskRef.current) { setSelectedTask(null); return; }
      if (selectedReqRef.current) { setSelectedReq(null); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (previewMode) return;
    if (!isActive) return;
    const pollMs = selectedTaskRef.current ? 120000 : 45000;
    const i = setInterval(() => { refreshBoard(); refreshAgents(); refreshRequirements(); }, pollMs);
    let boardDebounce: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefreshBoard = () => {
      if (boardDebounce) return;
      boardDebounce = setTimeout(() => { boardDebounce = null; refreshBoard(); }, 800);
    };
    let reqDebounce: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefreshReqs = () => {
      if (reqDebounce) return;
      reqDebounce = setTimeout(() => { reqDebounce = null; refreshRequirements(); }, 800);
    };
    const unsub = wsClient.on('task:update', (event) => {
      debouncedRefreshBoard();
      const p = event?.payload as Record<string, unknown> | undefined;
      if (p?.taskId) {
        setSelectedTask(prev => {
          if (!prev || prev.id !== p.taskId) return prev;
          const patch: Partial<TaskInfo> = {};
          if (typeof p.status === 'string') patch.status = p.status;
          if (Array.isArray(p.deliverables)) patch.deliverables = p.deliverables as TaskInfo['deliverables'];
          if (Array.isArray(p.notes)) patch.notes = p.notes as string[];
          if (p.result !== undefined) patch.result = p.result as TaskInfo['result'];
          return { ...prev, ...patch };
        });
      }
    });
    const unsubTaskCreate = wsClient.on('task:create', () => {
      debouncedRefreshBoard();
    });
    const reqEvents = [
      'requirement:created', 'requirement:approved', 'requirement:rejected',
      'requirement:updated', 'requirement:completed', 'requirement:cancelled',
      'requirement:resubmitted',
    ];
    const reqUnsubs = reqEvents.map(evt =>
      wsClient.on(evt, () => { debouncedRefreshReqs(); })
    );
    const onDataChanged = () => { invalidateApiCache('/taskboard'); refreshBoard(); refreshRequirements(); };
    window.addEventListener('markus:data-changed', onDataChanged);
    return () => { clearInterval(i); unsub(); unsubTaskCreate(); reqUnsubs.forEach(u => u()); window.removeEventListener('markus:data-changed', onDataChanged); if (boardDebounce) clearTimeout(boardDebounce); if (reqDebounce) clearTimeout(reqDebounce); };
  }, [previewMode, isActive, refreshBoard, refreshAgents, refreshRequirements]);

  // Refs for event handlers that need current state without re-registering
  const boardRef = useRef(board);
  boardRef.current = board;
  const allRequirementsRef = useRef(allRequirements);
  allRequirementsRef.current = allRequirements;

  // Ensure a navigated-to item's project is visible in the current filters
  const ensureProjectVisible = useCallback((projectId: string | undefined) => {
    if (!projectId) return;
    const pf = projectFilterRef.current;
    if (pf.size > 0 && !pf.has(projectId)) {
      setProjectFilter(prev => new Set([...prev, projectId]));
    }
  }, []);

  const [scrollToComments, setScrollToComments] = useState(false);

  const forceOpenTask = useCallback((task: TaskInfo, opts?: { scrollToComments?: boolean }) => {
    setSelectedTask(task);
    setSelectedReq(null);
    if (opts?.scrollToComments) setScrollToComments(true);
    if (isMobile) { setMobileShowDetail(true); }
  }, [isMobile]);
  const forceOpenReq = useCallback((req: RequirementInfo, opts?: { scrollToComments?: boolean }) => {
    setSelectedReq(req);
    setSelectedTask(null);
    if (opts?.scrollToComments) setScrollToComments(true);
    if (isMobile) { setMobileShowDetail(true); }
  }, [isMobile]);

  // Try to open a task from localStorage (set by other pages before mount).
  // Uses API fallback when the task isn't in the board yet.
  const pendingOpenTaskRef = useRef<string | null>(null);
  useEffect(() => {
    const navTaskId = pendingOpenTaskRef.current || localStorage.getItem('markus_nav_openTask');
    if (!navTaskId) return;
    const allTasks = Object.values(board).flat();
    const task = allTasks.find(t => t.id === navTaskId);
    if (task) {
      pendingOpenTaskRef.current = null;
      ensureProjectVisible(task.projectId);
      forceOpenTask(task);
      localStorage.removeItem('markus_nav_openTask');
    } else if (!pendingOpenTaskRef.current) {
      pendingOpenTaskRef.current = navTaskId;
      localStorage.removeItem('markus_nav_openTask');
      api.tasks.get(navTaskId).then(resp => {
        if (resp.task) {
          pendingOpenTaskRef.current = null;
          ensureProjectVisible(resp.task.projectId);
          forceOpenTask(resp.task);
        }
      }).catch(() => { pendingOpenTaskRef.current = null; });
    }
  }, [board, forceOpenTask, ensureProjectVisible]);

  const pendingOpenReqRef = useRef<string | null>(null);
  useEffect(() => {
    const navReqId = pendingOpenReqRef.current || localStorage.getItem('markus_nav_openRequirement');
    if (!navReqId) return;
    const req = allRequirements.find(r => r.id === navReqId);
    if (req) {
      pendingOpenReqRef.current = null;
      ensureProjectVisible(req.projectId);
      forceOpenReq(req);
      localStorage.removeItem('markus_nav_openRequirement');
    } else if (!pendingOpenReqRef.current) {
      pendingOpenReqRef.current = navReqId;
      localStorage.removeItem('markus_nav_openRequirement');
      api.requirements.get(navReqId).then(resp => {
        if (resp.requirement) {
          pendingOpenReqRef.current = null;
          ensureProjectVisible(resp.requirement.projectId);
          forceOpenReq(resp.requirement);
        }
      }).catch(() => { pendingOpenReqRef.current = null; });
    }
  }, [allRequirements, forceOpenReq, ensureProjectVisible]);

  // Initial project selection from hash / localStorage (runs once on mount)
  useEffect(() => {
    const hashParts = window.location.hash.slice(1).split('/');
    if (resolvePageId(hashParts[0]) === PAGE.WORK && hashParts[1]) {
      selectProject(hashParts[1]);
    } else {
      const navProjectId = localStorage.getItem('markus_nav_projectId');
      if (navProjectId) {
        localStorage.removeItem('markus_nav_projectId');
        selectProject(navProjectId);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hash change & custom navigation events
  const prevHashPageRef = useRef(resolvePageId(window.location.hash.slice(1).split('/')[0]));
  useEffect(() => {
    if (previewMode) return;
    const onHashChange = () => {
      const parts = window.location.hash.slice(1).split('/');
      const newPage = resolvePageId(parts[0]);
      const wasOnWork = prevHashPageRef.current === PAGE.WORK;
      prevHashPageRef.current = newPage;
      if (newPage !== PAGE.WORK) return;
      if (newPage === PAGE.WORK && parts[1]) {
        selectProject(parts[1]);
      } else if (wasOnWork) {
        selectAllTasks();
      }
    };

    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<{ page: string; params?: Record<string, string> }>).detail;
      if (resolvePageId(detail.page) === PAGE.WORK) {
        if (detail.params?.openTask) {
          const taskId = detail.params.openTask;
          const wantComments = detail.params.scrollToComments === 'true';
          localStorage.removeItem('markus_nav_openTask');
          let task = Object.values(boardRef.current).flat().find(t => t.id === taskId);
          if (!task) {
            try {
              const resp = await api.tasks.get(taskId);
              task = resp.task;
            } catch { /* ignore */ }
          }
          if (task) {
            ensureProjectVisible(task.projectId);
            forceOpenTask(task, { scrollToComments: wantComments });
          }
        }
        if (detail.params?.openRequirement) {
          const reqId = detail.params.openRequirement;
          const wantComments = detail.params.scrollToComments === 'true';
          let req = allRequirementsRef.current.find(r => r.id === reqId);
          if (!req) {
            try {
              const resp = await api.requirements.get(reqId);
              req = resp.requirement;
            } catch { /* ignore */ }
          }
          if (req) {
            ensureProjectVisible(req.projectId);
            forceOpenReq(req, { scrollToComments: wantComments });
          }
        }
        if (detail.params?.projectId) selectProject(detail.params.projectId);
        if (detail.params?.statusFilter) {
          const sf = detail.params.statusFilter;
          localStorage.removeItem('markus_nav_statusFilter');
          if (CLOSED_STATUSES_SET.has(sf)) setShowClosed(true);
          setStatusFilter(sf);
        }
      }
    };
    window.addEventListener('markus:navigate', handler);
    window.addEventListener('hashchange', onHashChange);
    return () => { window.removeEventListener('markus:navigate', handler); window.removeEventListener('hashchange', onHashChange); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode]);

  // ── Actions ──

  const selectProject = (projectId: string) => {
    if (projectFilterRef.current.size > 0) {
      savedProjectFilterRef.current = new Set(projectFilterRef.current);
    }
    setProjectFilter(new Set());
    setSelectedProjectId(projectId);
    setViewMode('project');
    setSettingsProjectId(null);
    setShowProjectSettings(false);
    history.replaceState(null, '', hashPath(PAGE.WORK, projectId));
  };

  const selectAllTasks = () => {
    setProjectFilter(savedProjectFilterRef.current);
    setSelectedProjectId(null);
    setViewMode('all');
    setSettingsProjectId(null);
    setShowProjectSettings(false);
    history.replaceState(null, '', hashPath(PAGE.WORK));
  };

  const handleProjectCreated = () => {
    setShowCreateProject(false);
    msg(t('work:task.projectCreated'));
    refreshProjects();
  };

  const handleDeleteProject = async (id: string) => {
    if (!confirm('Delete this project and unlink all its tasks?')) return;
    try {
      await api.projects.delete(id);
      if (selectedProjectId === id) selectAllTasks();
      msg('Project deleted');
      refreshProjects(); refreshBoard();
    } catch (e) { msg(`Error: ${e}`); }
  };


  const createTask = async () => {
    if (!taskTitle || !taskAssignTo || !taskReviewer) return;
    setTaskCreateError('');
    const reviewerIsHuman = taskReviewer.startsWith('human:');
    const reviewerId = taskReviewer.replace(/^(human|agent):/, '');
    if (taskAssignTo === reviewerId && !reviewerIsHuman) { msg(t('work:task.assignedReviewerDifferent')); return; }
    const projId = taskProjectId || undefined;
    const reqId = taskRequirementId || undefined;
    try {
      const { task } = await api.tasks.create(
        taskTitle, taskDesc,
        taskAssignTo,
        reviewerId,
        taskPriority,
        projId,
        taskBlockedBy.length > 0 ? taskBlockedBy : undefined,
        reqId,
        taskType !== 'standard' ? taskType : undefined,
        taskType === 'scheduled' ? { every: taskScheduleEvery } : undefined,
        reviewerIsHuman ? 'human' : 'agent',
      );
      setTaskTitle(''); setTaskDesc(''); setTaskBlockedBy([]); setTaskRequirementId(''); setTaskType('standard'); setTaskScheduleEvery('4h'); setShowCreateTask(false);
      refreshBoard();
      if (task) forceOpenTask(task);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const key = `work:task.errorCode_${code || 'unknown'}`;
      const localized = t(key, { defaultValue: '' });
      setTaskCreateError(localized || t('work:task.errorCreatingTask', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const markNotifRead = (ref: { taskId?: string; requirementId?: string }) => {
    window.dispatchEvent(new CustomEvent('markus:mark-read-by-ref', { detail: ref }));
  };

  const handleTaskRefresh = () => {
    refreshBoard();
    if (selectedTask) {
      markNotifRead({ taskId: selectedTask.id });
      setTimeout(() => {
        const filters: { projectId?: string } = {};
        if (viewMode === 'project' && selectedProjectId) filters.projectId = selectedProjectId;
        api.tasks.board(filters).then(d => {
          const all = Object.values(d.board).flat();
          const updated = all.find(t => t.id === selectedTask.id);
          if (updated) setSelectedTask(updated); else setSelectedTask(null);
        }).catch(() => {});
      }, 150);
    }
  };

  const handleReqRefresh = () => {
    refreshRequirements();
    if (selectedReq) {
      setTimeout(() => {
        api.requirements.list({}).then(({ requirements: r }) => {
          const updated = r.find(rq => rq.id === selectedReq.id);
          if (updated) setSelectedReq(updated); else setSelectedReq(null);
        }).catch(() => {});
      }, 150);
    }
  };

  // ── Requirement actions ──

  const handleCreateReq = async () => {
    if (!reqTitle.trim()) { setReqCreateError(t('work:task.pleaseReqTitle')); return; }
    if (!reqDesc.trim()) { setReqCreateError(t('work:task.pleaseReqDesc')); return; }
    if (!reqProjectId) { setReqCreateError(t('work:task.pleaseReqProject')); return; }
    setReqCreateError('');
    try {
      const { requirement } = await api.requirements.create({ title: reqTitle.trim(), description: reqDesc.trim(), priority: reqPriority, projectId: reqProjectId });
      msg(t('work:task.requirementCreated'));
      setReqTitle(''); setReqDesc(''); setShowCreateReq(false);
      refreshRequirements();
      if (requirement) forceOpenReq(requirement);
    } catch (e) { setReqCreateError(e instanceof Error ? e.message : String(e)); }
  };

  const handleApproveReq = async (id: string) => {
    try { await api.requirements.approve(id); msg('Requirement approved'); markNotifRead({ requirementId: id }); handleReqRefresh(); refreshBoard(); } catch (e) { msg(`Error: ${e}`); }
  };

  const handleRejectReq = async () => {
    if (!rejectReqId) return;
    setRejectReqError('');
    try { await api.requirements.reject(rejectReqId, rejectReason); msg('Requirement rejected'); markNotifRead({ requirementId: rejectReqId }); setRejectReqId(null); setRejectReason(''); setRejectReqError(''); handleReqRefresh(); } catch (e) { setRejectReqError(e instanceof Error ? e.message : String(e)); }
  };

  const handleDeleteReq = async (id: string) => {
    try { await api.requirements.cancel(id); msg('Requirement cancelled'); markNotifRead({ requirementId: id }); handleReqRefresh(); } catch (e) { msg(`Error: ${e}`); }
  };

  // ── Drag handlers (tasks + requirements) ──

  const onDragStartTask = (e: DragEvent<HTMLDivElement>, task: TaskInfo) => {
    dragTaskRef.current = task; dragReqRef.current = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `task:${task.id}`);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };
  const onDragStartReq = (e: DragEvent<HTMLDivElement>, req: RequirementInfo) => {
    dragReqRef.current = req; dragTaskRef.current = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `req:${req.id}`);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
  };
  const onDragEnd = (e: DragEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    dragTaskRef.current = null; dragReqRef.current = null; setDragOverCol(null);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>, col: string) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (dragOverCol !== col) setDragOverCol(col);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>, col: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      if (dragOverCol === col) setDragOverCol(null);
    }
  };
  const onDrop = async (e: DragEvent<HTMLDivElement>, colId: string) => {
    e.preventDefault(); setDragOverCol(null);

    const task = dragTaskRef.current;
    const req = dragReqRef.current;

    if (task) {
      const targetCol = boardColumns.find((c: { id: string; dropStatus: string }) => c.id === colId);
      if (!targetCol) return;
      const targetStatus = targetCol.dropStatus;
      if (task.status === targetStatus) return;
      if (task.status === 'pending') return;
      try { await api.tasks.updateStatus(task.id, targetStatus); refreshBoard(); } catch { /* */ }
    } else if (req) {
      const targetReqStatus = REQ_DROP_STATUS[colId];
      if (!targetReqStatus) return;
      if (req.status === targetReqStatus) return;
      try { await api.requirements.updateStatus(req.id, targetReqStatus); refreshRequirements(); } catch { /* */ }
    }
  };

  const toggleAgentFilter = (id: string) => {
    setAgentFilter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleProjectFilter = (id: string) => {
    if (viewMode === 'project') {
      if (selectedProjectId === id) selectAllTasks();
      else selectProject(id);
    } else {
      setProjectFilter(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    }
  };

  // ── Filter & display helpers ──

  const CLOSED_STATUSES = new Set(['rejected', 'cancelled', 'archived']);
  const isClosed = (t: { status: string }) => CLOSED_STATUSES.has(t.status);

  const filterTasks = (tasks: TaskInfo[], includeArchived = false) => {
    let result = tasks.filter(t => showClosed || !isClosed(t));
    if (statusFilter) result = result.filter(t => t.status === statusFilter);
    if (viewMode === 'project' && selectedProjectId) {
      result = result.filter(t => t.projectId === selectedProjectId);
    }
    if (projectFilter.size > 0) result = result.filter(t => t.projectId && projectFilter.has(t.projectId));
    if (agentFilter.size > 0) result = result.filter(t => t.assignedAgentId && agentFilter.has(t.assignedAgentId));
    if (myTasksOnly && authUser?.id) result = result.filter(t => t.createdBy === authUser.id);
    return result;
  };

  const boardTaskMap = useMemo(() => {
    const m = new Map<string, TaskInfo>();
    for (const tasks of Object.values(board)) for (const t of tasks) m.set(t.id, t);
    return m;
  }, [board]);

  const agentIds = useMemo(() => new Set(agents.map(a => a.id)), [agents]);

  const getColumnTasks = (col: typeof BOARD_COLUMNS_BASE[number] & { label: string }) =>
    col.statuses.flatMap((s: string) => filterTasks(board[s] ?? []));

  const filteredReqs = useMemo(() => {
    let list = allRequirements;
    if (!showClosed) list = list.filter(r => !isClosed(r));
    if (viewMode === 'project' && selectedProjectId) list = list.filter(r => r.projectId === selectedProjectId);
    if (projectFilter.size > 0) list = list.filter(r => r.projectId && projectFilter.has(r.projectId));
    if (agentFilter.size > 0) {
      list = list.filter(r => agentFilter.has(r.createdBy));
    }
    if (myTasksOnly && authUser?.id) list = list.filter(r => r.createdBy === authUser.id);
    return list;
  }, [allRequirements, showClosed, viewMode, selectedProjectId, projectFilter, agentFilter, myTasksOnly, authUser?.id, agentIds]);

  const getColumnReqs = useCallback((col: typeof BOARD_COLUMNS_BASE[number] & { label: string }) =>
    filteredReqs.filter(r => REQ_COLUMN_MAP[r.status] === col.id), [filteredReqs]);

  const visibleColumns = boardColumns.filter((col: typeof BOARD_COLUMNS_BASE[number] & { label: string }) => {
    if (col.id === 'failed' || col.id === 'closed') {
      const tasks = getColumnTasks(col);
      const reqs = getColumnReqs(col);
      return tasks.length + reqs.length > 0;
    }
    return true;
  });

  const closedCount = Object.values(board).flat().filter(t => isClosed(t)).length
    + allRequirements.filter(r => isClosed(r)).length;

  const sortedAgents = useMemo(() => {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'archived']);
    const allTasks = Object.values(board).flat();
    const activeAgentIds = new Set<string>();
    for (const t of allTasks) {
      if (t.assignedAgentId && !terminal.has(t.status)) {
        if (!selectedProjectId || t.projectId === selectedProjectId) {
          activeAgentIds.add(t.assignedAgentId);
        }
      }
    }
    return [...agents].sort((a, b) => {
      const aActive = activeAgentIds.has(a.id) ? 0 : 1;
      const bActive = activeAgentIds.has(b.id) ? 0 : 1;
      return aActive - bActive;
    });
  }, [agents, board, selectedProjectId]);

  type TeamFilterItem = { kind: 'team'; id: string; name: string; agentIds: string[] } | { kind: 'agent'; agent: AgentInfo };
  const teamFilterItems = useMemo<TeamFilterItem[]>(() => {
    const teamMap = new Map<string, string[]>();
    const ungrouped: AgentInfo[] = [];
    for (const a of sortedAgents) {
      if (a.teamId) {
        const arr = teamMap.get(a.teamId) ?? [];
        arr.push(a.id);
        teamMap.set(a.teamId, arr);
      } else {
        ungrouped.push(a);
      }
    }
    const items: TeamFilterItem[] = [];
    for (const a of ungrouped) items.push({ kind: 'agent', agent: a });
    for (const tm of teams) {
      const agentIds = teamMap.get(tm.id);
      if (agentIds && agentIds.length > 0) {
        items.push({ kind: 'team', id: tm.id, name: tm.name, agentIds });
      }
    }
    return items;
  }, [sortedAgents, teams]);

  const sortedProjects = useMemo(() => {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'archived']);
    const allTasks = Object.values(board).flat();
    const activeProjectIds = new Set<string>();
    for (const t of allTasks) {
      if (t.projectId && !terminal.has(t.status)) {
        activeProjectIds.add(t.projectId);
      }
    }
    const filtered = showClosed ? projects : projects.filter(p => p.status !== 'archived');
    return [...filtered].sort((a, b) => {
      const aArchived = a.status === 'archived' ? 1 : 0;
      const bArchived = b.status === 'archived' ? 1 : 0;
      if (aArchived !== bArchived) return aArchived - bArchived;
      const aActive = activeProjectIds.has(a.id) ? 0 : 1;
      const bActive = activeProjectIds.has(b.id) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return a.name.localeCompare(b.name);
    });
  }, [projects, board, showClosed]);

  // Count tasks per project — computed locally from existing board data
  const allTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tasks of Object.values(board)) {
      for (const t of tasks) {
        const key = t.projectId ?? '__none__';
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [board]);

  const totalTaskCount = Object.values(allTaskCounts).reduce((a, b) => a + b, 0);

  if (loading) return <div className="flex-1 flex items-center justify-center text-fg-tertiary">{t('work:task.loadingPage')}</div>;

  const hasDetail = !!(selectedTask || selectedReq);
  const dualDetail = !isMobile && !!(selectedTask && selectedReq);

  return (
    <div ref={workContainerRef} className="flex-1 overflow-hidden flex bg-surface-primary">
      {/* ── Task Board + Project Context (left panel) ── */}
      <div
        className={`${isMobile ? 'flex-1 min-w-0' : hasDetail ? 'shrink-0 min-w-0' : 'flex-1'} overflow-hidden flex flex-col bg-surface-primary`}
        style={isMobile ? (mobileShowDetail ? { display: 'none' } : undefined) : (dualDetail ? { width: 0 } : hasDetail ? { width: `calc(100% - ${detailPanel.width}px - 4px)` } : undefined)}
      >
        {/* Flash */}
        {flash && <div className="mx-6 mt-2 px-3 py-1.5 bg-green-500/15 text-green-600 text-xs rounded-lg">{flash}</div>}

        {/* Top bar */}
        {isMobile ? (
          <div className="shrink-0">
            {/* Mobile Row 1: title + action buttons */}
            <div className="flex items-center gap-2 px-3 h-11">
              <MobileMenuButton />
              {selectedProject ? (
                <div className="flex items-center gap-1 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-fg-primary truncate">{selectedProject.name}</span>
                  <button onClick={() => openProjectSettings(selectedProject.id)}
                    className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors shrink-0 ${showProjectSettings ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary'}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  </button>
                </div>
              ) : (
                <h2 className="text-sm font-semibold text-fg-primary min-w-0 flex-1 truncate">
                  {projects.length === 1 ? projects[0].name : t('work:task.projectsCount', { count: projects.length })}
                </h2>
              )}
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => setShowCreateProject(true)} className="px-2 py-1 text-[11px] bg-brand-600 text-white rounded-md">{t('work:task.shortProject')}</button>
                <button onClick={openCreateReq} className="px-2 py-1 text-[11px] bg-brand-600 text-white rounded-md">{t('work:task.shortReq')}</button>
                <button onClick={() => { setTaskProjectId(selectedProjectId ?? ''); setShowCreateTask(true); }} className="px-2 py-1 text-[11px] border border-amber-500/60 text-amber-600 rounded-md">{t('work:task.shortTask')}</button>
              </div>
            </div>
            {/* Mobile Row 2: view toggle + filter */}
            <div className="flex items-center gap-2 px-3 h-9">
              <div className="flex items-center border border-border-default/60 rounded-md overflow-hidden shrink-0">
                {(['backlog', 'kanban', 'dag'] as const).map(v => (
                  <button key={v} onClick={() => setBoardType(v)}
                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${boardType === v ? 'bg-brand-600/25 text-brand-500' : 'text-fg-tertiary'}`}
                  >{v === 'backlog' ? t('work:task.backlog') : v === 'kanban' ? t('work:task.kanban') : t('work:task.dag')}</button>
                ))}
              </div>
              {closedCount > 0 && (
                <button onClick={() => setShowClosed(v => !v)} className={`text-[10px] shrink-0 px-2 py-0.5 rounded-md transition-colors ${showClosed ? 'bg-surface-overlay text-fg-secondary' : 'text-fg-tertiary'}`}>
                  {showClosed ? t('work:task.hideArchived') : t('work:task.archivedCount', { count: closedCount })}
                </button>
              )}
              <div className="flex-1" />
              {statusFilter && (
                <button onClick={() => setStatusFilter(null)}
                  className="px-2 py-0.5 text-[11px] rounded-md font-medium bg-brand-600/20 text-brand-500 ring-1 ring-brand-500/30 flex items-center gap-1">
                  {t(`common:status.${statusFilter === 'in_progress' ? 'inProgress' : statusFilter}`)}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              )}
              {(projectFilter.size > 0 || agentFilter.size > 0 || myTasksOnly || projects.length > 1 || agents.length > 0) && (
                <button onClick={() => setShowFilterSheet(true)}
                  className={`px-2 py-1 text-[11px] rounded-md font-medium transition-colors flex items-center gap-1 ${
                    projectFilter.size > 0 || agentFilter.size > 0 || myTasksOnly
                      ? 'bg-brand-600/20 text-brand-500 ring-1 ring-brand-500/30'
                      : 'border border-border-default text-fg-secondary'
                  }`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
                  {(projectFilter.size + agentFilter.size + (myTasksOnly ? 1 : 0)) > 0 ? t('work:task.filterWithCount', { count: projectFilter.size + agentFilter.size + (myTasksOnly ? 1 : 0) }) : t('work:task.filter')}
                </button>
              )}
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-3 px-6 h-14 shrink-0">
          {/* Project title + settings */}
          {selectedProject ? (
            <div className="flex items-center gap-1 shrink-0">
              <InlineEditableText
                value={selectedProject.name}
                onSave={async (name) => { await api.projects.update(selectedProject.id, { name } as Partial<ProjectInfo>); refreshProjects(); }}
                className="text-sm font-semibold text-fg-primary"
              />
              <button
                onClick={() => openProjectSettings(selectedProject.id)}
                className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
                  showProjectSettings ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'
                }`}
                title={t('work:project.settingsTitle')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </button>
            </div>
          ) : (
            <h2 className="text-sm font-semibold text-fg-primary shrink-0">
              {projects.length === 1 ? projects[0].name : t('work:task.projectsCount', { count: projects.length })}
            </h2>
          )}
          {closedCount > 0 && (
            <button onClick={() => setShowClosed(v => !v)} className={`text-[10px] shrink-0 px-2 py-0.5 rounded-md transition-colors ${showClosed ? 'bg-surface-overlay text-fg-secondary' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
                {showClosed ? t('work:task.hideArchivedWithCount', { count: closedCount }) : t('work:task.archivedCount', { count: closedCount })}
            </button>
          )}

          {/* View toggle */}
          <div className="flex items-center border border-border-default/60 rounded-md overflow-hidden shrink-0">
            {(['backlog', 'kanban', 'dag', 'workflows'] as const).map(v => (
              <button key={v} onClick={() => setBoardType(v)}
                className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${boardType === v ? 'bg-brand-600/25 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'}`}
              >{v === 'backlog' ? t('work:task.backlog') : v === 'kanban' ? t('work:task.kanban') : v === 'dag' ? t('work:task.dag') : t('work:task.workflows', 'Workflows')}</button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => setShowCreateProject(true)} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg font-medium transition-colors">{t('work:task.shortProject')}</button>
            <button onClick={openCreateReq} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-xs rounded-lg font-medium transition-colors">{t('work:task.newRequirement')}</button>
            <button onClick={() => { setTaskProjectId(selectedProjectId ?? ''); setShowCreateTask(true); }} className="px-3 py-1.5 border border-amber-500/60 text-amber-600 hover:bg-amber-500/10 text-xs rounded-lg font-medium transition-colors">{t('work:task.newTaskBtn')}</button>
          </div>

          <div className="flex-1" />

        </div>
        )}

        {/* Project filter bar — desktop only (hidden in workflows view) */}
        {!isMobile && boardType !== 'workflows' && projects.length > 1 && !selectedProjectId && !showProjectSettings && (totalTaskCount > 0 || allRequirements.length > 0) && (
          <div className="px-6 py-1.5 flex items-center gap-1.5 overflow-x-auto scrollbar-hide shrink-0">
            <button onClick={() => setProjectFilter(new Set())}
              className={`text-[10px] text-fg-tertiary hover:text-fg-secondary px-2 py-1 rounded-md bg-surface-elevated/60 hover:bg-surface-overlay shrink-0 transition-all ${projectFilter.size > 0 ? 'visible opacity-100' : 'invisible opacity-0'}`}>{t('work:task.clear')}</button>
            {sortedProjects.map(p => {
              const selected = projectFilter.has(p.id);
              const count = allTaskCounts[p.id] ?? 0;
              const editingThis = showProjectSettings && settingsProjectId === p.id;
              return (
                <div key={p.id} className={`flex items-center shrink-0 rounded-md overflow-hidden transition-all ${selected ? 'bg-brand-500/15 ring-1 ring-brand-500/30' : ''}`}>
                  <button onClick={() => toggleProjectFilter(p.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] shrink-0 transition-all ${
                      selected ? 'text-brand-600' : 'text-fg-tertiary hover:bg-surface-elevated hover:text-fg-secondary'
                    }`}>
                    <span className={`w-4 h-4 rounded-sm flex items-center justify-center text-[9px] font-bold shrink-0 ${selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-secondary'}`}>{p.name[0]?.toUpperCase()}</span>
                    {p.name}
                    {count > 0 && <span className="text-[9px] text-fg-tertiary ml-0.5">{count}</span>}
                  </button>
                  {selected && (
                    <button
                      onClick={() => openProjectSettings(p.id)}
                      className={`px-1.5 py-1 self-stretch flex items-center border-l border-brand-500/20 transition-colors ${
                        editingThis ? 'text-fg-primary bg-surface-overlay' : 'text-fg-tertiary hover:text-brand-600 hover:bg-brand-500/10'
                      }`}
                      title={t('work:project.editProject')}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Team/agent filter bar — desktop only (hidden in workflows view) */}
        {!isMobile && boardType !== 'workflows' && (teamFilterItems.length > 0 || authUser?.id) && !showProjectSettings && (totalTaskCount > 0 || allRequirements.length > 0) && (
          <div className="px-6 py-1.5 flex items-center gap-1.5 overflow-x-auto scrollbar-hide shrink-0">
            <button type="button" onClick={() => { setAgentFilter(new Set()); setMyTasksOnly(false); }}
              className={`text-[10px] text-fg-tertiary hover:text-fg-secondary px-2 py-1 rounded-md bg-surface-elevated/60 hover:bg-surface-overlay shrink-0 transition-all ${agentFilter.size > 0 || myTasksOnly ? 'visible opacity-100' : 'invisible opacity-0'}`}>{t('work:task.clear')}</button>
            {authUser?.id && (
              <button
                type="button"
                onClick={() => setMyTasksOnly(v => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all ${
                  myTasksOnly ? 'bg-green-600/20 text-green-500 ring-1 ring-green-500/40' : 'text-fg-tertiary hover:bg-surface-elevated hover:text-fg-secondary'
                }`}
              >
                {t('work:task.myTasks')}
              </button>
            )}
            {teamFilterItems.map(item => {
              if (item.kind === 'team') {
                const selected = item.agentIds.every(id => agentFilter.has(id));
                const partial = !selected && item.agentIds.some(id => agentFilter.has(id));
                return (
                  <button key={`team-${item.id}`} onClick={() => {
                    setAgentFilter(prev => {
                      const next = new Set(prev);
                      if (selected) { for (const id of item.agentIds) next.delete(id); }
                      else { for (const id of item.agentIds) next.add(id); }
                      return next;
                    });
                  }}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all ${
                      selected ? 'bg-brand-600/20 text-brand-500 ring-1 ring-brand-500/40'
                      : partial ? 'bg-brand-600/10 text-brand-400 ring-1 ring-brand-500/20'
                      : 'text-fg-tertiary hover:bg-surface-elevated hover:text-fg-secondary'
                    }`}>
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    {item.name}
                    <span className="text-[9px] text-fg-quaternary">{item.agentIds.length}</span>
                  </button>
                );
              }
              const a = item.agent;
              const selected = agentFilter.has(a.id);
              return (
                <button key={a.id} onClick={() => toggleAgentFilter(a.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] shrink-0 transition-all ${
                    selected ? 'bg-brand-600/20 text-brand-500 ring-1 ring-brand-500/40' : 'text-fg-tertiary hover:bg-surface-elevated hover:text-fg-secondary'
                  }`}>
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-secondary'}`}>{a.name[0]?.toUpperCase()}</span>
                  {a.name}
                </button>
              );
            })}
          </div>
        )}

        {showProjectSettings && settingsProject ? (
          <div className="flex-1 overflow-y-auto">
            {!selectedProject && (
              <div className="px-6 py-2 flex items-center gap-2 border-b border-border-default/60 shrink-0">
                <button onClick={closeProjectSettings} className="text-[11px] text-brand-500 hover:text-brand-400 font-medium flex items-center gap-1 shrink-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                  {t('common:back')}
                </button>
                <InlineEditableText
                  value={settingsProject.name}
                  onSave={async (name) => { await api.projects.update(settingsProject.id, { name } as Partial<ProjectInfo>); refreshProjects(); }}
                  className="text-sm font-semibold text-fg-primary truncate min-w-0"
                />
              </div>
            )}
            <ProjectSettingsPanel
              project={settingsProject}
              tasks={Object.values(board).flat()}
              requirements={allRequirements}
              agents={agents}
              onDeleteProject={() => handleDeleteProject(settingsProject.id)}
              onUpdateProject={async (data) => { await api.projects.update(settingsProject.id, data); }}
              onRefresh={() => { refreshProjects(); }}
            />
          </div>
        ) : totalTaskCount === 0 && filteredReqs.length === 0 && viewMode === 'project' && selectedProject ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
            <div className="px-6 py-2 flex items-center gap-2 border-b border-border-default/60 shrink-0 sticky top-0 bg-surface-primary z-10">
              <button onClick={selectAllTasks} className="text-[11px] text-brand-500 hover:text-brand-400 font-medium flex items-center gap-1 shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                {t('common:back')}
              </button>
            </div>
            <ProjectSettingsPanel
              project={selectedProject}
              tasks={[]}
              requirements={[]}
              agents={agents}
              onDeleteProject={() => handleDeleteProject(selectedProject.id)}
              onUpdateProject={async (data) => { await api.projects.update(selectedProject.id, data); }}
              onRefresh={() => { refreshProjects(); }}
            />
          </div>
        ) : totalTaskCount === 0 && filteredReqs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-8">
            {projects.length === 0 ? (
              <div className="max-w-sm w-full text-center space-y-3">
                <div className="w-12 h-12 mx-auto rounded-xl bg-brand-500/10 flex items-center justify-center">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand-500"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                </div>
                <h3 className="text-sm font-medium text-fg-secondary">{t('work:task.emptyNoProjectsTitle')}</h3>
                <p className="text-xs text-fg-tertiary leading-relaxed">{t('work:task.emptyNoProjectsHint')}</p>
                <button onClick={() => setShowCreateProject(true)} className="inline-flex items-center gap-1.5 px-4 py-2 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-medium transition-colors">
                  {t('work:project.newProject')}
                </button>
              </div>
            ) : (
              <div className="w-full max-w-2xl mx-auto space-y-4">
                <p className="text-xs text-fg-tertiary text-center">{t('work:task.emptyNoReqsHint')}</p>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
                  {projects.map(p => (
                    <button
                      key={p.id}
                      onClick={() => selectProject(p.id)}
                      className="group flex items-start gap-3 p-4 rounded-xl border border-border-default bg-surface-elevated hover:border-brand-500/50 hover:bg-brand-500/5 transition-all text-left"
                    >
                      <div className="w-9 h-9 shrink-0 rounded-lg bg-brand-500/10 flex items-center justify-center">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand-500"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-fg-primary group-hover:text-brand-500 truncate transition-colors">{p.name}</div>
                        {p.description && <div className="text-[11px] text-fg-tertiary mt-0.5 line-clamp-2">{p.description}</div>}
                        <div className="text-[10px] text-fg-quaternary mt-1.5">
                          {new Date(p.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-quaternary group-hover:text-brand-500 shrink-0 mt-1 transition-colors"><polyline points="9 18 15 12 9 6" /></svg>
                    </button>
                  ))}
                </div>
                <div className="text-center pt-2">
                  <button onClick={openCreateReq} className="inline-flex items-center gap-1.5 px-4 py-2 text-xs bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-medium transition-colors">
                    {t('work:task.createRequirementCta')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : boardType === 'backlog' ? (
          <div className="flex-1 min-h-0 flex flex-col" onTouchStart={isMobile ? boardSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? boardSwipe.onTouchEnd : undefined}>
          <BacklogTable
            tasks={filterTasks(Object.values(board).flat())}
            requirements={filteredReqs}
            agents={agents}
            projects={projects}
            onTaskClick={task => handleSelectTask(task)}
            onReqClick={req => handleSelectReq(req)}
            onRefresh={() => { refreshBoard(); refreshRequirements(); }}
            selectedTaskId={selectedTask?.id}
            selectedReqId={selectedReq?.id}
          />
          </div>
        ) : boardType === 'workflows' ? (
          <WorkflowsPanel teamId={selectedProjectTeamId} projectId={selectedProjectId} agents={agents} projects={projects} onViewRunTasks={(reqId) => {
            const openReqInDag = (req: RequirementInfo) => {
              forceOpenReq(req);
              setDagExpandReqId(`req-${req.id}`);
              setBoardType('dag');
            };
            const req = allRequirements.find(r => r.id === reqId);
            if (req) {
              openReqInDag(req);
            } else {
              api.requirements.get(reqId).then(resp => {
                if (resp.requirement) {
                  setAllRequirements(prev => [...prev, resp.requirement]);
                  openReqInDag(resp.requirement);
                }
              }).catch(() => {});
            }
          }} />
        ) : boardType === 'dag' ? (
          <div className="flex-1 min-h-0 flex flex-col relative" onTouchStart={isMobile ? boardSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? boardSwipe.onTouchEnd : undefined}>
          <TaskDAG
            tasks={(() => {
              const allDagTasks = filterTasks(Object.values(board).flat(), true);
              if (previewMode && selectedReq) {
                const reqTaskIds = new Set(selectedReq.taskIds ?? []);
                return allDagTasks.filter(t => reqTaskIds.has(t.id));
              }
              return allDagTasks;
            })()}
            requirements={previewMode && selectedReq ? [selectedReq] : filteredReqs}
            agents={agents}
            showArchived={showClosed}
            onShowArchivedChange={setShowClosed}
            onTaskClick={(task) => handleSelectTask(task)}
            onReqClick={(req) => handleSelectReq(req)}
            onCollapseDAG={() => { setSelectedTask(null); setSelectedReq(null); setDagExpandReqId(null); }}
            onDependencyChange={refreshBoard}
            selectedTaskId={selectedTask?.id}
            selectedReqId={selectedReq?.id}
            hasDetailPanel={hasDetail}
            defaultExpandedNodeId={dagExpandReqId ?? (previewMode && selectedReq ? `req-${selectedReq.id}` : undefined)}
            previewMode={previewMode}
          />
          {isMobile && (
            <button onClick={() => setBoardType('kanban')} className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-brand-500 border border-brand-400/60 shadow-xl shadow-brand-500/30 flex items-center justify-center text-white active:bg-brand-400 backdrop-blur-sm z-10" title={t('work:task.backToKanban')}>
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" /></svg>
            </button>
          )}
          </div>
        ) : (
          <div ref={kanbanScrollRef} className="flex-1 min-h-0 overflow-auto px-4 py-5" onTouchStart={isMobile ? kanbanSwipe.onTouchStart : undefined} onTouchEnd={isMobile ? kanbanSwipe.onTouchEnd : undefined}>
            <div className="flex gap-3 items-stretch">
              {visibleColumns.map(col => {
                const colTasks = getColumnTasks(col);
                const colReqs = getColumnReqs(col);
                const itemCount = colTasks.length + colReqs.length;
                const isOver = dragOverCol === col.id;
                return (
                  <div key={col.id}
                    className={`w-[280px] shrink-0 rounded-xl flex flex-col transition-colors ${isOver ? 'bg-surface-elevated/60 ring-1 ring-brand-500/30' : 'bg-surface-secondary/50'}`}
                    onDragOver={e => onDragOver(e, col.id)} onDragLeave={e => onDragLeave(e, col.id)} onDrop={e => void onDrop(e, col.id)}>
                    <div className={`flex justify-between items-center px-3 py-2.5 shrink-0 border-b border-border-default/30 sticky top-0 z-10 rounded-t-xl ${isOver ? 'bg-surface-elevated/60' : 'bg-surface-secondary/50'}`}>
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${col.accent.replace('border-t-', 'bg-')}`} />
                        <span className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">{col.label}</span>
                      </div>
                      <span className="text-[11px] text-fg-tertiary font-medium tabular-nums">{itemCount}</span>
                    </div>
                    <div className="space-y-2 px-2 py-2">
                      {(() => {
                        type CardItem = { kind: 'req'; data: RequirementInfo; time: number } | { kind: 'task'; data: TaskInfo; time: number };
                        const items: CardItem[] = [
                          ...colReqs.map(r => ({ kind: 'req' as const, data: r, time: new Date(r.updatedAt ?? r.createdAt).getTime() })),
                          ...colTasks.map(tk => ({ kind: 'task' as const, data: tk, time: new Date(tk.updatedAt ?? tk.createdAt ?? 0).getTime() })),
                        ];
                        items.sort((a, b) => b.time - a.time);
                        return items.map(item => {
                          if (item.kind === 'req') {
                            const req = item.data;
                            const badge = reqStatusBadges[req.status] ?? { label: req.status, cls: 'bg-gray-500/15 text-fg-secondary' };
                            const isAgent = req.source === 'agent';
                            const needsReview = isAgent && req.status === 'pending';
                            const reqProject = viewMode === 'all' && req.projectId ? projects.find(p => p.id === req.projectId) : null;
                            const creatorName = resolveActorName(req.createdBy, agents, users) ?? req.createdBy.slice(0, 10);
                            const isSelected = selectedReq?.id === req.id;
                            return (
                              <div key={`req-${req.id}`} role="button" tabIndex={0} draggable
                                onDragStart={e => onDragStartReq(e, req)} onDragEnd={onDragEnd}
                                onClick={() => handleSelectReq(req)} onKeyDown={e => e.key === 'Enter' && handleSelectReq(req)}
                                className={`group rounded-lg p-2.5 border border-transparent transition-all cursor-grab active:cursor-grabbing
                                  ${needsReview ? 'bg-amber-500/[0.06] border-amber-500/30 ring-1 ring-amber-500/15' : 'bg-surface-elevated/80 hover:bg-surface-elevated border-border-default/50 hover:border-brand-400/40'}
                                  ${isSelected ? 'ring-2 ring-brand-500/50 border-brand-500/40' : ''}`}>
                                <div className="flex items-center gap-1.5 mb-1">
                                  <span className="w-1 h-1 rounded-full bg-purple-500 shrink-0" />
                                  <span className="text-[10px] font-semibold text-purple-500 uppercase tracking-wide shrink-0">{t('work:task.requirementShort')}</span>
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-md shrink-0 ml-auto ${badge.cls}`}>{badge.label}</span>
                                </div>
                                <div className="text-[13px] font-medium leading-snug text-fg-primary line-clamp-2 mb-1">{req.title}</div>
                                {req.description && <div className="text-[11px] text-fg-tertiary line-clamp-1 mb-1.5">{req.description}</div>}
                                <div className="flex items-center justify-between mt-auto pt-1.5 border-t border-border-default/20">
                                  <div className="flex items-center gap-1.5">
                                    {reqProject && <span className="text-[10px] px-1.5 py-0.5 bg-surface-overlay/60 text-fg-secondary rounded truncate max-w-[90px]" title={reqProject.name}>{reqProject.name}</span>}
                                    <span className="text-[10px] text-fg-tertiary">{req.priority}</span>
                                    <span className="text-[10px] text-fg-quaternary">by {creatorName}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    {req.taskIds.length > 0 && <span className="text-[10px] text-brand-500/70 bg-brand-500/8 px-1.5 py-0.5 rounded-md">📋 {req.taskIds.length}</span>}
                                  </div>
                                </div>
                                {needsReview && (
                                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-amber-500/15">
                                    <button onClick={e => { e.stopPropagation(); handleApproveReq(req.id); }}
                                      className="flex-1 py-1 bg-green-600 hover:bg-green-500 text-white text-[10px] rounded-md font-medium transition-colors">{t('work:task.approve')}</button>
                                    <button onClick={e => { e.stopPropagation(); setRejectReqId(req.id); }}
                                      className="flex-1 py-1 border border-red-500/30 hover:bg-red-500/10 text-red-500 text-[10px] rounded-md font-medium transition-colors">{t('work:task.reject')}</button>
                                  </div>
                                )}
                              </div>
                            );
                          } else {
                            const task = item.data;
                            const subCount = task.subtasks?.length ?? 0;
                            const badge = subStatusBadges[task.status];
                            const isApprovalTask = task.status === 'pending';
                            const isSchedTask = task.taskType === 'scheduled' && !!task.scheduleConfig;
                            const schedLabel = isSchedTask ? (task.scheduleConfig!.every ? t('work:task.everyInterval', { interval: task.scheduleConfig!.every }) : task.scheduleConfig!.cron ? t('work:task.cronLabel') : t('work:task.scheduledShort')) : null;
                            const taskProjName = viewMode === 'all' && task.projectId ? (() => { const n = projects.find(p => p.id === task.projectId)?.name; return n && n !== 'default' ? n : null; })() : null;
                            const taskReqTitle = task.requirementId ? allRequirements.find(r => r.id === task.requirementId)?.title : null;
                            const taskCreatorName = task.createdBy ? (resolveActorName(task.createdBy, agents, users) ?? task.createdBy) : null;
                            const isSelected = selectedTask?.id === task.id;
                            const priorityDot: Record<string, string> = { urgent: 'bg-red-500', high: 'bg-amber-500', medium: 'bg-blue-500', low: 'bg-gray-400' };
                            const cardAbnormalBlocked = task.status === 'blocked' && (!task.blockedBy || task.blockedBy.length === 0 || task.blockedBy.every(id => {
                              const dep = boardTaskMap.get(id);
                              return dep && dep.status === 'completed';
                            }));
                            return (
                              <div key={task.id} role="button" tabIndex={0} aria-label={task.title} draggable={!isApprovalTask}
                                onDragStart={e => !isApprovalTask && onDragStartTask(e, task)} onDragEnd={onDragEnd}
                                onClick={() => handleSelectTask(task)} onKeyDown={e => e.key === 'Enter' && handleSelectTask(task)}
                                className={`group rounded-lg p-2.5 border border-transparent transition-all ${
                                  cardAbnormalBlocked
                                    ? 'bg-red-500/[0.06] border-red-500/30 ring-1 ring-red-500/15 cursor-pointer'
                                    : isApprovalTask
                                    ? 'bg-amber-500/[0.06] border-amber-500/30 ring-1 ring-amber-500/15 cursor-pointer'
                                    : isSchedTask
                                      ? 'bg-blue-500/[0.04] border-blue-500/20 hover:border-blue-400/40 cursor-pointer'
                                      : 'bg-surface-elevated/80 hover:bg-surface-elevated border-border-default/50 hover:border-brand-400/40 cursor-grab active:cursor-grabbing'
                                } ${isSelected ? 'ring-2 ring-brand-500/50 border-brand-500/40' : ''}`}>
                                <div className="flex items-center gap-1.5 mb-1">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${priorityDot[task.priority] ?? 'bg-gray-400'}`} title={task.priority} />
                                  {isSchedTask && <span className="text-blue-500 shrink-0" title={schedLabel ?? 'Scheduled'}><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg></span>}
                                  {isSchedTask && schedLabel && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-500 whitespace-nowrap">{schedLabel}</span>}
                                  {badge && <span className={`text-[10px] px-1.5 py-0.5 rounded-md ml-auto shrink-0 ${badge.cls}`}>{badge.label}</span>}
                                  {cardAbnormalBlocked && <span className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0 bg-red-500/15 text-red-500 font-medium">⚠</span>}
                                </div>
                                <div className="text-[13px] font-medium leading-snug text-fg-primary line-clamp-2 mb-1">{task.title}</div>
                                {task.description && <div className="text-[11px] text-fg-tertiary line-clamp-1 mb-1.5">{task.description}</div>}
                                {(taskProjName || taskReqTitle || (task.blockedBy && task.blockedBy.length > 0)) && (
                                  <div className="flex flex-wrap gap-1 mb-1.5">
                                    {taskProjName && <span className="text-[10px] px-1.5 py-0.5 bg-surface-overlay/60 text-fg-secondary rounded-md truncate max-w-[100px]" title={taskProjName}>{taskProjName}</span>}
                                    {taskReqTitle && <span className="text-[10px] px-1.5 py-0.5 bg-brand-500/8 text-brand-500 rounded-md truncate max-w-[110px]" title={taskReqTitle}># {taskReqTitle}</span>}
                                    {task.blockedBy && task.blockedBy.length > 0 && <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-600 rounded-md">⏳ {task.blockedBy.length} dep{task.blockedBy.length > 1 ? 's' : ''}</span>}
                                  </div>
                                )}
                                <div className="flex items-center justify-between mt-auto pt-1.5 border-t border-border-default/20">
                                  <div className="flex items-center gap-1.5">
                                    {taskCreatorName && <span className="text-[10px] text-fg-quaternary" title={`by ${taskCreatorName}`}>by {taskCreatorName}</span>}
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    {subCount > 0 && <span className="text-[10px] text-fg-tertiary">⋮ {subCount}</span>}
                                    {task.notes && task.notes.length > 0 && <span className="text-[10px] text-fg-tertiary">📝 {task.notes.length}</span>}
                                    {task.assignedAgentId && (
                                      <span className="text-[10px] text-brand-500 bg-brand-500/8 px-1.5 py-0.5 rounded-md flex items-center gap-1">
                                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[agents.find(a => a.id === task.assignedAgentId)?.status ?? ''] ?? 'bg-gray-500'}`} />
                                        {agents.find(a => a.id === task.assignedAgentId)?.name ?? task.assignedAgentId.slice(0, 8)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          }
                        });
                      })()}
                    </div>
                    {isOver && (
                      <div className="sticky bottom-2 mx-2 mb-2 border-2 border-dashed border-brand-500/25 rounded-lg h-10 flex items-center justify-center shrink-0 bg-surface-secondary/80 backdrop-blur-sm">
                        <span className="text-[11px] text-brand-500/50">{t('work:task.dropHere')}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Resize handle — desktop only, when detail is open */}
      {!isMobile && hasDetail && (
        <div className="w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center" onMouseDown={detailPanel.onResizeStart}>
          <div className="w-px h-2/3 border-l border-dashed border-transparent group-hover:border-border-default group-active:border-fg-tertiary transition-colors" />
        </div>
      )}

      {/* Detail panel(s) */}
      {(!isMobile || mobileShowDetail) && hasDetail && (
        <div className={`${isMobile ? 'flex-1' : dualDetail ? 'flex-1' : 'shrink-0'} overflow-hidden min-w-0 flex`}
          style={isMobile || dualDetail ? undefined : { width: detailPanel.width }}>
          {dualDetail ? (
            <>
              <div className="flex-1 min-w-0 overflow-hidden">
                <RequirementDetailPanel
                  req={selectedReq!}
                  agents={agents}
                  projects={projects}
                  allTasks={Object.values(board).flat()}
                  users={users}
                  onClose={() => { setSelectedReq(null); }}
                  onApprove={id => { handleApproveReq(id); }}
                  onReject={id => { setRejectReqId(id); }}
                  onCancel={id => { handleDeleteReq(id); setSelectedReq(null); }}
                  onStatusChange={async (id, status) => {
                    try { await api.requirements.updateStatus(id, status); msg(`Requirement status → ${status}`); markNotifRead({ requirementId: id }); handleReqRefresh(); refreshBoard(); } catch (e) { msg(`Error: ${e}`); }
                  }}
                  onRefresh={handleReqRefresh}
                  authUser={authUser}
                  onTaskClick={task => { setSelectedTask(task); }}
                  onCreateTask={(reqId, projectId) => {
                    setTaskRequirementId(reqId);
                    if (projectId) setTaskProjectId(projectId);
                    setShowCreateTask(true);
                  }}
                  onProjectClick={toggleProjectFilter}
                  previewMode={previewMode}
                />
              </div>
              <div className="w-px shrink-0 bg-border-default" />
              <div className="flex-1 min-w-0 overflow-hidden">
                <TaskDetailPanel
                  task={selectedTask!}
                  agents={agents}
                  projects={projects}
                  requirements={allRequirements}
                  allTasks={Object.values(board).flat()}
                  users={users}
                  onClose={handleCloseTask}
                  onRefresh={handleTaskRefresh}
                  authUser={authUser}
                  scrollToComments={scrollToComments}
                  onScrollToCommentsDone={() => setScrollToComments(false)}
                  onReqClick={req => { setSelectedReq(prev => prev?.id === req.id ? null : req); }}
                  onProjectClick={toggleProjectFilter}
                />
              </div>
            </>
          ) : selectedTask ? (
            <TaskDetailPanel
              task={selectedTask}
              agents={agents}
              projects={projects}
              requirements={allRequirements}
              allTasks={Object.values(board).flat()}
              users={users}
              onClose={handleCloseDetail}
              onRefresh={handleTaskRefresh}
              authUser={authUser}
              scrollToComments={scrollToComments}
              onScrollToCommentsDone={() => setScrollToComments(false)}
              onReqClick={req => { setSelectedReq(prev => prev?.id === req.id ? null : req); }}
              onProjectClick={toggleProjectFilter}
            />
          ) : selectedReq ? (
            <RequirementDetailPanel
              req={selectedReq}
              agents={agents}
              projects={projects}
              allTasks={Object.values(board).flat()}
              users={users}
              onClose={handleCloseDetail}
              onApprove={id => { handleApproveReq(id); }}
              onReject={id => { setRejectReqId(id); }}
              onCancel={id => { handleDeleteReq(id); handleCloseDetail(); }}
              onStatusChange={async (id, status) => {
                try { await api.requirements.updateStatus(id, status); msg(`Requirement status → ${status}`); markNotifRead({ requirementId: id }); handleReqRefresh(); refreshBoard(); } catch (e) { msg(`Error: ${e}`); }
              }}
              scrollToComments={scrollToComments}
              onScrollToCommentsDone={() => setScrollToComments(false)}
              onRefresh={handleReqRefresh}
              authUser={authUser}
              onTaskClick={task => {
                setSelectedTask(task);
                if (isMobile) { setMobileShowDetail(true); history.pushState({ mobileDetail: PAGE.WORK }, '', window.location.hash); }
              }}
              onCreateTask={(reqId, projectId) => {
                setTaskRequirementId(reqId);
                if (projectId) setTaskProjectId(projectId);
                setShowCreateTask(true);
              }}
              onProjectClick={toggleProjectFilter}
              previewMode={previewMode}
            />
          ) : null}
        </div>
      )}

      {showCreateProject && (
        <NewProjectModal
          orgId={authUser?.orgId}
          onCreated={handleProjectCreated}
          onClose={() => setShowCreateProject(false)}
        />
      )}

      {/* ── Create Task Modal ── */}
      {showCreateTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={() => { setShowCreateTask(false); setTaskCreateError(''); }}>
          <div className={`bg-surface-secondary border border-border-default rounded-xl p-6 space-y-4 max-h-[90dvh] overflow-y-auto ${isMobile ? 'w-full' : 'w-[28rem]'}`} onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-fg-primary">{t('work:task.newTask')}</h3>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.titleLabel')}</label>
              <input autoFocus={!isMobile} value={taskTitle} onChange={e => setTaskTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void createTask(); }}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.descriptionField')}</label>
              <textarea value={taskDesc} onChange={e => setTaskDesc(e.target.value)} rows={2}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.projectLabel')}</label>
                <SearchableSelect
                  options={[{ value: '', label: t('work:task.noProject') }, ...projects.map(p => ({ value: p.id, label: p.name }))]}
                  value={taskProjectId}
                  onChange={v => { setTaskProjectId(v); setTaskRequirementId(''); }}
                  placeholder={t('work:task.noProject')}
                  noMatchesText={t('work:task.noMatches')}
                />
              </div>
              <div>
                <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.requirementLabel')}</label>
                <SearchableSelect
                  options={[
                    { value: '', label: t('work:task.selectRequirement') },
                    ...allRequirements
                      .filter(r => r.status === 'in_progress' && (!taskProjectId || r.projectId === taskProjectId))
                      .map(r => ({ value: r.id, label: r.title })),
                  ]}
                  value={taskRequirementId}
                  onChange={setTaskRequirementId}
                  placeholder={t('work:task.selectRequirement')}
                  noMatchesText={t('work:task.noMatches')}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.assignToRequired')} <span className="text-red-500">*</span></label>
                <SearchableSelect
                  options={agents.map(a => ({ value: a.id, label: `${a.name} (${a.status})` }))}
                  value={taskAssignTo}
                  onChange={setTaskAssignTo}
                  placeholder={t('work:task.selectAgent')}
                  noMatchesText={t('work:task.noMatches')}
                />
              </div>
              <div>
                <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.reviewerRequired')} <span className="text-red-500">*</span></label>
                <SearchableSelect
                  options={[
                    ...users.map(u => ({ value: `human:${u.id}`, label: u.name })),
                    ...agents.filter(a => a.id !== taskAssignTo).map(a => ({ value: `agent:${a.id}`, label: `${a.name} (${a.status})` })),
                  ]}
                  value={taskReviewer}
                  onChange={setTaskReviewer}
                  placeholder={t('work:task.selectReviewer')}
                  noMatchesText={t('work:task.noMatches')}
                />
              </div>
            </div>
            <div className={`grid gap-4 ${taskType === 'scheduled' ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div>
                <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.priorityField')}</label>
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                  <option value="low">{t('work:priority.low')}</option><option value="medium">{t('work:priority.medium')}</option><option value="high">{t('work:priority.high')}</option><option value="urgent">{t('work:priority.urgent')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.taskType')}</label>
                <select value={taskType} onChange={e => setTaskType(e.target.value as 'standard' | 'scheduled')}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                  <option value="standard">{t('work:task.taskTypeStandard')}</option>
                  <option value="scheduled">{t('work:task.taskTypeScheduled')}</option>
                </select>
              </div>
              {taskType === 'scheduled' && (
                <div>
                  <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.frequency')}</label>
                  <select value={taskScheduleEvery} onChange={e => setTaskScheduleEvery(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm focus:border-brand-500 outline-none">
                    <option value="30m">{t('work:task.freq30m')}</option>
                    <option value="1h">{t('work:task.freq1h')}</option>
                    <option value="2h">{t('work:task.freq2h')}</option>
                    <option value="4h">{t('work:task.freq4h')}</option>
                    <option value="8h">{t('work:task.freq8h')}</option>
                    <option value="12h">{t('work:task.freq12h')}</option>
                    <option value="1d">{t('work:task.freq1d')}</option>
                    <option value="1w">{t('work:task.freq1w')}</option>
                  </select>
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.blockedBy')}</label>
              <MultiSearchableSelect
                options={Object.values(board).flat()
                  .filter(tk => tk.status !== 'completed' && tk.status !== 'cancelled')
                  .map(tk => ({ value: tk.id, label: tk.title }))}
                selected={taskBlockedBy}
                onAdd={id => setTaskBlockedBy([...taskBlockedBy, id])}
                placeholder={t('work:task.selectDependency')}
                noMatchesText={t('work:task.noMatches')}
              />
              {taskBlockedBy.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {taskBlockedBy.map(id => {
                    const dep = Object.values(board).flat().find(tk => tk.id === id);
                    return (
                      <span key={id} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 bg-amber-500/10 text-amber-600 rounded-full">
                        {dep ? dep.title.slice(0, 30) : id.slice(-8)}
                        <button onClick={() => setTaskBlockedBy(taskBlockedBy.filter(x => x !== id))} className="ml-0.5 text-amber-600/60 hover:text-amber-600">×</button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            {taskCreateError && <div className="px-3 py-2 bg-red-500/15 text-red-500 text-xs rounded-lg">{taskCreateError}</div>}
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => { setShowCreateTask(false); setTaskCreateError(''); }} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary">{t('common:cancel')}</button>
              <button onClick={() => void createTask()} disabled={!taskTitle.trim() || !taskAssignTo || !taskReviewer} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-50">{t('common:create')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Requirement Modal ── */}
      {showCreateReq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={() => { setShowCreateReq(false); setReqTitle(''); setReqDesc(''); setReqCreateError(''); }}>
          <div className={`bg-surface-secondary border border-border-default rounded-xl p-6 space-y-4 max-h-[90dvh] overflow-y-auto ${isMobile ? 'w-full' : 'w-[28rem]'}`} onClick={e => e.stopPropagation()}>
            <div>
              <h3 className="text-base font-semibold text-fg-primary">{t('work:task.newRequirementModalTitle')}</h3>
              <p className="text-xs text-fg-tertiary mt-1">{t('work:task.newRequirementModalHint')}</p>
            </div>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.projectLabel')} <span className="text-red-500">*</span></label>
              <SearchableSelect
                options={projects.map(p => ({ value: p.id, label: p.name }))}
                value={reqProjectId}
                onChange={setReqProjectId}
                placeholder={t('work:task.selectProject')}
                noMatchesText={t('work:task.noMatches')}
              />
            </div>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.titleField')} <span className="text-red-500">*</span></label>
              <input value={reqTitle} onChange={e => setReqTitle(e.target.value)} placeholder={t('work:task.reqTitleExample')}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none" autoFocus={!isMobile}
                onKeyDown={e => { if (e.key === 'Enter' && reqTitle.trim()) void handleCreateReq(); }} />
            </div>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.descriptionField')} <span className="text-red-500">*</span></label>
              <textarea value={reqDesc} onChange={e => setReqDesc(e.target.value)} placeholder={t('work:task.reqDescPlaceholder')}
                rows={3} className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none resize-none" />
            </div>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.priorityField')}</label>
              <select value={reqPriority} onChange={e => setReqPriority(e.target.value)}
                className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none">
                <option value="low">{t('work:priority.low')}</option><option value="medium">{t('work:priority.medium')}</option><option value="high">{t('work:priority.high')}</option><option value="urgent">{t('work:priority.urgent')}</option>
              </select>
            </div>
            {reqCreateError && <div className="px-3 py-2 bg-red-500/15 text-red-500 text-xs rounded-lg">{reqCreateError}</div>}
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => { setShowCreateReq(false); setReqTitle(''); setReqDesc(''); setReqCreateError(''); }} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary">{t('common:cancel')}</button>
              <button onClick={() => void handleCreateReq()} disabled={!reqTitle.trim() || !reqDesc.trim() || !reqProjectId} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 rounded-lg text-white disabled:opacity-40 disabled:cursor-not-allowed">{t('common:create')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reject Requirement Modal ── */}
      {rejectReqId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={() => { setRejectReqId(null); setRejectReqError(''); }}>
          <div className={`bg-surface-secondary border border-border-default rounded-xl p-6 space-y-4 ${isMobile ? 'w-full' : 'w-96'}`} onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-fg-primary">{t('work:task.rejectRequirementTitle')}</h3>
            <div>
              <label className="block text-sm text-fg-secondary mb-1.5">{t('work:task.rejectReasonLabel')}</label>
              <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder={t('work:task.rejectReasonPlaceholder')}
                rows={3} className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-red-500 outline-none resize-none" autoFocus={!isMobile} />
            </div>
            {rejectReqError && <div className="px-3 py-2 bg-red-500/15 text-red-500 text-xs rounded-lg">{rejectReqError}</div>}
            <div className="flex justify-end gap-3">
              <button onClick={() => { setRejectReqId(null); setRejectReqError(''); }} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary">{t('common:cancel')}</button>
              <button onClick={() => void handleRejectReq()} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 rounded-lg text-white">{t('work:task.reject')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile Filter Bottom Sheet ── */}
      {showFilterSheet && (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end" onClick={() => setShowFilterSheet(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-surface-secondary rounded-t-2xl border-t border-border-default max-h-[70vh] overflow-y-auto pb-16" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 bg-surface-secondary z-10 px-4 pt-3 pb-2 flex items-center justify-between border-b border-border-default/60">
              <h3 className="text-sm font-semibold text-fg-primary">{t('work:task.filtersSheetTitle')}</h3>
              <div className="flex items-center gap-2">
                {(projectFilter.size > 0 || agentFilter.size > 0 || myTasksOnly) && (
                  <button onClick={() => { setProjectFilter(new Set()); setAgentFilter(new Set()); setMyTasksOnly(false); }}
                    className="text-[11px] text-brand-500 font-medium">{t('work:task.clearAll')}</button>
                )}
                <button onClick={() => setShowFilterSheet(false)}
                  className="w-7 h-7 flex items-center justify-center rounded-full bg-surface-elevated text-fg-tertiary">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            </div>
            {projects.length > 1 && (
              <div className="px-4 py-3">
                <div className="text-[11px] text-fg-tertiary font-medium uppercase tracking-wider mb-2">{t('work:task.projectsFilterGroup')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {sortedProjects.map(p => {
                    const selected = projectFilter.has(p.id);
                    const count = allTaskCounts[p.id] ?? 0;
                    return (
                      <div key={p.id} className={`flex items-center rounded-lg overflow-hidden transition-all ${selected ? 'bg-brand-500/15 ring-1 ring-brand-500/30' : ''}`}>
                        <button onClick={() => toggleProjectFilter(p.id)}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] transition-all ${
                            selected ? 'text-brand-600' : 'bg-surface-elevated text-fg-secondary'
                          }`}>
                          <span className={`w-4 h-4 rounded-sm flex items-center justify-center text-[9px] font-bold shrink-0 ${selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-tertiary'}`}>{p.name[0]?.toUpperCase()}</span>
                          {p.name}
                          {count > 0 && <span className="text-[9px] text-fg-tertiary">{count}</span>}
                        </button>
                        {selected && (
                          <button
                            onClick={() => { setShowFilterSheet(false); openProjectSettings(p.id); }}
                            className="px-2 py-1.5 self-stretch flex items-center border-l border-brand-500/20 text-fg-tertiary hover:text-brand-600"
                            title={t('work:project.editProject')}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {authUser?.id && (
              <div className="px-4 py-3 border-t border-border-default/40">
                <button
                  type="button"
                  onClick={() => setMyTasksOnly(v => !v)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] transition-all ${
                    myTasksOnly ? 'bg-green-600/20 text-green-500 ring-1 ring-green-500/40' : 'bg-surface-elevated text-fg-secondary'
                  }`}
                >
                  {t('work:task.myTasks')}
                </button>
              </div>
            )}
            {teamFilterItems.length > 0 && (
              <div className="px-4 py-3 border-t border-border-default/40">
                <div className="text-[11px] text-fg-tertiary font-medium uppercase tracking-wider mb-2">{t('work:task.agentsFilterGroup')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {teamFilterItems.map(item => {
                    if (item.kind === 'team') {
                      const selected = item.agentIds.every(id => agentFilter.has(id));
                      const partial = !selected && item.agentIds.some(id => agentFilter.has(id));
                      return (
                        <button key={`team-${item.id}`} onClick={() => {
                          setAgentFilter(prev => {
                            const next = new Set(prev);
                            if (selected) { for (const id of item.agentIds) next.delete(id); }
                            else { for (const id of item.agentIds) next.add(id); }
                            return next;
                          });
                        }}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-all ${
                            selected ? 'bg-brand-600/20 text-brand-500 ring-1 ring-brand-500/40'
                            : partial ? 'bg-brand-600/10 text-brand-400 ring-1 ring-brand-500/20'
                            : 'bg-surface-elevated text-fg-secondary'
                          }`}>
                          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                          {item.name}
                          <span className="text-[9px] text-fg-quaternary">{item.agentIds.length}</span>
                        </button>
                      );
                    }
                    const a = item.agent;
                    const selected = agentFilter.has(a.id);
                    return (
                      <button key={a.id} onClick={() => toggleAgentFilter(a.id)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-all ${
                          selected ? 'bg-brand-600/20 text-brand-500 ring-1 ring-brand-500/40' : 'bg-surface-elevated text-fg-secondary'
                        }`}>
                        <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-tertiary'}`}>{a.name[0]?.toUpperCase()}</span>
                        {a.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="h-[env(safe-area-inset-bottom,0px)]" />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Requirement Comment Thread ─────────────────────────────────────────────────

function RequirementCommentThread({ requirementId, createdBy, agents, users, authUser }: {
  requirementId: string;
  createdBy?: string;
  agents: AgentInfo[];
  users?: HumanUserInfo[];
  authUser?: { id: string; name: string };
}) {
  const { t } = useTranslation(['work', 'common']);
  const [comments, setComments] = useState<RequirementComment[]>([]);
  const [thinkingAgents, setThinkingAgents] = useState<Array<{ id: string; name: string; avatarUrl?: string }>>([]);
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [agentActivities, setAgentActivities] = useState<Map<string, ActivityStep[]>>(new Map());

  useEffect(() => {
    setThinkingAgents([]);
    setAgentActivities(new Map());
    if (thinkingTimeoutRef.current) { clearTimeout(thinkingTimeoutRef.current); thinkingTimeoutRef.current = null; }
    api.requirements.getComments(requirementId).then(r => setComments(r.comments)).catch(() => {});
  }, [requirementId]);

  useEffect(() => {
    const unsub = wsClient.on('requirement:comment', (msg: { payload?: { requirementId?: string; comment?: RequirementComment } }) => {
      if (msg.payload?.requirementId === requirementId && msg.payload.comment) {
        const c = msg.payload.comment;
        setComments(prev => {
          if (prev.some(x => x.id === c.id)) return prev;
          return [...prev, c];
        });
        if (c.authorType === 'agent' || c.authorId?.startsWith('agt_')) {
          setThinkingAgents(prev => {
            const next = prev.filter(a => a.id !== c.authorId);
            if (next.length === 0 && thinkingTimeoutRef.current) {
              clearTimeout(thinkingTimeoutRef.current);
              thinkingTimeoutRef.current = null;
            }
            return next;
          });
          setAgentActivities(prev => {
            const next = new Map(prev);
            next.delete(c.authorId);
            return next;
          });
        }
      }
    });
    return unsub;
  }, [requirementId]);

  useEffect(() => {
    if (thinkingAgents.length === 0) return;
    const thinkingIds = new Set(thinkingAgents.map(a => a.id));
    const unsub = wsClient.on('agent:activity_log', (event: { payload?: Record<string, unknown> }) => {
      const p = event.payload as Record<string, unknown> | undefined;
      if (!p) return;
      const agentId = p['agentId'] as string;
      if (!thinkingIds.has(agentId)) return;
      const evtType = p['type'] as string;
      if (evtType === 'tool_start' || evtType === 'tool_end') {
        const tool = (p['content'] as string) ?? (p['metadata'] as Record<string, unknown>)?.['tool'] as string ?? '';
        const step: ActivityStep = {
          tool,
          phase: evtType === 'tool_start' ? 'start' : 'end',
          success: evtType === 'tool_end' ? (p['metadata'] as Record<string, unknown>)?.['success'] !== false : undefined,
          ts: Date.now(),
        };
        setAgentActivities(prev => {
          const next = new Map(prev);
          const list = [...(next.get(agentId) ?? []), step];
          next.set(agentId, list);
          return next;
        });
      }
    });
    return unsub;
  }, [thinkingAgents]);

  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string; content: string } | null>(null);

  const handleSubmit = async (content: string, mentions: string[], images: PendingImage[], replyToId?: string) => {
    let attachments: Array<{ type: string; url: string; name: string }> | undefined;
    if (images.length > 0) {
      const uploaded = await api.uploads.upload(images.map(img => ({ dataUrl: img.dataUrl, name: img.name })), 'comments');
      attachments = uploaded.files.map(f => ({ type: 'image', url: f.url, name: f.name }));
    }
    await api.requirements.addComment(
      requirementId,
      content,
      authUser?.name,
      attachments,
      authUser?.id,
      mentions.length > 0 ? mentions : undefined,
      replyToId,
    );
    const notified: Array<{ id: string; name: string; avatarUrl?: string }> = [];
    const seen = new Set<string>();
    const tryAdd = (agentId: string) => {
      if (seen.has(agentId) || agentId === authUser?.id) return;
      seen.add(agentId);
      const a = agents.find(ag => ag.id === agentId);
      if (a) notified.push({ id: a.id, name: a.name, avatarUrl: a.avatarUrl });
    };
    for (const name of mentions) {
      const a = agents.find(ag => ag.name.toLowerCase() === name.toLowerCase());
      if (a) tryAdd(a.id);
    }
    if (createdBy?.startsWith('agt_')) tryAdd(createdBy);
    if (notified.length > 0) {
      if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current);
      setThinkingAgents(notified);
      thinkingTimeoutRef.current = setTimeout(() => setThinkingAgents([]), 120_000);
    }
  };

  const handleReply = useCallback((c: TaskComment | RequirementComment) => {
    setReplyTo({ id: c.id, authorName: c.authorName, content: c.content.slice(0, 100) });
  }, []);

  return (
    <div>
      <label className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-2 block">
        {comments.length > 0 ? t('work:task.commentsWithCount', { count: comments.length }) : t('work:task.comments')}
      </label>
      <div className="space-y-0.5 mb-3">
        {comments.length === 0 && (
          <p className="text-xs text-fg-tertiary text-center py-4">{t('work:task.noCommentsYet')}</p>
        )}
        {comments.map(c => (
          <CommentBubble key={c.id} comment={c} agents={agents} onReply={handleReply} />
        ))}
        {thinkingAgents.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            {thinkingAgents.map(a => {
              const activities = agentActivities.get(a.id) ?? [];
              return (
                <div
                  key={a.id}
                  className="px-2 py-1.5 rounded-lg cursor-pointer hover:bg-surface-elevated/60 transition-colors"
                  onClick={() => navBus.navigate(PAGE.TEAM, { agentId: a.id, profileTab: 'mind' })}
                >
                  <div className="flex items-center gap-2">
                    <div className="relative shrink-0">
                      <Avatar name={a.name} avatarUrl={a.avatarUrl} size={22} bgClass="bg-brand-500/15 text-brand-600" />
                      <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse ring-2 ring-surface-primary" />
                    </div>
                    <span className="text-xs font-medium text-fg-secondary">{a.name}</span>
                    {activities.length === 0 && (
                      <span className="flex items-center gap-0.5">
                        <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" />
                        <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.15s' }} />
                        <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0.3s' }} />
                      </span>
                    )}
                    <span className="text-[10px] text-fg-tertiary">{t('work:task.agentProcessing')}</span>
                    <span className="ml-auto text-[10px] text-fg-tertiary">→</span>
                  </div>
                  {activities.length > 0 && (
                    <div className="ml-8 mt-1">
                      <ActivityIndicator activities={activities} isActive={true} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <CommentInput agents={agents} humans={users} onSubmit={handleSubmit} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
    </div>
  );
}

// ─── Requirement Detail Modal ────────────────────────────────────────────────────

function RequirementDetailPanel({
  req, agents, projects, allTasks, users, onClose, onApprove, onReject, onCancel, onStatusChange, onRefresh, authUser, scrollToComments, onScrollToCommentsDone, onTaskClick, onCreateTask, onProjectClick, previewMode,
}: {
  req: RequirementInfo;
  agents: AgentInfo[];
  projects: ProjectInfo[];
  allTasks: TaskInfo[];
  users: HumanUserInfo[];
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onCancel: (id: string) => void;
  onStatusChange?: (id: string, status: string) => void;
  onRefresh?: () => void;
  authUser?: { id: string; name: string };
  scrollToComments?: boolean;
  onScrollToCommentsDone?: () => void;
  onTaskClick?: (task: TaskInfo) => void;
  onCreateTask?: (reqId: string, projectId?: string) => void;
  onProjectClick?: (projectId: string) => void;
  previewMode?: boolean;
}) {
  const { t } = useTranslation(['work', 'common']);
  const reqBadges = useMemo(() => buildReqStatusBadges(t), [t]);
  const subBadges = useMemo(() => buildSubStatusBadges(t), [t]);
  const isMobile = useIsMobile();
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(req.description);
  const [savingDesc, setSavingDesc] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showWorkflowModal, setShowWorkflowModal] = useState(false);
  const reqScrollRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<'top' | 'bottom' | 'middle' | 'none'>('none');
  const descRef = useRef<HTMLDivElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const descHeightRef = useRef(80);
  useEffect(() => {
    const el = reqScrollRef.current;
    if (!el) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const scrollable = scrollHeight > clientHeight + 50;
      if (!scrollable) { setScrollState('none'); return; }
      const atTop = scrollTop < 30;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 30;
      setScrollState(atTop ? 'top' : atBottom ? 'bottom' : 'middle');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);
  useEffect(() => {
    if (editingDesc && descTextareaRef.current) {
      const el = descTextareaRef.current;
      el.style.height = 'auto';
      el.style.height = Math.max(el.scrollHeight, descHeightRef.current) + 'px';
      el.focus();
    }
  }, [editingDesc]);

  useEffect(() => {
    if (!scrollToComments) return;
    const timer = setTimeout(() => {
      const el = reqScrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      onScrollToCommentsDone?.();
    }, 300);
    return () => clearTimeout(timer);
  }, [scrollToComments, onScrollToCommentsDone]);
  const badge = reqBadges[req.status] ?? { label: req.status, cls: 'bg-gray-500/15 text-fg-secondary' };
  const isAgent = req.source === 'agent';
  const needsReview = isAgent && req.status === 'pending';
  const canCancel = req.status === 'pending' || req.status === 'in_progress';
  const isTerminal = req.status === 'completed' || req.status === 'rejected' || req.status === 'cancelled' || req.status === 'archived';
  const reqProject = req.projectId ? projects.find(p => p.id === req.projectId) : null;
  const creatorName = resolveActorName(req.createdBy, agents, users) ?? req.createdBy.slice(0, 12);
  const linkedTasks = allTasks.filter(t => req.taskIds.includes(t.id));
  const reqTeamId = reqProject?.teamIds?.[0] ?? null;
  const linkedTaskMap = useMemo(() => new Map(linkedTasks.map(t => [t.id, t])), [linkedTasks]);
  const canSaveAsWorkflow = linkedTasks.length >= 2;

  useEffect(() => { setDescDraft(req.description); setEditingDesc(false); }, [req.id, req.description]);

  return (
    <div className="flex flex-col w-full h-full overflow-hidden bg-surface-primary shadow-xl shadow-black/8 ring-1 ring-border-default/20">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 p-5 pb-0 border-b border-border-default">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isMobile && (
            <button onClick={() => history.back()} className="text-fg-secondary hover:text-fg-primary transition-colors p-1 -ml-1 shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
          )}
          <h2 className="flex-1 min-w-0 pb-4 text-lg font-semibold text-fg-primary leading-snug">
            {req.title}
            {' '}
            <span className="text-[10px] font-bold text-brand-500 bg-brand-500/15 px-2 py-0.5 rounded align-middle">{t('work:task.requirementShort')}</span>
            {' '}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium align-middle ${badge.cls}`}>{badge.label}</span>
            {' '}
            {req.priority === 'high' || req.priority === 'urgent' ? (
              <span className={`text-[10px] font-medium align-middle ${req.priority === 'urgent' ? 'text-red-500' : 'text-amber-600'}`}>{t('common:priority.' + req.priority, { defaultValue: req.priority })}</span>
            ) : (
              <span className="text-[10px] text-fg-tertiary align-middle">{t('common:priority.' + req.priority, { defaultValue: req.priority })}</span>
            )}
          </h2>
        </div>
        <button onClick={onClose} className="text-fg-tertiary hover:text-fg-secondary text-xl leading-none shrink-0 mt-1">&times;</button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 relative">
      <div ref={reqScrollRef} className="h-full overflow-y-auto p-5 space-y-4">
          <div>
            <label className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-1 block">{t('work:task.requirementDetailDescription')}</label>
            {editingDesc ? (
              <textarea
                ref={descTextareaRef}
                value={descDraft}
                onChange={e => {
                  setDescDraft(e.target.value);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = el.scrollHeight + 'px';
                }}
                onBlur={async () => {
                  if (descDraft !== req.description) {
                    setSavingDesc(true);
                    try {
                      await api.requirements.update(req.id, { description: descDraft });
                      onRefresh?.();
                    } catch { /* keep editing */ }
                    finally { setSavingDesc(false); }
                  }
                  setEditingDesc(false);
                }}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setDescDraft(req.description);
                    setEditingDesc(false);
                  }
                }}
                className="w-full bg-transparent border border-brand-500/30 rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none resize-none -mx-2 px-2 -my-1 py-1"
                placeholder={t('work:task.requirementDetailDescription')}
              />
            ) : (
              <div
                ref={descRef}
                className={`group relative rounded-lg -mx-2 px-2 -my-1 py-1 transition-colors ${!isTerminal ? 'cursor-pointer hover:bg-surface-elevated/50' : ''}`}
                onClick={!isTerminal ? (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest('a, button, [data-entity-link]')) return; descHeightRef.current = Math.max(descRef.current?.offsetHeight ?? 80, 60); setDescDraft(req.description); setEditingDesc(true); } : undefined}
                role={!isTerminal ? 'button' : undefined}
                tabIndex={!isTerminal ? 0 : undefined}
                onKeyDown={!isTerminal ? e => e.key === 'Enter' && (setDescDraft(req.description), setEditingDesc(true)) : undefined}
              >
                {req.description ? (
                  <MarkdownMessage content={req.description} className="text-sm text-fg-secondary leading-relaxed" />
                ) : (
                  <p className="text-sm text-fg-tertiary italic">{t('work:task.requirementNoDescription')}</p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-surface-elevated/60 rounded-lg p-2.5">
              <span className="text-[10px] text-fg-tertiary block mb-1">{t('work:task.createdByLabel')}</span>
              <span className="text-fg-secondary">{creatorName}</span>
              {isAgent && <span className="text-[10px] text-brand-500 ml-1.5">{t('work:task.agentTag')}</span>}
            </div>
            <div className="bg-surface-elevated/60 rounded-lg p-2.5">
              <span className="text-[10px] text-fg-tertiary block mb-1">{t('work:task.createdLabel')}</span>
              <span className="text-fg-secondary">{new Date(req.createdAt).toLocaleString()}</span>
            </div>
            {reqProject && (
              <div
                className={`bg-surface-elevated/60 rounded-lg p-2.5 ${onProjectClick ? 'cursor-pointer hover:bg-surface-elevated transition-colors' : ''}`}
                onClick={onProjectClick ? () => onProjectClick(reqProject.id) : undefined}
                role={onProjectClick ? 'button' : undefined}
                tabIndex={onProjectClick ? 0 : undefined}
                onKeyDown={onProjectClick ? e => e.key === 'Enter' && onProjectClick(reqProject.id) : undefined}
              >
                <span className="text-[10px] text-fg-tertiary block mb-1">{t('work:task.projectLabel')}</span>
                <span className="text-fg-secondary">{reqProject.name}</span>
              </div>
            )}
            {req.approvedBy && (
              <div className="bg-surface-elevated/60 rounded-lg p-2.5">
                <span className="text-[10px] text-fg-tertiary block mb-1">{t('work:task.approvedBy')}</span>
                <span className="text-fg-secondary">{resolveActorName(req.approvedBy, agents, users) ?? req.approvedBy.slice(0, 12)}</span>
                {req.approvedAt && <span className="text-[10px] text-fg-tertiary ml-1">{new Date(req.approvedAt).toLocaleDateString()}</span>}
              </div>
            )}
          </div>

          {req.rejectedReason && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wider block mb-1">{t('work:task.rejectionReason')}</span>
              <p className="text-sm text-red-500/80">{req.rejectedReason}</p>
            </div>
          )}

          {Array.isArray(req.tags) && req.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {req.tags.map(tag => <span key={tag} className="text-[10px] bg-surface-elevated text-fg-secondary px-2 py-0.5 rounded-full">#{tag}</span>)}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider">{t('work:task.linkedTasks', { count: linkedTasks.length })}</label>
              <div className="flex items-center gap-2">
                {canSaveAsWorkflow && reqTeamId && (
                  <button onClick={() => setShowWorkflowModal(true)} className="text-[11px] text-brand-500 hover:text-brand-400 font-medium flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    {t('work:task.saveAsWorkflow')}
                  </button>
                )}
                {!isTerminal && onCreateTask && (
                  <button onClick={() => onCreateTask(req.id, req.projectId)} className="text-[11px] text-amber-500 hover:text-amber-400 font-medium flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    {t('work:requirement.createTask')}
                  </button>
                )}
              </div>
            </div>
            {linkedTasks.length > 0 ? (() => {
              const taskMap = new Map(linkedTasks.map(t => [t.id, t]));
              const hasDeps = linkedTasks.some(t => t.blockedBy?.some(id => taskMap.has(id)));
              if (!hasDeps) {
                return (
                  <div className="space-y-1.5">
                    {linkedTasks.map(lt => {
                      const sb = subBadges[lt.status];
                      return (
                        <div key={lt.id} onClick={() => onTaskClick?.(lt)} className={`flex items-center gap-2 bg-surface-elevated/60 rounded-lg px-3 py-2 ${onTaskClick ? 'cursor-pointer hover:bg-surface-elevated transition-colors' : ''}`}>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[lt.status] ?? 'bg-gray-500'}`} />
                          <span className="text-xs text-fg-secondary flex-1 truncate">{lt.title}</span>
                          {sb && <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${sb.cls}`}>{sb.label}</span>}
                        </div>
                      );
                    })}
                  </div>
                );
              }
              const childrenOf = new Map<string, string[]>();
              const hasParent = new Set<string>();
              for (const t of linkedTasks) {
                for (const dep of t.blockedBy ?? []) {
                  if (taskMap.has(dep)) {
                    hasParent.add(t.id);
                    const arr = childrenOf.get(dep) ?? [];
                    arr.push(t.id);
                    childrenOf.set(dep, arr);
                  }
                }
              }
              const roots = linkedTasks.filter(t => !hasParent.has(t.id));
              const renderNode = (task: TaskInfo, depth: number): React.ReactNode => {
                const sb = subBadges[task.status];
                const children = (childrenOf.get(task.id) ?? []).map(id => taskMap.get(id)!).filter(Boolean);
                return (
                  <div key={task.id}>
                    <div
                      onClick={() => onTaskClick?.(task)}
                      className={`flex items-center gap-2 bg-surface-elevated/60 rounded-lg px-3 py-2 ${onTaskClick ? 'cursor-pointer hover:bg-surface-elevated transition-colors' : ''}`}
                      style={depth > 0 ? { marginLeft: depth * 20 } : undefined}
                    >
                      {depth > 0 && <span className="text-fg-quaternary text-[10px] shrink-0">↳</span>}
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[task.status] ?? 'bg-gray-500'}`} />
                      <span className="text-xs text-fg-secondary flex-1 truncate">{task.title}</span>
                      {sb && <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${sb.cls}`}>{sb.label}</span>}
                    </div>
                    {children.map(c => renderNode(c, depth + 1))}
                  </div>
                );
              };
              return <div className="space-y-1.5">{roots.map(r => renderNode(r, 0))}</div>;
            })() : (
              <div className="text-xs text-fg-tertiary italic py-2">{t('work:requirement.noLinkedTasks')}</div>
            )}
          </div>

          {/* Requirement Comments Thread */}
          {!previewMode && <RequirementCommentThread requirementId={req.id} createdBy={req.createdBy} agents={agents} users={users} authUser={authUser} />}

          {/* Status History */}
          {!previewMode && <StatusHistoryTimeline entityType="requirement" entityId={req.id} />}
        </div>
        {scrollState !== 'none' && scrollState !== 'top' && (
          <button
            onClick={() => reqScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            className="absolute bottom-20 right-4 md:bottom-14 md:right-3 z-10 w-12 h-12 md:w-8 md:h-8 rounded-full bg-brand-500 md:bg-brand-600/90 border border-brand-400/60 shadow-xl shadow-brand-500/30 md:shadow-lg md:shadow-brand-500/20 flex items-center justify-center text-white hover:bg-brand-400 transition-colors backdrop-blur-sm"
            title={t('work:task.scrollToTop')}
          >
            <svg className="w-6 h-6 md:w-4 md:h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832l-3.71 3.938a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clipRule="evenodd" /></svg>
          </button>
        )}
        {scrollState !== 'none' && scrollState !== 'bottom' && (
          <button
            onClick={() => { const el = reqScrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }}
            className="absolute bottom-6 right-4 md:bottom-4 md:right-3 z-10 w-12 h-12 md:w-8 md:h-8 rounded-full bg-brand-500 md:bg-brand-600/90 border border-brand-400/60 shadow-xl shadow-brand-500/30 md:shadow-lg md:shadow-brand-500/20 flex items-center justify-center text-white hover:bg-brand-400 transition-colors backdrop-blur-sm"
            title={t('work:task.scrollToBottom')}
          >
            <svg className="w-6 h-6 md:w-4 md:h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
          </button>
        )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 p-5 pt-3 border-t border-border-default">
          {needsReview && (
            <>
              <button onClick={() => onApprove(req.id)} className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg font-medium transition-colors">{t('work:requirement.approveRequirement')}</button>
              <button onClick={() => onReject(req.id)} className="px-4 py-2 border border-red-500/30 hover:bg-red-500/10 text-red-500 text-sm rounded-lg font-medium transition-colors">{t('work:requirement.rejectRequirement')}</button>
            </>
          )}
          {!needsReview && onStatusChange && !isTerminal && (
            <select
              value={req.status}
              onChange={e => { if (e.target.value !== req.status) onStatusChange(req.id, e.target.value); }}
              className="px-2 py-1.5 text-xs bg-surface-elevated border border-border-default rounded-lg text-fg-secondary cursor-pointer hover:border-gray-500 transition-colors"
            >
              {ALL_REQ_STATUSES.map(s => {
                const b = reqBadges[s];
                const allowed = s === req.status || (REQ_ALLOWED_TRANSITIONS[req.status]?.has(s) ?? false);
                return <option key={s} value={s} disabled={!allowed}>{b?.label ?? s}</option>;
              })}
            </select>
          )}
          {isTerminal && onStatusChange && (
            <button onClick={() => onStatusChange(req.id, 'in_progress')} className="px-3 py-1.5 text-xs border border-border-default hover:bg-surface-elevated rounded-lg text-fg-secondary transition-colors">{t('work:task.reopen')}</button>
          )}
          <div className="flex-1" />
          {canCancel && !needsReview && (
            <button onClick={() => setShowCancelConfirm(true)} className="px-3 py-1.5 text-xs text-red-500/70 hover:text-red-500 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 rounded-lg transition-colors">{t('work:task.cancelRequirement')}</button>
          )}
        </div>
      {showCancelConfirm && (
        <ConfirmModal
          title={t('work:requirement.cancelConfirmTitle', 'Cancel Requirement')}
          message={t('work:requirement.cancelConfirmMessage', 'Are you sure you want to cancel this requirement? This action cannot be undone.')}
          confirmLabel={t('work:requirement.cancelConfirmLabel', 'Cancel Requirement')}
          onConfirm={() => { setShowCancelConfirm(false); onCancel(req.id); }}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
      {showWorkflowModal && reqTeamId && (
        <SaveAsWorkflowModal
          req={req}
          tasks={linkedTasks}
          agents={agents}
          teamId={reqTeamId}
          onClose={() => setShowWorkflowModal(false)}
          onSaved={() => setShowWorkflowModal(false)}
        />
      )}
    </div>
  );
}

// ─── Shared mini-components ─────────────────────────────────────────────────────

function StatusHistoryTimeline({ entityType, entityId }: { entityType: 'task' | 'requirement'; entityId: string }) {
  const { t } = useTranslation(['work']);
  const [history, setHistory] = useState<StatusTransitionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    const fetcher = entityType === 'task' ? api.tasks.getHistory : api.requirements.getHistory;
    fetcher(entityId).then(r => setHistory(r.history)).catch(() => setHistory([])).finally(() => setLoading(false));
  }, [entityType, entityId]);

  if (loading) return <div className="px-6 py-4 text-xs text-fg-tertiary">{t('work:task.loadingHistory', 'Loading history...')}</div>;
  if (history.length === 0) return <div className="px-6 py-4 text-xs text-fg-tertiary italic">{t('work:task.noHistory', 'No status change history.')}</div>;

  const visible = expanded ? history : history.slice(-5);
  const hasMore = history.length > 5 && !expanded;

  const actorBadge = (h: StatusTransitionInfo) => {
    const label = h.changedByName || h.changedById || (h.changedByType === 'human' ? 'User' : h.changedByType === 'agent' ? 'Agent' : 'System');
    const cls = h.changedByType === 'human' ? 'bg-blue-500/20 text-blue-500' : h.changedByType === 'agent' ? 'bg-brand-500/20 text-brand-500' : 'bg-gray-500/20 text-fg-tertiary';
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${cls}`}>{label}</span>;
  };

  return (
    <div className="px-6 py-4">
      <p className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider mb-3">{t('work:task.statusHistory', 'Status History')}</p>
      {hasMore && (
        <button onClick={() => setExpanded(true)} className="text-[11px] text-brand-500 hover:underline mb-2">
          {t('work:task.showAllHistory', { count: history.length })}
        </button>
      )}
      <div className="relative ml-2">
        <div className="absolute left-[2.5px] top-1 bottom-1 w-px bg-border-default" />
        <div className="space-y-3">
          {visible.map((h) => (
            <div key={h.id} className="flex items-start gap-3 relative">
              <div className="w-1.5 h-1.5 rounded-full mt-[7px] shrink-0 relative z-10" style={{ background: h.changedByType === 'human' ? '#3b82f6' : h.changedByType === 'agent' ? 'var(--color-brand-500)' : '#6b7280' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {actorBadge(h)}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-elevated text-fg-tertiary line-through">{h.fromStatus}</span>
                  <span className="text-[10px] text-fg-tertiary">→</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/15 text-brand-500 font-medium">{h.toStatus}</span>
                </div>
                {h.reason && <p className="text-[10px] text-fg-secondary mt-0.5 leading-snug">{h.reason}</p>}
                <p className="text-[9px] text-fg-tertiary mt-0.5">{new Date(h.createdAt).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500/10 text-green-600', planning: 'bg-blue-500/10 text-blue-600',
    review: 'bg-amber-500/10 text-amber-600', completed: 'bg-surface-overlay text-fg-secondary',
    archived: 'bg-surface-elevated text-fg-tertiary', paused: 'bg-amber-500/10 text-amber-600',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[status] ?? 'bg-surface-overlay text-fg-secondary'}`}>{status}</span>
  );
}
