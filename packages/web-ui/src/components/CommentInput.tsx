import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { AgentInfo } from '../api.ts';

function MentionDropdown({ agents, filter, anchorRef, onSelect, selectedIndex, onIndexChange }: {
  agents: AgentInfo[];
  filter: string;
  anchorRef: React.RefObject<HTMLTextAreaElement | null>;
  onSelect: (agent: AgentInfo) => void;
  selectedIndex: number;
  onIndexChange: (index: number) => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filtered = agents.filter(a => a.name.toLowerCase().includes(filter));

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.top + window.scrollY - 4, left: rect.left + window.scrollX + 8 });
  }, [anchorRef, filter]);

  useEffect(() => {
    if (!dropdownRef.current || !pos) return;
    const rect = dropdownRef.current.getBoundingClientRect();
    if (rect.top < 8) {
      const el = anchorRef.current;
      if (!el) return;
      const inputRect = el.getBoundingClientRect();
      setPos({ top: inputRect.bottom + window.scrollY + 4, left: pos.left });
    }
  }, [pos, anchorRef]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) onIndexChange(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIndex, onIndexChange]);

  useEffect(() => {
    if (!dropdownRef.current) return;
    const selected = dropdownRef.current.querySelector('[data-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!pos || filtered.length === 0) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      style={{ position: 'absolute', top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
      className="w-60 bg-surface-overlay border border-border-default rounded-lg shadow-xl z-[9999] max-h-48 overflow-y-auto"
    >
      <div className="px-2.5 py-1.5 text-[10px] text-fg-tertiary font-medium uppercase tracking-wider border-b border-border-default">
        Mention an agent
      </div>
      {filtered.map((a, i) => (
        <button
          key={a.id}
          data-selected={i === selectedIndex}
          onMouseDown={e => { e.preventDefault(); onSelect(a); }}
          onMouseEnter={() => onIndexChange(i)}
          className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
            i === selectedIndex ? 'bg-brand-500/15 text-brand-500' : 'hover:bg-surface-elevated'
          }`}
        >
          <span className="w-6 h-6 rounded-full bg-brand-500/20 flex items-center justify-center text-[10px] font-bold text-brand-500 shrink-0">
            {a.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-fg-primary font-medium">{a.name}</span>
            <span className="text-fg-tertiary text-[10px] ml-1.5">{a.role}</span>
          </div>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.status === 'idle' || a.status === 'working' ? 'bg-green-400' : 'bg-gray-500'}`} />
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** Format a mention for insertion into text. Brackets are used for names containing non-ASCII or special characters. */
function formatMention(name: string): string {
  return /^\w+$/.test(name) ? `@${name}` : `@[${name}]`;
}

/** Mention regex: matches `@[Name]` (bracketed, any characters) or `@Name` (Unicode-aware word chars). */
const MENTION_RE = /@\[([^\]]+)\]|@([\w\p{L}\p{N}]+)/gu;

/** Parse mention tokens from raw text. Supports both `@Name` and `@[Name With Spaces]`. */
export function parseMentionNames(text: string): string[] {
  const result: string[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    result.push(m[1] ?? m[2]!);
  }
  return result;
}

/**
 * Render text with @mentions highlighted.
 * Supports both `@Name` and `@[Name With Spaces]`.
 * Returns an array of React elements with mentions styled as clickable spans.
 */
export function renderMentionText(
  text: string,
  agents: AgentInfo[],
  onMentionClick?: (agent: AgentInfo) => void,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, m.index)}</span>);
    }
    const name = m[1] ?? m[2]!;
    const agent = agents.find(a => a.name.toLowerCase() === name.toLowerCase());
    parts.push(
      <span
        key={key++}
        className={`text-brand-500 font-medium ${onMentionClick && agent ? 'cursor-pointer hover:underline' : ''}`}
        onClick={onMentionClick && agent ? () => onMentionClick(agent) : undefined}
        title={agent ? `${agent.name} (${agent.role})` : undefined}
      >
        @{name}
      </span>,
    );
    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }

  return parts.length > 0 ? parts : [<span key={0}>{text}</span>];
}

export function CommentInput({ agents, onSubmit, placeholder }: {
  agents: AgentInfo[];
  onSubmit: (content: string, mentions: string[]) => Promise<void>;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [selectedMentions, setSelectedMentions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastSubmitRef = useRef<{ content: string; mentions: string[] } | null>(null);

  const filteredAgents = agents.filter(a => a.name.toLowerCase().includes(mentionFilter));

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    lastSubmitRef.current = { content: text, mentions: [...selectedMentions] };
    try {
      await onSubmit(text, selectedMentions);
      setText('');
      setSelectedMentions([]);
      lastSubmitRef.current = null;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e) || 'Failed to send comment');
    }
    setSending(false);
  };

  const handleRetry = async () => {
    if (!lastSubmitRef.current) return;
    const { content, mentions } = lastSubmitRef.current;
    setSending(true);
    setError(null);
    try {
      await onSubmit(content, mentions);
      setText('');
      setSelectedMentions([]);
      lastSubmitRef.current = null;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e) || 'Failed to send comment');
    }
    setSending(false);
  };

  const insertMention = useCallback((agent: AgentInfo) => {
    setText(prev => {
      const atIdx = prev.lastIndexOf('@');
      const mention = formatMention(agent.name);
      return atIdx >= 0 ? prev.slice(0, atIdx) + mention + ' ' : prev + mention + ' ';
    });
    if (!selectedMentions.includes(agent.id)) {
      setSelectedMentions(prev => [...prev, agent.id]);
    }
    setShowMentions(false);
    setMentionFilter('');
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, [selectedMentions]);

  const handleInputChange = (value: string) => {
    setText(value);
    setError(null);
    const atIdx = value.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || value[atIdx - 1] === ' ')) {
      const query = value.slice(atIdx + 1);
      const lowerQuery = query.toLowerCase();
      const hasMatch = agents.some(a => a.name.toLowerCase().includes(lowerQuery));
      if (hasMatch) {
        setMentionFilter(lowerQuery);
        setShowMentions(true);
        setSelectedIndex(0);
        return;
      }
    }
    setShowMentions(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions && filteredAgents.length > 0) {
      const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
      const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
      const isSelect = e.key === 'Enter' || e.key === 'Tab';
      const isClose = e.key === 'Escape';

      if (isUp) {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredAgents.length) % filteredAgents.length);
        return;
      }
      if (isDown) {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredAgents.length);
        return;
      }
      if (isSelect) {
        e.preventDefault();
        const agent = filteredAgents[selectedIndex];
        if (agent) insertMention(agent);
        return;
      }
      if (isClose) {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleBlur = useCallback(() => {
    setTimeout(() => setShowMentions(false), 200);
  }, []);

  return (
    <div className="relative">
      {showMentions && (
        <MentionDropdown
          agents={agents}
          filter={mentionFilter}
          anchorRef={inputRef}
          onSelect={insertMention}
          selectedIndex={selectedIndex}
          onIndexChange={setSelectedIndex}
        />
      )}

      <div className="border border-border-default rounded-lg bg-surface-elevated">
        {selectedMentions.length > 0 && (
          <div className="flex gap-1 px-2.5 pt-2 flex-wrap">
            {selectedMentions.map(mid => {
              const a = agents.find(ag => ag.id === mid);
              return (
                <span key={mid} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-brand-500/15 text-brand-500 rounded-full">
                  @{a?.name ?? mid}
                  <button onClick={() => setSelectedMentions(prev => prev.filter(x => x !== mid))} className="hover:text-red-400">×</button>
                </span>
              );
            })}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={text}
          onChange={e => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={placeholder ?? 'Add a comment… (type @ to mention an agent)'}
          rows={2}
          className="w-full px-2.5 py-2 text-xs bg-transparent text-fg-primary placeholder-fg-tertiary outline-none resize-none"
        />
        {error && (
          <div className="flex items-center gap-2 px-2.5 pb-1.5">
            <span className="text-[11px] text-red-400 flex-1 truncate">{error}</span>
            <button
              onClick={handleRetry}
              disabled={sending}
              className="text-[11px] text-amber-500 hover:text-amber-400 font-medium transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
              Retry
            </button>
          </div>
        )}
        <div className="flex justify-end px-2.5 pb-2">
          <button
            onClick={handleSend}
            disabled={!text.trim() || sending}
            className="px-3 py-1 text-[11px] font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? 'Sending…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  );
}
