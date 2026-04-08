import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { AgentInfo } from '../api.ts';

function MentionDropdown({ agents, filter, anchorRef, onSelect }: {
  agents: AgentInfo[];
  filter: string;
  anchorRef: React.RefObject<HTMLTextAreaElement | null>;
  onSelect: (agent: AgentInfo) => void;
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
      {filtered.map(a => (
        <button
          key={a.id}
          onMouseDown={e => { e.preventDefault(); onSelect(a); }}
          className="w-full text-left px-3 py-2 text-xs hover:bg-surface-elevated flex items-center gap-2 transition-colors"
        >
          <span className="w-6 h-6 rounded-full bg-brand-500/20 flex items-center justify-center text-[10px] font-bold text-brand-500 shrink-0">
            {a.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-fg-primary font-medium">{a.name}</span>
            <span className="text-fg-tertiary text-[10px] ml-1.5">{a.roleName}</span>
          </div>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.status === 'idle' || a.status === 'working' ? 'bg-green-400' : 'bg-gray-500'}`} />
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function CommentInput({ agents, onSubmit, placeholder }: {
  agents: AgentInfo[];
  onSubmit: (content: string, mentions: string[]) => Promise<void>;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [selectedMentions, setSelectedMentions] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await onSubmit(text, selectedMentions);
      setText('');
      setSelectedMentions([]);
    } catch { /* ignore */ }
    setSending(false);
  };

  const insertMention = useCallback((agent: AgentInfo) => {
    setText(prev => {
      const atIdx = prev.lastIndexOf('@');
      const mention = `@${agent.name}`;
      return atIdx >= 0 ? prev.slice(0, atIdx) + mention + ' ' : prev + mention + ' ';
    });
    if (!selectedMentions.includes(agent.id)) {
      setSelectedMentions(prev => [...prev, agent.id]);
    }
    setShowMentions(false);
    setMentionFilter('');
    inputRef.current?.focus();
  }, [selectedMentions]);

  const handleInputChange = (value: string) => {
    setText(value);
    const atIdx = value.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || value[atIdx - 1] === ' ')) {
      const query = value.slice(atIdx + 1);
      if (!query.includes(' ')) {
        setMentionFilter(query.toLowerCase());
        setShowMentions(true);
        return;
      }
    }
    setShowMentions(false);
  };

  // Close dropdown on blur (with small delay for click to register)
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
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          onBlur={handleBlur}
          placeholder={placeholder ?? 'Add a comment… (type @ to mention an agent)'}
          rows={2}
          className="w-full px-2.5 py-2 text-xs bg-transparent text-fg-primary placeholder-fg-tertiary outline-none resize-none"
        />
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
