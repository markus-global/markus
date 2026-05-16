import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AgentInfo, HumanUserInfo } from '../api.ts';

// ── Image compression ─────────────────────────────────────────────────────────
const MAX_IMAGE_DIM = 1920;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;
const IMAGE_QUALITY = 0.8;

function compressImage(dataUrl: string, maxDim: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width <= maxDim && height <= maxDim) {
        resolve(dataUrl);
        return;
      }
      if (width > height) {
        height = Math.round(height * (maxDim / width));
        width = maxDim;
      } else {
        width = Math.round(width * (maxDim / height));
        height = maxDim;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Failed to get canvas context')); return; }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

export interface PendingImage {
  id: string;
  dataUrl: string;
  name: string;
}

export interface MentionCandidate {
  id: string;
  name: string;
  type: 'agent' | 'human';
  subtitle?: string;
  online?: boolean;
}

function MentionDropdown({ candidates, filter, anchorRef, onSelect, selectedIndex, onIndexChange }: {
  candidates: MentionCandidate[];
  filter: string;
  anchorRef: React.RefObject<HTMLTextAreaElement | null>;
  onSelect: (c: MentionCandidate) => void;
  selectedIndex: number;
  onIndexChange: (index: number) => void;
}) {
  const { t } = useTranslation('common');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filtered = candidates.filter(c => c.name.toLowerCase().includes(filter));

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
        {t('commentInput.mentionHeading')}
      </div>
      {filtered.map((c, i) => (
        <button
          key={c.id}
          data-selected={i === selectedIndex}
          onMouseDown={e => { e.preventDefault(); onSelect(c); }}
          onMouseEnter={() => onIndexChange(i)}
          className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
            i === selectedIndex ? 'bg-brand-500/15 text-brand-500' : 'hover:bg-surface-elevated'
          }`}
        >
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
            c.type === 'human' ? 'bg-green-500/20 text-green-500' : 'bg-brand-500/20 text-brand-500'
          }`}>
            {c.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-fg-primary font-medium">{c.name}</span>
            <span className="text-fg-tertiary text-[10px] ml-1.5">{c.subtitle ?? c.type}</span>
          </div>
          {c.type === 'agent' && (
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.online ? 'bg-green-400' : 'bg-gray-500'}`} />
          )}
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
  onMentionClick?: (agent: AgentInfo, event: React.MouseEvent) => void,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let key = 0;

  const sortedNames = agents.map(a => a.name).sort((a, b) => b.length - a.length);

  let idx = 0;
  while (idx < text.length) {
    const atPos = text.indexOf('@', idx);
    if (atPos < 0) {
      parts.push(<span key={key++}>{text.slice(idx)}</span>);
      break;
    }

    if (atPos > idx) {
      parts.push(<span key={key++}>{text.slice(idx, atPos)}</span>);
    }

    // Try bracketed syntax: @[Name With Spaces]
    if (text[atPos + 1] === '[') {
      const close = text.indexOf(']', atPos + 2);
      if (close > atPos + 2) {
        const bracketed = text.slice(atPos + 2, close);
        const agent = agents.find(a => a.name.toLowerCase() === bracketed.toLowerCase());
        parts.push(
          <span
            key={key++}
            className={`text-brand-500 font-medium ${onMentionClick && agent ? 'cursor-pointer hover:underline' : ''}`}
            onClick={onMentionClick && agent ? (e: React.MouseEvent) => onMentionClick(agent, e) : undefined}
            title={agent ? `${agent.name} (${agent.role})` : undefined}
          >
            @{bracketed}
          </span>,
        );
        idx = close + 1;
        continue;
      }
    }

    // Try full name prefix match (handles multi-word names like "Markus Platform Dev Manager")
    const after = text.slice(atPos + 1);
    const afterLower = after.toLowerCase();
    const fullMatch = sortedNames.find(n => afterLower.startsWith(n.toLowerCase()));
    if (fullMatch) {
      const agent = agents.find(a => a.name.toLowerCase() === fullMatch.toLowerCase());
      parts.push(
        <span
          key={key++}
          className={`text-brand-500 font-medium ${onMentionClick && agent ? 'cursor-pointer hover:underline' : ''}`}
          onClick={onMentionClick && agent ? (e: React.MouseEvent) => onMentionClick(agent, e) : undefined}
          title={agent ? `${agent.name} (${agent.role})` : undefined}
        >
          @{fullMatch}
        </span>,
      );
      idx = atPos + 1 + fullMatch.length;
      continue;
    }

    // Fallback: single-token match via regex
    const tokenRe = /^([\w\p{L}\p{N}]+)/u;
    const tokenMatch = after.match(tokenRe);
    if (tokenMatch) {
      const name = tokenMatch[1]!;
      const agent = agents.find(a => a.name.toLowerCase() === name.toLowerCase());
      parts.push(
        <span
          key={key++}
          className={`text-brand-500 font-medium ${onMentionClick && agent ? 'cursor-pointer hover:underline' : ''}`}
          onClick={onMentionClick && agent ? (e: React.MouseEvent) => onMentionClick(agent, e) : undefined}
          title={agent ? `${agent.name} (${agent.role})` : undefined}
        >
          @{name}
        </span>,
      );
      idx = atPos + 1 + name.length;
      continue;
    }

    parts.push(<span key={key++}>@</span>);
    idx = atPos + 1;
  }

  return parts.length > 0 ? parts : [<span key={0}>{text}</span>];
}

export interface ReplyQuote {
  id: string;
  authorName: string;
  content: string;
}

export function CommentInput({ agents, humans, onSubmit, placeholder, replyTo, onCancelReply }: {
  agents: AgentInfo[];
  humans?: HumanUserInfo[];
  onSubmit: (content: string, mentions: string[], images: PendingImage[], replyToId?: string) => Promise<void>;
  placeholder?: string;
  replyTo?: ReplyQuote | null;
  onCancelReply?: () => void;
}) {
  const { t } = useTranslation('common');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [selectedMentions, setSelectedMentions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSubmitRef = useRef<{ content: string; mentions: string[]; images: PendingImage[] } | null>(null);

  const candidates: MentionCandidate[] = useMemo(() => {
    const list: MentionCandidate[] = (humans ?? []).map(h => ({
      id: h.id, name: h.name, type: 'human' as const, subtitle: h.role,
    }));
    for (const a of agents) {
      list.push({
        id: a.id, name: a.name, type: 'agent' as const, subtitle: a.role,
        online: a.status === 'idle' || a.status === 'working',
      });
    }
    return list;
  }, [agents, humans]);

  const filteredCandidates = candidates.filter(c => c.name.toLowerCase().includes(mentionFilter));

  // ── Image handling ───────────────────────────────────────────────────────────
  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (fileArr.length === 0) return;
    for (const file of fileArr) {
      if (file.size > MAX_FILE_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        compressImage(dataUrl, MAX_IMAGE_DIM, IMAGE_QUALITY).then(compressed => {
          setPendingImages(p => {
            if (p.length >= MAX_FILES) return p;
            return [...p, { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, dataUrl: compressed, name: file.name }];
          });
        });
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const images = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (images.length > 0) {
        e.preventDefault();
        addFiles(images);
      }
    }
  }, [addFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      addFiles(Array.from(files).filter(f => f.type.startsWith('image/')));
    }
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleSend = async () => {
    if (!text.trim() && pendingImages.length === 0) return;
    setSending(true);
    setError(null);
    lastSubmitRef.current = { content: text, mentions: [...selectedMentions], images: [...pendingImages] };
    try {
      await onSubmit(text, selectedMentions, [...pendingImages], replyTo?.id);
      setText('');
      setSelectedMentions([]);
      setPendingImages([]);
      lastSubmitRef.current = null;
      onCancelReply?.();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e) || t('commentInput.sendFailed'));
    }
    setSending(false);
  };

  const handleRetry = async () => {
    if (!lastSubmitRef.current) return;
    const { content, mentions, images } = lastSubmitRef.current;
    setSending(true);
    setError(null);
    try {
      await onSubmit(content, mentions, images);
      setText('');
      setSelectedMentions([]);
      setPendingImages([]);
      lastSubmitRef.current = null;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e) || t('commentInput.sendFailed'));
    }
    setSending(false);
  };

  const insertMention = useCallback((c: MentionCandidate) => {
    setText(prev => {
      const atIdx = prev.lastIndexOf('@');
      const mention = formatMention(c.name);
      return atIdx >= 0 ? prev.slice(0, atIdx) + mention + ' ' : prev + mention + ' ';
    });
    if (!selectedMentions.includes(c.id)) {
      setSelectedMentions(prev => [...prev, c.id]);
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
      const hasMatch = candidates.some(c => c.name.toLowerCase().includes(lowerQuery));
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
    if (showMentions && filteredCandidates.length > 0) {
      const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
      const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
      const isSelect = e.key === 'Enter' || e.key === 'Tab';
      const isClose = e.key === 'Escape';

      if (isUp) {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredCandidates.length) % filteredCandidates.length);
        return;
      }
      if (isDown) {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredCandidates.length);
        return;
      }
      if (isSelect) {
        e.preventDefault();
        const c = filteredCandidates[selectedIndex];
        if (c) insertMention(c);
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
    <div
      className="relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-brand-500/10 rounded-lg border-2 border-dashed border-brand-500">
          <span className="text-sm text-brand-500 font-medium">{t('commentInput.dragDropHint')}</span>
        </div>
      )}
      {showMentions && (
        <MentionDropdown
          candidates={candidates}
          filter={mentionFilter}
          anchorRef={inputRef}
          onSelect={insertMention}
          selectedIndex={selectedIndex}
          onIndexChange={setSelectedIndex}
        />
      )}

      <div className="border border-border-default rounded-lg bg-surface-elevated">
        {replyTo && (
          <div className="flex items-center gap-2 px-2.5 pt-2 pb-1 border-b border-border-default/50">
            <div className="flex-1 min-w-0 pl-2 border-l-2 border-brand-500/50">
              <span className="text-[10px] font-medium text-brand-500">{replyTo.authorName}</span>
              <p className="text-[10px] text-fg-tertiary truncate">{replyTo.content}</p>
            </div>
            <button onClick={onCancelReply} className="text-fg-tertiary hover:text-fg-secondary shrink-0 p-0.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        )}
        {selectedMentions.length > 0 && (
          <div className="flex gap-1 px-2.5 pt-2 flex-wrap">
            {selectedMentions.map(mid => {
              const c = candidates.find(x => x.id === mid);
              return (
                <span key={mid} className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full ${
                  c?.type === 'human' ? 'bg-green-500/15 text-green-500' : 'bg-brand-500/15 text-brand-500'
                }`}>
                  @{c?.name ?? mid}
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
          onPaste={handlePaste}
          placeholder={placeholder ?? t('commentInput.placeholder')}
          rows={2}
          className="w-full px-2.5 py-2 text-xs bg-transparent text-fg-primary placeholder-fg-tertiary outline-none resize-none"
        />
        {/* Image preview strip */}
        {pendingImages.length > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 pb-1.5 overflow-x-auto">
            {pendingImages.map(img => (
              <div key={img.id} className="relative group/img shrink-0">
                <img src={img.dataUrl} alt={img.name} className="w-12 h-12 rounded-lg object-cover border border-border-default" />
                <button
                  onClick={() => removeImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-surface-secondary border border-gray-600 rounded-full flex items-center justify-center text-fg-secondary hover:text-red-500 hover:border-red-500 text-[10px] opacity-0 group-hover/img:opacity-100 transition-opacity"
                  title={t('commentInput.removeImage')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 px-2.5 pb-1.5">
            <span className="text-[11px] text-red-400 flex-1 truncate">{error}</span>
            <button
              onClick={handleRetry}
              disabled={sending}
              className="text-[11px] text-amber-500 hover:text-amber-400 font-medium transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
              {t('commentInput.retry')}
            </button>
          </div>
        )}
        <div className="flex items-center justify-between px-2.5 pb-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || pendingImages.length >= MAX_FILES}
            className="p-1 text-fg-tertiary hover:text-brand-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title={t('commentInput.attachImage')}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            onClick={handleSend}
            disabled={(!text.trim() && pendingImages.length === 0) || sending}
            className="px-3 py-1 text-[11px] font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? t('commentInput.sending') : t('commentInput.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
