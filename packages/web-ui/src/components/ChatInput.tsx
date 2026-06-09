import { useRef, useState, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Avatar } from './Avatar.tsx';

export type MentionEntityType = 'agent' | 'project' | 'requirement' | 'task' | 'deliverable';

export interface ContextChip {
  id: string;
  label: string;
  type: 'selection' | 'mention' | 'deliverable' | 'task' | 'project' | 'requirement';
  content: string;
  entityType?: MentionEntityType;
  onRemove?: () => void;
}

export interface MentionItem {
  id: string;
  name: string;
  role?: string;
  avatarUrl?: string;
  type: MentionEntityType;
}

const MENTION_TYPE_ICON: Record<MentionEntityType, string> = {
  agent: '🤖',
  project: '📁',
  requirement: '📋',
  task: '✅',
  deliverable: '📦',
};

const MENTION_TYPE_ORDER: MentionEntityType[] = ['project', 'requirement', 'task', 'deliverable', 'agent'];

export interface PendingFile {
  id: string;
  dataUrl: string;
  name: string;
}

export interface MentionChip {
  id: string;
  entityId: string;
  name: string;
  entityType: MentionEntityType;
}

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  sending?: boolean;
  onStop?: () => void;
  contextChips?: ContextChip[];
  mentionItems?: MentionItem[];
  showMentionDropdown?: boolean;
  pendingFiles?: PendingFile[];
  onAttach?: () => void;
  onPaste?: (e: ClipboardEvent) => void;
  onDrop?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onRemoveFile?: (id: string) => void;
  replyTo?: { id: string; sender: string; text: string } | null;
  onClearReply?: () => void;
  fileInputRef?: React.RefObject<HTMLInputElement | null>;
  visionWarning?: boolean;
  maxFiles?: number;
  className?: string;
  compact?: boolean;
  /** Called when mention chips change (add/remove) */
  onMentionChipsChange?: (chips: MentionChip[]) => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function isImageFile(f: { name: string; dataUrl: string }) {
  return f.dataUrl.startsWith('data:image/');
}

function getFileIcon(name: string, dataUrl: string) {
  if (isImageFile({ name, dataUrl })) return null;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const iconMap: Record<string, string> = {
    pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊',
    pptx: '📎', csv: '📊', json: '🔧', xml: '🔧', html: '🌐', epub: '📚',
  };
  return iconMap[ext] ?? '📁';
}

export function ChatInput({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = '',
  sending = false,
  onStop,
  contextChips,
  mentionItems,
  pendingFiles,
  onAttach,
  onPaste,
  onDrop,
  onDragOver,
  onRemoveFile,
  replyTo,
  onClearReply,
  fileInputRef: externalFileInputRef,
  visionWarning,
  maxFiles = 5,
  className = '',
  compact = false,
  onMentionChipsChange,
}: ChatInputProps) {
  const { t } = useTranslation(['team', 'common']);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const internalFileRef = useRef<HTMLInputElement>(null);
  const fileInputRef = externalFileInputRef ?? internalFileRef;

  const [mentionDropdown, setMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ left: number; bottom: number } | null>(null);
  const [mentionChips, setMentionChips] = useState<MentionChip[]>([]);

  const filteredMentions = (mentionItems ?? []).filter(a => a.name.toLowerCase().includes(mentionFilter));

  const groupedMentions = (() => {
    if (filteredMentions.length === 0) return [];
    const byType = new Map<MentionEntityType, MentionItem[]>();
    for (const item of filteredMentions) {
      const t = item.type ?? 'agent';
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(item);
    }
    const groups: Array<{ type: MentionEntityType; items: MentionItem[] }> = [];
    for (const t of MENTION_TYPE_ORDER) {
      const items = byType.get(t);
      if (items?.length) groups.push({ type: t, items });
    }
    return groups;
  })();

  useEffect(() => {
    if (!mentionDropdown || !containerRef.current) { setDropdownPos(null); return; }
    const rect = containerRef.current.getBoundingClientRect();
    setDropdownPos({ left: rect.left + 16, bottom: window.innerHeight - rect.top + 4 });
  }, [mentionDropdown]);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 80 : 120)}px`;
  }, [compact]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [value, adjustTextareaHeight]);

  const handleInputChange = useCallback((val: string) => {
    onChange(val);
    if (!mentionItems?.length) { setMentionDropdown(false); return; }

    const cursorPos = textareaRef.current?.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atIdx = textBeforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const charBefore = atIdx === 0 ? '' : textBeforeCursor[atIdx - 1]!;
      const isValidPosition = atIdx === 0 || /[\s\n,，。！？!?;；:：、（）()\[\]【】]/.test(charBefore);
      if (isValidPosition) {
        const fragment = textBeforeCursor.slice(atIdx + 1);
        if (!fragment.includes(' ') && !fragment.includes('\n')) {
          setMentionDropdown(true);
          setMentionFilter(fragment.toLowerCase());
          setMentionSelectedIndex(0);
          return;
        }
      }
    }
    setMentionDropdown(false);
  }, [onChange, mentionItems]);

  const insertMention = useCallback((item: MentionItem) => {
    const cursorPos = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, cursorPos);
    const atIdx = before.lastIndexOf('@');
    const after = value.slice(cursorPos);
    const newVal = value.slice(0, atIdx) + after.replace(/^\s/, '');
    onChange(newVal);

    const chip: MentionChip = {
      id: `mention_${Date.now()}_${item.id}`,
      entityId: item.id,
      name: item.name,
      entityType: item.type,
    };
    const nextChips = [...mentionChips, chip];
    setMentionChips(nextChips);
    onMentionChipsChange?.(nextChips);

    setMentionDropdown(false);
    setMentionSelectedIndex(0);
    requestAnimationFrame(() => {
      const pos = atIdx;
      textareaRef.current?.setSelectionRange(pos, pos);
      textareaRef.current?.focus();
    });
  }, [value, onChange, mentionChips, onMentionChipsChange]);

  const handleSend = useCallback(() => {
    onSend();
    setMentionChips([]);
    onMentionChipsChange?.([]);
  }, [onSend, onMentionChipsChange]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionDropdown && filteredMentions.length > 0) {
      const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
      const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
      const isSelect = e.key === 'Enter' || e.key === 'Tab';
      const isClose = e.key === 'Escape';
      if (isUp) { e.preventDefault(); setMentionSelectedIndex(prev => (prev - 1 + filteredMentions.length) % filteredMentions.length); return; }
      if (isDown) { e.preventDefault(); setMentionSelectedIndex(prev => (prev + 1) % filteredMentions.length); return; }
      if (isSelect) { e.preventDefault(); const item = filteredMentions[mentionSelectedIndex]; if (item) insertMention(item); return; }
      if (isClose) { e.preventDefault(); setMentionDropdown(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [mentionDropdown, filteredMentions, mentionSelectedIndex, insertMention, handleSend]);

  const files = pendingFiles ?? [];

  const mentionDropdownEl = mentionDropdown && filteredMentions.length > 0 && dropdownPos && createPortal(
    <div
      className="fixed bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden max-h-64 overflow-y-auto min-w-[220px]"
      style={{ left: dropdownPos.left, bottom: dropdownPos.bottom, zIndex: 9999 }}
    >
      {(() => {
        let flatIdx = 0;
        return groupedMentions.map(group => {
          const icon = MENTION_TYPE_ICON[group.type];
          const label = t(`page.mentionType.${group.type}`);
          return (
            <div key={group.type}>
              <div className="px-3 py-1 text-[10px] text-fg-tertiary font-medium uppercase tracking-wider border-b border-border-default bg-surface-secondary/50 flex items-center gap-1.5 sticky top-0">
                <span>{icon}</span>
                <span>{label}</span>
              </div>
              {group.items.map(a => {
                const curIdx = flatIdx++;
                return (
                  <button
                    key={a.id}
                    ref={el => { if (curIdx === mentionSelectedIndex && el) el.scrollIntoView({ block: 'nearest' }); }}
                    onMouseDown={e => { e.preventDefault(); insertMention(a); }}
                    onMouseEnter={() => setMentionSelectedIndex(curIdx)}
                    className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 transition-colors ${
                      curIdx === mentionSelectedIndex ? 'bg-brand-500/15 text-brand-500' : 'text-fg-secondary hover:bg-surface-overlay'
                    }`}
                  >
                    {a.type === 'agent' ? (
                      <Avatar name={a.name} avatarUrl={a.avatarUrl} size={20} bgClass="bg-brand-500/20 text-brand-500" />
                    ) : (
                      <span className="text-xs w-5 h-5 flex items-center justify-center shrink-0">{icon}</span>
                    )}
                    <span className="flex-1 min-w-0 truncate">{a.name}</span>
                    {a.role && <span className="text-[10px] text-fg-tertiary ml-auto shrink-0">{a.role}</span>}
                  </button>
                );
              })}
            </div>
          );
        });
      })()}
    </div>,
    document.body,
  );

  return (
    <div
      ref={containerRef}
      className={`relative bg-surface-primary border border-border-default shadow-lg shadow-black/10 rounded-2xl p-3 ${className}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      {mentionDropdownEl}

      {/* Context chips & mention chips */}
      {((contextChips && contextChips.length > 0) || mentionChips.length > 0) && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {mentionChips.map(chip => (
            <span key={chip.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-500/10 border border-brand-500/30 text-xs text-brand-400 max-w-[200px]">
              <span className="shrink-0 text-[10px]">{MENTION_TYPE_ICON[chip.entityType]}</span>
              <span className="truncate font-medium">{chip.name}</span>
              <button
                onClick={() => {
                  const next = mentionChips.filter(c => c.id !== chip.id);
                  setMentionChips(next);
                  onMentionChipsChange?.(next);
                }}
                className="shrink-0 text-brand-400/60 hover:text-red-400 transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </span>
          ))}
          {contextChips?.map(chip => (
            <span key={chip.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-elevated border border-border-default text-xs text-fg-secondary max-w-[200px]">
              <span className="truncate">{chip.label}</span>
              {chip.onRemove && (
                <button onClick={chip.onRemove} className="shrink-0 text-fg-tertiary hover:text-red-500 transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Pending files */}
      {files.length > 0 && (
        <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-1">
          {files.map(img => (
            <div key={img.id} className="relative group/img shrink-0">
              {isImageFile(img) ? (
                <img src={img.dataUrl} alt={img.name} className="w-16 h-16 rounded-lg object-cover border border-border-default" />
              ) : (
                <div className="w-16 h-16 rounded-lg border border-border-default bg-surface-elevated flex flex-col items-center justify-center gap-0.5" title={img.name}>
                  <span className="text-xl leading-none">{getFileIcon(img.name, img.dataUrl)}</span>
                  <span className="text-[9px] text-fg-tertiary truncate max-w-[56px] px-0.5">{img.name.split('.').pop()?.toUpperCase()}</span>
                </div>
              )}
              {onRemoveFile && (
                <button
                  onClick={() => onRemoveFile(img.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-surface-secondary border border-gray-600 rounded-full flex items-center justify-center text-fg-secondary hover:text-red-500 hover:border-red-500 text-xs opacity-0 group-hover/img:opacity-100 transition-opacity"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {files.length < maxFiles && onAttach && (
            <button
              onClick={onAttach}
              className="w-16 h-16 rounded-lg border border-dashed border-gray-600 flex items-center justify-center text-fg-tertiary hover:text-fg-secondary hover:border-gray-400 transition-colors shrink-0"
              title={t('page.addMoreFiles')}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          )}
        </div>
      )}

      {/* Vision warning */}
      {visionWarning && (
        <div className="text-[10px] text-amber-500/80 mb-1.5 flex items-center gap-1">
          <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M12 2L2 22h20L12 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t('page.visionWarning')}
        </div>
      )}

      {/* Reply bar */}
      {replyTo && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-surface-elevated rounded-lg border border-border-default/50">
          <div className="flex-1 min-w-0 pl-2 border-l-2 border-brand-500/50">
            <span className="text-[11px] font-medium text-brand-500">{replyTo.sender}</span>
            <p className="text-[11px] text-fg-tertiary truncate">{replyTo.text}</p>
          </div>
          {onClearReply && (
            <button onClick={onClearReply} className="text-fg-tertiary hover:text-fg-secondary shrink-0 p-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </div>
      )}

      {/* Input row */}
      <div className="flex gap-2 items-end">
        {onAttach && (
          <button
            onClick={onAttach}
            disabled={disabled}
            className="px-2.5 py-2.5 text-fg-tertiary hover:text-fg-secondary disabled:opacity-40 transition-colors rounded-xl hover:bg-surface-elevated"
            title={t('page.attachFilesTitle')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={compact ? 1 : 2}
          className="flex-1 px-4 py-3 bg-transparent rounded-xl text-sm outline-none disabled:opacity-40 transition-colors resize-none overflow-hidden leading-relaxed placeholder:text-fg-secondary"
          style={{ minHeight: compact ? '36px' : '52px', maxHeight: compact ? '80px' : '120px' }}
        />
        {sending && onStop && (
          <button
            onClick={onStop}
            className="px-3 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-xl transition-colors flex items-center gap-1.5"
            title={t('page.stopAgent')}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={disabled || (!value.trim() && files.length === 0 && mentionChips.length === 0)}
          className="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors"
        >
          {t('common:send')}
        </button>
      </div>
    </div>
  );
}
