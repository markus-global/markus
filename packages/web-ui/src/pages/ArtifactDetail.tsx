import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, hubApi, type AuthUser } from '../api.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { PAYMENTS_ENABLED } from './AgentBuilder.tsx';

interface ArtifactDetailProps {
  type: string;
  name: string;
  onBack: () => void;
  authUser?: AuthUser;
}

interface ManifestData {
  type: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  icon?: string;
  thumbnail?: string;
  screenshots?: string[];
  agent?: { roleName?: string; agentRole: string; llmProvider?: string; llmModel?: string; temperature?: number };
  team?: { members: Array<{ name: string; role: string; roleName?: string; count: number; skills?: string[] }> };
  skill?: { skillFile: string; requiredPermissions?: string[]; mcpServers?: Record<string, unknown>; alwaysOn?: boolean };
  dependencies?: { skills?: string[]; env?: string[] };
  source?: { type: string; url?: string; hubItemId?: string };
}

const TYPE_STYLES: Record<string, { icon: string; label: string; color: string; gradient: string; bg: string; ring: string }> = {
  agent: { icon: '✦', label: 'Agent', color: 'text-brand-500', gradient: 'from-brand-500 to-purple-600', bg: 'bg-brand-500/10', ring: 'ring-brand-500/30' },
  team:  { icon: '◈', label: 'Team',  color: 'text-blue-600',  gradient: 'from-blue-500 to-blue-600',    bg: 'bg-blue-500/10',  ring: 'ring-blue-500/30' },
  skill: { icon: '⬡', label: 'Skill', color: 'text-green-600', gradient: 'from-green-500 to-green-600',  bg: 'bg-green-500/10', ring: 'ring-green-500/30' },
};

const CATEGORIES: string[] = ['development', 'devops', 'management', 'productivity', 'browser', 'custom', 'general'];

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: 'Tech', emojis: ['✦', '◈', '⬡', '⚡', '🤖', '🧠', '💡', '🎯', '🔧', '📦', '🚀', '💻', '🛠️', '⭐', '🔥', '💎', '⚙️', '🧩', '🔌', '💾', '🖥️', '📡', '🔬', '🧪', '🏗️', '📱', '🎮', '🕹️', '📟', '💽', '🖨️', '⌨️'] },
  { label: 'People', emojis: ['👤', '👥', '🧑‍💻', '👨‍💼', '👩‍🔬', '🧙', '🦸', '🤝', '💪', '🎓', '👷', '🕵️', '🧑‍🎨', '🧑‍🏫', '👨‍🚀', '🥷', '🧑‍🏭', '🧑‍⚕️', '🧑‍🔧', '🧑‍🍳', '👨‍🎤', '🦹', '🧝', '🧞', '🧑‍✈️', '💂', '🤴', '👸', '🧛', '🧟', '🧜', '🧚'] },
  { label: 'Objects', emojis: ['📝', '📊', '🗂️', '📁', '🔍', '🔑', '🌐', '💬', '🔒', '🎨', '📐', '🗃️', '📋', '✏️', '🖊️', '📌', '📎', '🧲', '🪝', '🧰', '🪜', '🧬', '🔭', '💊', '🩺', '📕', '📗', '📘', '📙', '📓', '🗒️', '📰'] },
  { label: 'Symbols', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '♠️', '♥️', '♦️', '♣️', '🎵', '🎶', '💯', '✅', '❌', '⭕', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '🔶', '🔷', '▶️', '⏸️', '⏹️'] },
  { label: 'Nature', emojis: ['🌟', '🌈', '🌊', '🌿', '🍀', '🔮', '💫', '✨', '🌙', '☀️', '🦋', '🐉', '🦊', '🐺', '🦅', '🐙', '🦁', '🐯', '🦄', '🐲', '🌸', '🌺', '🍄', '🌵', '🎄', '🌴', '🍁', '🌻', '🐝', '🦎', '🐍', '🦈'] },
  { label: 'Activity', emojis: ['🎯', '🏆', '🥇', '🎖️', '🏅', '🎪', '🎭', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎸', '🎺', '🎻', '⚽', '🏀', '🎾', '🏐', '🎲', '🧸', '🪁', '🎰', '🎳', '🏹', '🥊', '🤺', '⛷️', '🏄', '🚴', '🧗'] },
];

const PERMISSION_ICONS: Record<string, { icon: string; color: string }> = {
  shell:   { icon: '>', color: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  file:    { icon: '◫', color: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  network: { icon: '◎', color: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  browser: { icon: '◉', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
};

// ---------------------------------------------------------------------------
// InlineEditable: Notion-style click-to-edit
// ---------------------------------------------------------------------------
function InlineEditable({ value, onChange, renderAs = 'span', className, editClassName, placeholder, multiline }: {
  value: string;
  onChange: (v: string) => void;
  renderAs?: 'h1' | 'p' | 'span' | 'badge';
  className?: string;
  editClassName?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onChange(draft);
  };
  const cancel = () => { setDraft(value); setEditing(false); };
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && !multiline) commit();
  };

  if (editing) {
    const cls = `bg-transparent outline-none w-full ${editClassName ?? className ?? ''} ring-1 ring-brand-500/50 rounded px-1 -mx-1`;
    if (multiline) {
      return <textarea ref={inputRef as React.RefObject<HTMLTextAreaElement>} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKey} className={`${cls} resize-y min-h-[60px]`} placeholder={placeholder} />;
    }
    return <input ref={inputRef as React.RefObject<HTMLInputElement>} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={handleKey} className={cls} placeholder={placeholder} />;
  }

  const display = value || placeholder;
  const isEmpty = !value;
  const hoverCls = 'cursor-text hover:ring-1 hover:ring-border-default rounded px-1 -mx-1 transition-all';

  if (renderAs === 'h1') return <h1 onClick={() => setEditing(true)} className={`${className ?? ''} ${hoverCls} ${isEmpty ? 'text-fg-muted italic' : ''}`}>{display}</h1>;
  if (renderAs === 'p') return <p onClick={() => setEditing(true)} className={`${className ?? ''} ${hoverCls} ${isEmpty ? 'text-fg-muted italic' : ''}`}>{display}</p>;
  if (renderAs === 'badge') return <span onClick={() => setEditing(true)} className={`${className ?? ''} ${hoverCls} ${isEmpty ? 'text-fg-muted italic' : ''}`}>{display}</span>;
  return <span onClick={() => setEditing(true)} className={`${className ?? ''} ${hoverCls} ${isEmpty ? 'text-fg-muted italic' : ''}`}>{display}</span>;
}

// ---------------------------------------------------------------------------
// InlineSelect – combobox that allows both selecting from options and typing custom values
// ---------------------------------------------------------------------------
function InlineSelect({ value, options, onChange, className }: {
  value: string; options: string[]; onChange: (v: string) => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) { setInput(value); setTimeout(() => inputRef.current?.focus(), 0); } }, [open, value]);

  const filtered = options.filter(o => o.toLowerCase().includes(input.toLowerCase()));

  const commit = (v: string) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== value) onChange(trimmed);
    setOpen(false);
  };

  if (open) {
    return (
      <div ref={containerRef} className="relative inline-block">
        <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(input); } else if (e.key === 'Escape') setOpen(false); }}
          onBlur={e => { if (!containerRef.current?.contains(e.relatedTarget as Node)) commit(input); }}
          className={`${className ?? ''} bg-transparent outline-none ring-1 ring-brand-500/50 rounded w-28`}
        />
        {filtered.length > 0 && (
          <div className="absolute top-full left-0 mt-1 z-50 bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1 min-w-[120px] max-h-40 overflow-y-auto">
            {filtered.map(o => (
              <button key={o} onMouseDown={e => { e.preventDefault(); commit(o); }}
                className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-surface-secondary/80 transition-colors ${o === value ? 'text-brand-400 font-medium' : 'text-fg-secondary'}`}>
                {o}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return <span onClick={() => setOpen(true)} className={`${className ?? ''} cursor-pointer hover:ring-1 hover:ring-border-default rounded px-1 -mx-1 transition-all`}>{value}</span>;
}

// ---------------------------------------------------------------------------
// InlineTags
// ---------------------------------------------------------------------------
function InlineTags({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useTranslation(['builder']);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
      e.preventDefault();
      const tag = input.trim().toLowerCase();
      if (!tags.includes(tag)) onChange([...tags, tag]);
      setInput('');
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    } else if (e.key === 'Escape') {
      setEditing(false);
      setInput('');
    }
  };

  if (!editing) {
    return (
      <div onClick={() => setEditing(true)} className="flex flex-wrap items-center gap-1.5 cursor-text hover:ring-1 hover:ring-border-default rounded px-1 -mx-1 py-0.5 transition-all min-h-[24px]">
        {tags.length > 0 ? tags.map(tag => (
          <span key={tag} className="text-[10px] px-2 py-0.5 bg-surface-elevated text-fg-muted rounded-full border border-border-default">{tag}</span>
        )) : <span className="text-[10px] text-fg-muted italic">{t('detail.typeTagAndEnter')}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 ring-1 ring-brand-500/50 rounded px-2 py-1 -mx-1 min-h-[32px]">
      {tags.map(tag => (
        <span key={tag} className="inline-flex items-center gap-1 text-[10px] bg-surface-elevated text-fg-secondary rounded-full px-2 py-0.5 border border-border-default">
          {tag}
          <button onClick={() => onChange(tags.filter(t => t !== tag))} className="text-fg-muted hover:text-red-500">&times;</button>
        </span>
      ))}
      <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
        onBlur={() => { if (!input) setEditing(false); }}
        className="flex-1 min-w-[80px] bg-transparent text-xs text-fg-primary placeholder:text-fg-muted focus:outline-none"
        placeholder={t('detail.typeTagAndEnter')}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RenderedMarkdown
// ---------------------------------------------------------------------------
function RenderedMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none
      prose-headings:text-fg-primary prose-headings:font-semibold
      prose-p:text-fg-secondary prose-p:leading-relaxed
      prose-a:text-brand-400 prose-a:no-underline hover:prose-a:underline
      prose-code:text-brand-300 prose-code:bg-surface-elevated prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none
      prose-pre:bg-surface-elevated prose-pre:border prose-pre:border-border-default prose-pre:rounded-lg
      prose-strong:text-fg-primary
      prose-li:text-fg-secondary
      prose-hr:border-border-default
      prose-blockquote:border-brand-500/40 prose-blockquote:text-fg-secondary">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileSection: renders file content with toggle-to-edit
// ---------------------------------------------------------------------------
function FileSection({ filename, content, onSave, embedded }: {
  filename: string; content: string; onSave: (content: string) => void; embedded?: boolean;
}) {
  const { t } = useTranslation(['builder', 'common']);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const isMd = /\.(md|mdx|markdown)$/i.test(filename);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(content); }, [content]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = 'auto';
      el.style.height = Math.max(200, el.scrollHeight) + 'px';
    }
  }, [editing, draft]);

  const handleSave = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    setEditing(false);
  };

  const editButtons = (
    <div className="flex items-center gap-2">
      {editing ? (
        <>
          <button onClick={() => { setDraft(content); setEditing(false); }} className="text-[10px] px-2.5 py-1 rounded-md text-fg-tertiary hover:text-fg-secondary border border-border-default transition-colors">{t('common:cancel')}</button>
          <button onClick={handleSave} disabled={saving} className="text-[10px] px-2.5 py-1 rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50">{saving ? t('common:saving') : t('common:save')}</button>
        </>
      ) : (
        <button onClick={() => setEditing(true)} className="text-[10px] px-2.5 py-1 rounded-md text-fg-tertiary hover:text-fg-secondary border border-border-default transition-colors inline-flex items-center gap-1">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          {t('detail.edit')}
        </button>
      )}
    </div>
  );

  if (embedded) {
    return (
      <div>
        <div className="flex items-center justify-end px-4 py-2 border-b border-border-default bg-surface-elevated/20">
          {editButtons}
        </div>
        {editing ? (
          <textarea ref={textareaRef} value={draft} onChange={e => setDraft(e.target.value)}
            className="w-full bg-surface-elevated/20 text-sm text-fg-primary font-mono p-4 focus:outline-none resize-y min-h-[200px] leading-relaxed"
            spellCheck={false}
          />
        ) : (
          <div className="p-4">
            {isMd ? <RenderedMarkdown content={content} /> : (
              <pre className="text-xs leading-relaxed text-fg-secondary whitespace-pre-wrap font-mono">{content}</pre>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border-default bg-surface-secondary/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-default bg-surface-elevated/30">
        <span className="text-xs font-medium text-fg-secondary font-mono">{filename}</span>
        {editButtons}
      </div>
      {editing ? (
        <textarea ref={textareaRef} value={draft} onChange={e => setDraft(e.target.value)}
          className="w-full bg-surface-elevated/20 text-sm text-fg-primary font-mono p-4 focus:outline-none resize-y min-h-[200px] leading-relaxed"
          spellCheck={false}
        />
      ) : (
        <div className="p-4">
          {isMd ? <RenderedMarkdown content={content} /> : (
            <pre className="text-xs leading-relaxed text-fg-secondary whitespace-pre-wrap font-mono">{content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// sortFiles: canonical ordering — README > ROLE > HEARTBEAT > POLICIES > CONTEXT > rest
// ---------------------------------------------------------------------------
const FILE_PRIORITY: Record<string, number> = {
  'README.md': 0, 'ROLE.md': 1, 'HEARTBEAT.md': 2, 'POLICIES.md': 3, 'CONTEXT.md': 4,
  'ANNOUNCEMENT.md': 0, 'NORMS.md': 1,
};
function sortFiles(files: [string, string][]): [string, string][] {
  return [...files].sort(([a], [b]) => {
    const pa = FILE_PRIORITY[a] ?? 99;
    const pb = FILE_PRIORITY[b] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// TabbedFiles: show multiple files via tab switching
// ---------------------------------------------------------------------------
function TabbedFiles({ files: rawFiles, onSave, noHeader }: { files: [string, string][]; onSave: (filename: string, content: string) => void; noHeader?: boolean }) {
  const files = useMemo(() => sortFiles(rawFiles), [rawFiles]);
  const [activeTab, setActiveTab] = useState(0);

  if (files.length === 1) {
    if (noHeader) return <FileSection filename={files[0]![0]} content={files[0]![1]} onSave={c => onSave(files[0]![0], c)} />;
    return (
      <div className="mb-8">
        <h2 className="text-sm font-semibold text-fg-primary mb-4 uppercase tracking-wider">Files</h2>
        <FileSection filename={files[0]![0]} content={files[0]![1]} onSave={c => onSave(files[0]![0], c)} />
      </div>
    );
  }

  const [currentFile, currentContent] = files[activeTab] ?? files[0]!;
  const inner = (
    <div className="rounded-xl border border-border-default bg-surface-secondary/40 overflow-hidden">
      <div className="flex items-center gap-0 overflow-x-auto bg-surface-elevated/30">
        {files.map(([fname], i) => (
          <button key={fname} onClick={() => setActiveTab(i)}
            className={`px-4 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${i === activeTab ? 'border-brand-500 text-brand-400 bg-surface-secondary/50' : 'border-transparent text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated/50'}`}>
            {fname}
          </button>
        ))}
      </div>
      <FileSection key={currentFile} filename={currentFile} content={currentContent} onSave={c => onSave(currentFile, c)} embedded />
    </div>
  );

  if (noHeader) return inner;
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-fg-primary mb-4 uppercase tracking-wider">Files</h2>
      {inner}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImageGallery: inline image management
// ---------------------------------------------------------------------------
function ImageGallery({ images, artifactType, artifactName, onUpload, onRemove }: {
  images: string[]; artifactType: string; artifactName: string;
  onUpload: (file: File) => void; onRemove: (filename: string) => void;
}) {
  const { t } = useTranslation(['builder']);
  const fileInputRef = useRef<HTMLInputElement>(null);
  if (images.length === 0) {
    return (
      <div className="border-2 border-dashed border-border-default rounded-xl p-6 text-center text-fg-muted text-sm cursor-pointer hover:border-brand-500/30 transition-colors"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) onUpload(f); }}>
        <svg className="w-8 h-8 mx-auto mb-2 text-fg-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
        <span className="block">{t('images.dropOrClick')}</span>
        <span className="block text-xs text-fg-muted/60 mt-1">{t('images.hint')}</span>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
      </div>
    );
  }
  return (
    <div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {images.map(img => {
          const filename = img.split('/').pop() ?? img;
          return (
            <div key={img} className="relative group shrink-0 rounded-lg border border-border-default overflow-hidden bg-surface-elevated">
              <img src={`/api/builder/artifacts/${artifactType}s/${encodeURIComponent(artifactName)}/images/${encodeURIComponent(filename)}`} alt={filename} className="h-32 w-auto object-cover" />
              <button onClick={() => onRemove(filename)} className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-red-600/80 text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">&times;</button>
            </div>
          );
        })}
        <button onClick={() => fileInputRef.current?.click()} className="shrink-0 h-32 w-24 rounded-lg border-2 border-dashed border-border-default flex items-center justify-center text-fg-muted hover:border-brand-500/30 hover:text-brand-400 transition-colors">
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TeamTabs: Overview tab + one tab per member, each with nested file tabs
// ---------------------------------------------------------------------------
function TeamTabs({ members, teamTopFiles, files, onFileSave }: {
  members: Array<{ name: string; role: string; roleName?: string; count: number; skills?: string[] }>;
  teamTopFiles: [string, string][];
  files: Record<string, string>;
  onFileSave: (filename: string, content: string) => void;
}) {
  const { t } = useTranslation(['builder']);
  const [activeTab, setActiveTab] = useState(0);

  const memberDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const k of Object.keys(files)) {
      const match = k.match(/^members\/([^/]+)\//);
      if (match) dirs.add(match[1]!);
    }
    return [...dirs];
  }, [files]);

  const getMemberFiles = useCallback((name: string, idx: number): [string, string][] => {
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
    if (slug) {
      const matched = Object.entries(files).filter(([k]) => k.startsWith(`members/${slug}/`));
      if (matched.length > 0) return matched;
    }
    if (idx < memberDirs.length) {
      const dirName = memberDirs[idx]!;
      return Object.entries(files).filter(([k]) => k.startsWith(`members/${dirName}/`));
    }
    return [];
  }, [files, memberDirs]);

  const tabs = useMemo(() => {
    const list: { label: string; role?: string }[] = [{ label: t('detail.overview') }];
    for (const m of members) list.push({ label: m.name, role: m.role });
    return list;
  }, [members, t]);

  const activeMember = activeTab > 0 ? members[activeTab - 1] : null;
  const activeMemberIdx = activeTab - 1;

  return (
    <div className="rounded-xl border border-border-default bg-surface-secondary/40 overflow-hidden">
      {/* Top-level tab bar */}
      <div className="flex items-center gap-0 overflow-x-auto bg-surface-elevated/30 border-b border-border-default">
        {tabs.map((tab, i) => {
          const isActive = i === activeTab;
          const isManager = tab.role === 'manager';
          const colorClass = i === 0
            ? (isActive ? 'border-brand-500 text-brand-400' : 'border-transparent text-fg-tertiary hover:text-fg-secondary')
            : isManager
              ? (isActive ? 'border-amber-500 text-amber-400' : 'border-transparent text-fg-tertiary hover:text-fg-secondary')
              : (isActive ? 'border-blue-500 text-blue-400' : 'border-transparent text-fg-tertiary hover:text-fg-secondary');
          return (
            <button key={i} onClick={() => setActiveTab(i)}
              className={`px-4 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${colorClass} ${isActive ? 'bg-surface-secondary/50' : 'hover:bg-surface-elevated/50'}`}>
              {i === 0 && <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>}
              {i > 0 && (
                <span className={`w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center shrink-0 ${isManager ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                  {(tab.label[0] ?? '?').toUpperCase()}
                </span>
              )}
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="p-5">
        {activeTab === 0 ? (
          /* Overview: team-level docs + member summary */
          <div className="space-y-6">
            {teamTopFiles.length > 0 && (
              <TabbedFiles noHeader files={teamTopFiles} onSave={handleOverviewFileSave} />
            )}
            <div>
              <div className="text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider mb-3">{t('sidebar.composition')}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {members.map((m, i) => {
                  const isManager = m.role === 'manager';
                  return (
                    <button key={i} onClick={() => setActiveTab(i + 1)}
                      className="text-left rounded-lg border border-border-default bg-surface-elevated/30 px-4 py-3 flex gap-3 items-center hover:border-gray-600 transition-colors cursor-pointer">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isManager ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30' : 'bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/30'}`}>
                        {(m.name[0] ?? '?').toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-fg-primary truncate">{m.name}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${isManager ? 'bg-amber-500/15 text-amber-400' : 'bg-blue-500/15 text-blue-400'}`}>{m.role}</span>
                          {m.count > 1 && <span className="text-[9px] text-fg-muted">&times;{m.count}</span>}
                        </div>
                        {m.skills && m.skills.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {m.skills.slice(0, 3).map(s => <span key={s} className="text-[9px] px-1.5 py-0.5 bg-surface-elevated text-fg-muted rounded border border-border-default">{s}</span>)}
                            {m.skills.length > 3 && <span className="text-[9px] text-fg-muted">+{m.skills.length - 3}</span>}
                          </div>
                        )}
                      </div>
                      <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : activeMember ? (
          /* Member detail: profile header + file tabs */
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${activeMember.role === 'manager' ? 'bg-amber-500/15 text-amber-400 ring-2 ring-amber-500/30' : 'bg-blue-500/15 text-blue-400 ring-2 ring-blue-500/30'}`}>
                {(activeMember.name[0] ?? '?').toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-fg-primary">{activeMember.name}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${activeMember.role === 'manager' ? 'bg-amber-500/15 text-amber-400' : 'bg-blue-500/15 text-blue-400'}`}>{activeMember.role}</span>
                  {activeMember.count > 1 && <span className="text-[10px] text-fg-muted">&times;{activeMember.count}</span>}
                </div>
                {activeMember.roleName && <div className="text-xs text-fg-tertiary mt-0.5 italic">{activeMember.roleName}</div>}
              </div>
            </div>
            {activeMember.skills && activeMember.skills.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {activeMember.skills.map(s => <span key={s} className="text-[10px] px-2.5 py-1 bg-surface-elevated text-fg-muted rounded-full border border-border-default">{s}</span>)}
              </div>
            )}
            {(() => {
              const mf = getMemberFiles(activeMember.name, activeMemberIdx);
              if (mf.length === 0) return <p className="text-xs text-fg-muted italic">No files for this member yet.</p>;
              return (
                <TabbedFiles
                  noHeader
                  files={mf.map(([fname, content]) => [fname.replace(/^members\/[^/]+\//, ''), content] as [string, string])}
                  onSave={(shortName, content) => {
                    const original = mf.find(([f]) => f.endsWith(`/${shortName}`));
                    if (original) onFileSave(original[0], content);
                  }}
                />
              );
            })()}
          </div>
        ) : null}
      </div>
    </div>
  );

  function handleOverviewFileSave(filename: string, content: string) {
    onFileSave(filename, content);
  }
}


// ===========================================================================
// Main Component
// ===========================================================================
export function ArtifactDetail({ type, name, onBack, authUser: _authUser }: ArtifactDetailProps) {
  const { t } = useTranslation(['builder', 'common']);
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [manifest, setManifest] = useState<ManifestData | null>(null);
  const [artPath, setArtPath] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [hubStatus, setHubStatus] = useState<{ shared: boolean; id?: string; slug?: string; version?: string }>({ shared: false });
  const [shareInProgress, setShareInProgress] = useState(false);
  const [contentDirty, setContentDirty] = useState(false);
  const [showVersionBump, setShowVersionBump] = useState(false);
  const [showShareMode, setShowShareMode] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);

  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editVersion, setEditVersion] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editIcon, setEditIcon] = useState('');

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.builder.artifacts.get(type, name);
      setFiles(data.files ?? {});
      setArtPath(data.path ?? '');
      const manifestFile = data.files[`${type}.json`] ?? data.files['agent.json'] ?? data.files['team.json'] ?? data.files['skill.json'];
      if (manifestFile) {
        const parsed = JSON.parse(manifestFile) as ManifestData;
        setManifest(parsed);
        setEditName(parsed.displayName || parsed.name || name);
        setEditDesc(parsed.description || '');
        setEditVersion(parsed.version || '1.0.0');
        setEditCategory(parsed.category || 'general');
        setEditTags(parsed.tags || []);
        setEditIcon(parsed.icon || '');
      }
    } catch (err) {
      console.error('Failed to load artifact:', err);
    } finally {
      setLoading(false);
    }
  }, [type, name]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    hubApi.myItems().then(data => {
      const items = data?.items ?? [];
      const typeDir = type === 'agent' ? 'agent' : type === 'team' ? 'team' : 'skill';
      for (const hi of items) {
        if (hi.itemType === typeDir && (hi.slug === name || hi.name === name)) {
          setHubStatus({ shared: true, id: hi.id, slug: hi.slug, version: hi.version });
          return;
        }
      }
    }).catch(() => {});
  }, [type, name]);

  const doSave = useCallback(async (updates: Partial<ManifestData>) => {
    if (!manifest) return;
    setSaveStatus('saving');
    try {
      const updated = { ...manifest, ...updates };
      await api.builder.artifacts.save(type as 'agent' | 'team' | 'skill', updated);
      setManifest(updated);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(s => s === 'saved' ? 'idle' : s), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [manifest, type]);

  const scheduleSave = useCallback((updates: Partial<ManifestData>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => doSave(updates), 800);
  }, [doSave]);

  const handleFieldChange = useCallback((field: string, value: string | string[] | undefined) => {
    const updates: Partial<ManifestData> = {};
    if (field === 'displayName') { setEditName(value as string); updates.displayName = value as string; setContentDirty(true); }
    else if (field === 'description') { setEditDesc(value as string); updates.description = value as string; setContentDirty(true); }
    else if (field === 'version') {
      setEditVersion(value as string); updates.version = value as string;
      setContentDirty(false);
      setShowVersionBump(false);
    }
    else if (field === 'category') { setEditCategory(value as string); updates.category = value as string; setContentDirty(true); }
    else if (field === 'tags') { setEditTags(value as string[]); updates.tags = value as string[]; setContentDirty(true); }
    else if (field === 'icon') { setEditIcon(value as string); updates.icon = (value as string) || undefined; setContentDirty(true); }
    scheduleSave({ ...manifest, ...updates });
  }, [manifest, scheduleSave]);

  const handleFileSave = useCallback(async (filename: string, content: string) => {
    try {
      const updatedFiles = { ...files, [filename]: content };
      setFiles(updatedFiles);
      const artifactWithFiles = { ...manifest!, files: updatedFiles };
      await api.builder.artifacts.save(type as 'agent' | 'team' | 'skill', artifactWithFiles);
      setSaveStatus('saved');
      setContentDirty(true);
      setTimeout(() => setSaveStatus(s => s === 'saved' ? 'idle' : s), 2000);
    } catch {
      setSaveStatus('error');
    }
  }, [files, type, manifest]);

  const handleShareToHub = useCallback(async (opts?: { priceCents?: number; donationsEnabled?: boolean }) => {
    if (!manifest) return;
    setShareInProgress(true);
    try {
      await hubApi.ensureAuth();
      const artName = manifest.displayName || manifest.name || name;
      const description = manifest.description || '';
      const category = manifest.category || 'general';
      const tags = manifest.tags ?? [];
      const slug = name;
      let icon: string | undefined = manifest.icon || undefined;
      const version = manifest.version || '1.0.0';

      // If icon is a local image path, upload it to Hub
      if (icon && !icon.startsWith('http') && /\.(png|jpe?g|gif|webp|svg)$/i.test(icon)) {
        const iconFilename = icon.split('/').pop() ?? icon;
        try {
          const iconResp = await fetch(`/api/builder/artifacts/${type}s/${encodeURIComponent(name)}/images/${encodeURIComponent(iconFilename)}`);
          if (iconResp.ok) {
            const blob = await iconResp.blob();
            const file = new File([blob], iconFilename, { type: blob.type });
            const uploaded = await hubApi.uploadImage(file);
            if (uploaded?.url) icon = uploaded.url;
          }
        } catch { /* keep original icon */ }
      }

      let thumbnailUrl: string | undefined;
      const hubImages: Array<{ url: string; alt: string; order: number }> = [];
      const screenshots = manifest.screenshots ?? [];
      for (let i = 0; i < screenshots.length; i++) {
        const imgPath = screenshots[i]!;
        const filename = imgPath.split('/').pop() ?? imgPath;
        try {
          const imgResp = await fetch(`/api/builder/artifacts/${type}s/${encodeURIComponent(name)}/images/${encodeURIComponent(filename)}`);
          if (imgResp.ok) {
            const blob = await imgResp.blob();
            const file = new File([blob], filename, { type: blob.type });
            const uploaded = await hubApi.uploadImage(file);
            if (uploaded?.url) {
              hubImages.push({ url: uploaded.url, alt: filename, order: i });
              if (i === 0) thumbnailUrl = uploaded.url;
            }
          }
        } catch { /* skip */ }
      }

      const result = await hubApi.publishViaProxy({
        itemType: type === 'team' ? 'team' : type === 'skill' ? 'skill' : 'agent',
        name: artName,
        slug,
        description,
        category,
        tags,
        icon,
        version,
        config: manifest,
        files: Object.keys(files).length > 0 ? files : undefined,
        thumbnailUrl,
        images: hubImages.length > 0 ? hubImages : undefined,
        priceCents: opts?.priceCents,
        donationsEnabled: opts?.donationsEnabled,
      });
      if (result.id) {
        setHubStatus({ shared: true, id: result.id, slug: result.slug ?? slug, version });
        setContentDirty(false);
      }
    } catch (err) {
      console.error('Share to Hub failed:', err);
      alert(String(err));
    } finally {
      setShareInProgress(false);
    }
  }, [manifest, files, type, name]);

  const handleImageUpload = async (file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    try {
      await fetch(`/api/builder/artifacts/${type}s/${encodeURIComponent(name)}/images`, { method: 'POST', body: formData, credentials: 'include' });
      await load();
      setContentDirty(true);
    } catch (err) { console.error('Image upload failed:', err); }
  };

  const handleImageRemove = async (filename: string) => {
    try {
      await fetch(`/api/builder/artifacts/${type}s/${encodeURIComponent(name)}/images/${encodeURIComponent(filename)}`, { method: 'DELETE', credentials: 'include' });
      await load();
      setContentDirty(true);
    } catch (err) { console.error('Image remove failed:', err); }
  };

  const style = TYPE_STYLES[type] ?? TYPE_STYLES.agent!;
  const imageFiles = manifest?.screenshots ?? [];
  const skillFile = manifest?.skill?.skillFile ? files[manifest.skill.skillFile] : (files['SKILL.md'] ?? files['README.md']);

  const agentFiles = useMemo(() => {
    if (type !== 'agent') return [];
    return Object.entries(files).filter(([f]) =>
      !f.endsWith('.json') && !f.startsWith('images/') && !f.startsWith('members/')
    );
  }, [files, type]);

  const teamTopFiles = useMemo(() => {
    if (type !== 'team') return [];
    return Object.entries(files).filter(([f]) =>
      !f.endsWith('.json') && !f.startsWith('images/') && !f.startsWith('members/')
    );
  }, [files, type]);

  const nonManifestFiles = useMemo(() => {
    if (type === 'agent' || type === 'team') return [];
    const shownFiles = new Set<string>();
    if (type === 'skill') {
      const sf = manifest?.skill?.skillFile;
      if (sf && files[sf]) shownFiles.add(sf);
      if (!sf && files['SKILL.md']) shownFiles.add('SKILL.md');
      if (!sf && !files['SKILL.md'] && files['README.md']) shownFiles.add('README.md');
    }
    return Object.entries(files).filter(([f]) =>
      !f.endsWith('.json') && !f.startsWith('images/') && !f.startsWith('members/') && !shownFiles.has(f)
    );
  }, [files, type, manifest?.skill?.skillFile]);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-8">
          <button onClick={onBack} className="text-xs text-brand-400 hover:text-brand-300 mb-4 inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            {t('detail.backToBuilder')}
          </button>
          <div className="text-fg-tertiary text-sm animate-pulse py-20 text-center">{t('common:loading')}</div>
        </div>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-8">
          <button onClick={onBack} className="text-xs text-brand-400 hover:text-brand-300 mb-4 inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            {t('detail.backToBuilder')}
          </button>
          <div className="text-fg-tertiary text-sm py-20 text-center">{t('detail.notFound')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={`${isMobile ? 'px-4 py-5' : 'px-6 py-8'}`}>
        {/* Top bar */}
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBack} className="text-xs text-brand-400 hover:text-brand-300 inline-flex items-center gap-1">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            {t('detail.backToBuilder')}
          </button>
          <div className="flex items-center gap-2">
            {saveStatus === 'saving' && <span className="text-[10px] text-fg-muted animate-pulse">{t('detail.saving')}</span>}
            {saveStatus === 'saved' && <span className="text-[10px] text-green-500 inline-flex items-center gap-1"><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>{t('detail.saved')}</span>}
            {saveStatus === 'error' && <span className="text-[10px] text-red-500">{t('detail.saveFailed')}</span>}
            {hubStatus.shared && (() => {
              const hubUser = hubApi.getUser();
              const link = hubUser && hubStatus.slug ? `${hubApi.getUrl()}/${encodeURIComponent(hubUser.username)}/${encodeURIComponent(hubStatus.slug)}` : null;
              const localVersion = editVersion || manifest?.version || '1.0.0';
              const hasNewVersion = hubStatus.version !== localVersion;
              return (
                <>
                  {link && (
                    <a href={link} target="_blank" rel="noopener noreferrer"
                      className="text-xs px-3 py-1.5 rounded-lg border border-green-600/30 text-green-600 hover:text-green-500 hover:border-green-500/50 transition-colors inline-flex items-center gap-1.5">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      {t('share.viewOnHub')}
                    </a>
                  )}
                  {hasNewVersion && (
                    <button onClick={() => PAYMENTS_ENABLED ? setShowShareMode(true) : void handleShareToHub()} disabled={shareInProgress}
                      className="text-xs px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-colors disabled:opacity-50">
                      {shareInProgress ? t('share.updating') : t('share.updateVersion', { version: localVersion })}
                    </button>
                  )}
                </>
              );
            })()}
            {!hubStatus.shared && (
              <button onClick={() => PAYMENTS_ENABLED ? setShowShareMode(true) : void handleShareToHub()} disabled={shareInProgress}
                className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50">
                {shareInProgress ? t('share.sharing') : t('share.toHub')}
              </button>
            )}
          </div>
        </div>

        {/* Version bump notification */}
        {contentDirty && !showVersionBump && (
          <div className="mb-4 px-4 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-between">
            <span className="text-xs text-amber-300">{t('versionBump.contentModified')}</span>
            <button onClick={() => setShowVersionBump(true)} className="text-xs px-3 py-1 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors">
              {t('versionBump.bumpVersion')}
            </button>
          </div>
        )}
        {showVersionBump && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-center gap-3">
              <span className="text-xs text-amber-300">{t('versionBump.newVersion')}</span>
              <input
                type="text"
                defaultValue={(() => {
                  const parts = (editVersion || '1.0.0').split('.');
                  parts[2] = String(Number(parts[2] ?? 0) + 1);
                  return parts.join('.');
                })()}
                className="text-xs px-2 py-1 rounded bg-surface-elevated border border-border-default text-fg-primary w-24 font-mono"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleFieldChange('version', (e.target as HTMLInputElement).value);
                  }
                }}
              />
              <button onClick={(e) => {
                const input = (e.target as HTMLElement).parentElement?.querySelector('input');
                if (input) handleFieldChange('version', input.value);
              }} className="text-xs px-3 py-1 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors">
                {t('common:confirm')}
              </button>
              <button onClick={() => setShowVersionBump(false)} className="text-xs text-fg-tertiary hover:text-fg-secondary">
                {t('common:cancel')}
              </button>
            </div>
            {hubStatus.shared && <p className="text-[10px] text-fg-tertiary mt-2">After bumping the version, you can share the new version to Hub.</p>}
          </div>
        )}

        {/* Two-column layout */}
        <div className={`flex gap-8 ${isMobile ? 'flex-col' : ''}`}>
          {/* Left column: main content */}
          <div className={`${isMobile ? 'w-full' : 'flex-1 min-w-0'}`}>
            {/* Hero: icon + title + desc (all inline editable) */}
            <div className="flex items-start gap-4 mb-6">
              <div className="relative">
                <div onClick={() => setShowIconPicker(!showIconPicker)}
                  className={`w-16 h-16 rounded-xl ${style.bg} flex items-center justify-center text-3xl shrink-0 cursor-pointer hover:ring-2 ${style.ring} transition-all overflow-hidden`}>
                  {editIcon && editIcon.startsWith('images/')
                    ? <img src={`/api/builder/artifacts/${type}s/${encodeURIComponent(name)}/images/${encodeURIComponent(editIcon.replace('images/', ''))}`} alt="" className="w-full h-full object-cover" />
                    : editIcon && (editIcon.startsWith('http') || editIcon.startsWith('/'))
                      ? <img src={editIcon} alt="" className="w-full h-full object-cover" />
                      : (editIcon || style.icon)}
                </div>
                {showIconPicker && (
                  <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowIconPicker(false)} />
                  <div className="absolute top-full left-0 mt-2 z-50 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-80">
                    <div className="flex items-center gap-2 mb-3">
                      <input
                        type="text" placeholder={t('detail.pasteEmojiOrUrl')}
                        className="flex-1 text-sm px-2 py-1.5 rounded-lg bg-surface-elevated border border-border-default text-fg-primary placeholder:text-fg-muted"
                        defaultValue={editIcon}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            handleFieldChange('icon', (e.target as HTMLInputElement).value);
                            setShowIconPicker(false);
                          }
                        }}
                      />
                      <label className="text-[10px] text-brand-400 hover:text-brand-300 cursor-pointer px-1.5 py-1 border border-brand-500/30 rounded-lg">
                        {t('detail.upload')}
                        <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const formData = new FormData();
                          formData.append('image', file);
                          try {
                            const resp = await fetch(`/api/builder/artifacts/${type}s/${encodeURIComponent(name)}/images`, { method: 'POST', body: formData, credentials: 'include' });
                            if (resp.ok) {
                              const data = await resp.json() as { filename: string; path: string };
                              const iconPath = data.path;
                              setEditIcon(iconPath);
                              setShowIconPicker(false);
                              if (manifest) {
                                const updated = { ...manifest, icon: iconPath };
                                setManifest(updated);
                                await api.builder.artifacts.save(type as 'agent' | 'team' | 'skill', updated);
                              }
                              setContentDirty(true);
                            }
                          } catch { /* skip */ }
                        }} />
                      </label>
                      {editIcon && <button onClick={() => { handleFieldChange('icon', ''); setShowIconPicker(false); }}
                        className="text-[10px] text-fg-tertiary hover:text-red-400 px-1">✕</button>}
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {EMOJI_GROUPS.map(g => (
                        <div key={g.label} className="mb-2.5">
                          <div className="text-[10px] text-fg-tertiary mb-1 sticky top-0 bg-gray-900 py-0.5">{g.label}</div>
                          <div className="flex flex-wrap gap-0.5">
                            {g.emojis.map(e => (
                              <button key={e} onClick={() => { handleFieldChange('icon', e); setShowIconPicker(false); }}
                                className={`w-7 h-7 rounded flex items-center justify-center text-base hover:bg-surface-elevated transition-colors ${editIcon === e ? 'ring-1.5 ring-brand-500 bg-brand-500/10' : ''}`}>
                                {e}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  </>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <InlineEditable value={editName} onChange={v => handleFieldChange('displayName', v)} renderAs="h1" className="text-xl font-bold text-fg-primary" placeholder={t('detail.untitled')} />
                  <span className={`text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full ${style.bg} ${style.color}`}>{style.label}</span>
                  <InlineEditable value={editVersion} onChange={v => handleFieldChange('version', v)} renderAs="badge"
                    className="text-[10px] px-2 py-0.5 rounded-full bg-surface-elevated text-fg-tertiary border border-border-default font-mono" placeholder="1.0.0" />
                </div>
                <InlineEditable value={editDesc} onChange={v => handleFieldChange('description', v)} renderAs="p"
                  className="text-sm text-fg-secondary mt-1.5 leading-relaxed" placeholder={t('detail.addDescription')} multiline />
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <InlineSelect value={editCategory} options={CATEGORIES} onChange={v => handleFieldChange('category', v)}
                    className="text-xs px-2 py-0.5 rounded bg-surface-elevated text-fg-tertiary" />
                  <InlineTags tags={editTags} onChange={v => handleFieldChange('tags', v)} />
                </div>
              </div>
            </div>

            {/* Image gallery */}
            <div className="mb-8">
              <ImageGallery images={imageFiles} artifactType={type} artifactName={name} onUpload={handleImageUpload} onRemove={handleImageRemove} />
            </div>

            {/* Type-specific sections */}
            {type === 'team' && manifest.team && (
              <div className="mb-8">
                <TeamTabs members={manifest.team.members} teamTopFiles={teamTopFiles} files={files} onFileSave={handleFileSave} />
              </div>
            )}

            {type === 'agent' && agentFiles.length > 0 && (
              <div className="mb-8">
                <h2 className="text-sm font-semibold text-fg-primary mb-4 uppercase tracking-wider">About This Agent</h2>
                <TabbedFiles noHeader files={agentFiles} onSave={handleFileSave} />
              </div>
            )}

            {type === 'skill' && (
              <div className="mb-8">
                {manifest.skill?.requiredPermissions && manifest.skill.requiredPermissions.length > 0 && (
                  <div className="mb-6">
                    <h2 className="text-sm font-semibold text-fg-primary mb-3 uppercase tracking-wider">{t('sidebar.permissions')}</h2>
                    <div className="flex flex-wrap gap-2">
                      {manifest.skill.requiredPermissions.map(p => {
                        const pi = PERMISSION_ICONS[p];
                        return (
                          <span key={p} className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-medium ${pi?.color ?? 'bg-surface-elevated text-fg-secondary border-border-default'}`}>
                            <span className="font-mono text-[10px]">{pi?.icon ?? '?'}</span> {p}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {manifest.skill?.mcpServers && Object.keys(manifest.skill.mcpServers).length > 0 && (
                  <div className="mb-6">
                    <h2 className="text-sm font-semibold text-fg-primary mb-3 uppercase tracking-wider">Integrations</h2>
                    <div className="grid gap-2">
                      {Object.entries(manifest.skill.mcpServers).map(([sname, config]) => (
                        <div key={sname} className="rounded-lg border border-border-default bg-surface-secondary/40 px-4 py-3 flex items-center gap-3">
                          <span className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center text-purple-400 text-sm shrink-0">◎</span>
                          <div>
                            <div className="text-xs font-medium text-fg-primary">{sname}</div>
                            <div className="text-[10px] text-fg-muted font-mono truncate">{typeof config === 'object' ? JSON.stringify(config).slice(0, 80) : String(config)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {skillFile && (
                  <div>
                    <h2 className="text-sm font-semibold text-fg-primary mb-3 uppercase tracking-wider">Instructions</h2>
                    <div className="rounded-xl border border-border-default bg-surface-secondary/40 p-5">
                      <RenderedMarkdown content={skillFile} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Files section (tabbed) */}
            {nonManifestFiles.length > 0 && (
              <TabbedFiles files={nonManifestFiles} onSave={handleFileSave} />
            )}
          </div>

          {/* Right column: sticky sidebar */}
          <div className={`${isMobile ? 'w-full' : 'w-72 shrink-0'}`}>
            <div className={`${isMobile ? '' : 'sticky top-6'} space-y-4`}>
              {/* Quick info card */}
              <div className="rounded-xl border border-border-default bg-surface-secondary/60 p-4 space-y-3">
                <div className="text-xs font-medium text-fg-tertiary uppercase tracking-wider">{t('sidebar.info')}</div>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.type')}</span><span className={`font-medium ${style.color}`}>{style.label}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.category')}</span><span className="text-fg-secondary">{editCategory}</span></div>
                  <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.version')}</span><span className="text-fg-secondary font-mono">{editVersion}</span></div>
                  {manifest.author && <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.author')}</span><span className="text-fg-secondary">{manifest.author}</span></div>}
                </div>
              </div>

              {/* Agent specs */}
              {type === 'agent' && manifest.agent && (
                <div className="rounded-xl border border-border-default bg-surface-secondary/60 p-4 space-y-3">
                  <div className="text-xs font-medium text-fg-tertiary uppercase tracking-wider">{t('sidebar.agentSpecs')}</div>
                  <div className="space-y-2 text-xs">
                    {manifest.agent.roleName && <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.role')}</span><span className="text-fg-secondary">{manifest.agent.roleName}</span></div>}
                    {manifest.agent.llmProvider && <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.provider')}</span><span className="text-fg-secondary">{manifest.agent.llmProvider}</span></div>}
                    {manifest.agent.llmModel && <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.model')}</span><span className="text-fg-secondary font-mono">{manifest.agent.llmModel}</span></div>}
                    {manifest.agent.temperature !== undefined && <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.temperature')}</span><span className="text-fg-secondary">{manifest.agent.temperature}</span></div>}
                  </div>
                </div>
              )}

              {/* Team composition */}
              {type === 'team' && manifest.team && (
                <div className="rounded-xl border border-border-default bg-surface-secondary/60 p-4 space-y-3">
                  <div className="text-xs font-medium text-fg-tertiary uppercase tracking-wider">{t('sidebar.composition')}</div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.totalMembers')}</span><span className="text-fg-secondary">{manifest.team.members.reduce((s, m) => s + m.count, 0)}</span></div>
                    <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.managers')}</span><span className="text-amber-400">{manifest.team.members.filter(m => m.role === 'manager').reduce((s, m) => s + m.count, 0)}</span></div>
                    <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.workers')}</span><span className="text-blue-400">{manifest.team.members.filter(m => m.role !== 'manager').reduce((s, m) => s + m.count, 0)}</span></div>
                  </div>
                </div>
              )}

              {/* Skill info */}
              {type === 'skill' && manifest.skill && (
                <div className="rounded-xl border border-border-default bg-surface-secondary/60 p-4 space-y-3">
                  <div className="text-xs font-medium text-fg-tertiary uppercase tracking-wider">{t('sidebar.skillInfo')}</div>
                  <div className="space-y-2 text-xs">
                    {manifest.skill.alwaysOn !== undefined && (
                      <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.alwaysOn')}</span>
                        <span className={manifest.skill.alwaysOn ? 'text-green-400' : 'text-fg-secondary'}>{manifest.skill.alwaysOn ? t('sidebar.yes') : t('sidebar.no')}</span>
                      </div>
                    )}
                    <div className="flex justify-between"><span className="text-fg-muted">{t('sidebar.skillFile')}</span><span className="text-fg-secondary font-mono truncate ml-2">{manifest.skill.skillFile}</span></div>
                    {manifest.skill.requiredPermissions && manifest.skill.requiredPermissions.length > 0 && (
                      <div><span className="text-fg-muted">{t('sidebar.permissions')}</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {manifest.skill.requiredPermissions.map(p => (
                            <span key={p} className="text-[10px] px-1.5 py-0.5 bg-surface-elevated text-fg-muted rounded border border-border-default">{p}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Dependencies */}
              {manifest.dependencies && (manifest.dependencies.skills?.length || manifest.dependencies.env?.length) ? (
                <div className="rounded-xl border border-border-default bg-surface-secondary/60 p-4 space-y-3">
                  <div className="text-xs font-medium text-fg-tertiary uppercase tracking-wider">{t('sidebar.dependencies')}</div>
                  {manifest.dependencies.skills?.length ? (
                    <div>
                      <div className="text-[10px] text-fg-muted mb-1">{t('sidebar.skills')}</div>
                      <div className="flex flex-wrap gap-1">
                        {manifest.dependencies.skills.map(s => <span key={s} className="text-[10px] px-2 py-0.5 bg-surface-elevated text-fg-secondary rounded border border-border-default">{s}</span>)}
                      </div>
                    </div>
                  ) : null}
                  {manifest.dependencies.env?.length ? (
                    <div>
                      <div className="text-[10px] text-fg-muted mb-1">{t('sidebar.environment')}</div>
                      <div className="flex flex-wrap gap-1">
                        {manifest.dependencies.env.map(e => <span key={e} className="text-[10px] px-2 py-0.5 bg-surface-elevated text-fg-secondary rounded font-mono border border-border-default">{e}</span>)}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}


              {/* Path */}
              {artPath && (
                <button onClick={() => api.system.openPath(artPath).catch(() => {})}
                  className="w-full text-left rounded-xl border border-border-default bg-surface-secondary/60 px-4 py-3 text-[10px] text-fg-muted hover:text-fg-secondary hover:border-gray-600 transition-colors truncate"
                  title={artPath}>
                  <span className="text-fg-tertiary block mb-0.5">{t('sidebar.openInFinder')}</span>
                  {artPath.replace(/.*\.markus\//, '~/.markus/')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {showShareMode && (
        <ShareModeDialog
          onClose={() => setShowShareMode(false)}
          onConfirm={(mode, price) => {
            setShowShareMode(false);
            void handleShareToHub({
              donationsEnabled: mode === 'donation',
              priceCents: mode === 'paid' ? price : undefined,
            });
          }}
          isUpdate={hubStatus.shared}
        />
      )}
    </div>
  );
}

function ShareModeDialog({ onClose, onConfirm, isUpdate }: {
  onClose: () => void;
  onConfirm: (mode: 'free' | 'donation' | 'paid', priceCents: number) => void;
  isUpdate: boolean;
}) {
  const { t } = useTranslation(['builder', 'common']);
  const [mode, setMode] = useState<'free' | 'donation' | 'paid'>('free');
  const [price, setPrice] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-fg-primary mb-4">
          {isUpdate ? t('shareMode.titleUpdate') : t('share.toHub')}
        </h3>

        <div className="space-y-2 mb-5">
          <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${mode === 'free' ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
            <input type="radio" name="shareMode" checked={mode === 'free'} onChange={() => setMode('free')} className="accent-brand-500" />
            <div>
              <div className="text-sm font-medium text-fg-primary">{t('shareMode.free')}</div>
              <div className="text-[11px] text-fg-tertiary">{t('shareMode.freeDesc')}</div>
            </div>
          </label>
          <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${mode === 'donation' ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
            <input type="radio" name="shareMode" checked={mode === 'donation'} onChange={() => setMode('donation')} className="accent-brand-500" />
            <div>
              <div className="text-sm font-medium text-fg-primary">{t('shareMode.donation')}</div>
              <div className="text-[11px] text-fg-tertiary">{t('shareMode.donationDesc')}</div>
            </div>
          </label>
          <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${mode === 'paid' ? 'border-brand-500 bg-brand-500/10' : 'border-border-default hover:border-gray-600'}`}>
            <input type="radio" name="shareMode" checked={mode === 'paid'} onChange={() => setMode('paid')} className="accent-brand-500" />
            <div>
              <div className="text-sm font-medium text-fg-primary">{t('shareMode.paid')}</div>
              <div className="text-[11px] text-fg-tertiary">{t('shareMode.paidDesc')}</div>
            </div>
          </label>
        </div>

        {mode === 'paid' && (
          <div className="mb-5">
            <label className="text-xs text-fg-secondary block mb-1.5">{t('shareMode.priceLabel')}</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-fg-tertiary">$</span>
              <input
                type="number" min="0.5" step="0.5" value={price}
                onChange={e => setPrice(e.target.value)}
                placeholder={t('shareMode.pricePlaceholder')}
                className="flex-1 text-sm px-3 py-2 rounded-lg bg-surface-elevated border border-border-default text-fg-primary placeholder:text-fg-muted"
              />
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 text-sm px-4 py-2 rounded-lg border border-border-default text-fg-secondary hover:text-fg-primary hover:border-gray-600 transition-colors">
            {t('common:cancel')}
          </button>
          <button
            onClick={() => onConfirm(mode, mode === 'paid' ? Math.round(Number(price) * 100) : 0)}
            disabled={mode === 'paid' && (!price || Number(price) <= 0)}
            className="flex-1 text-sm px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {isUpdate ? t('shareMode.update') : t('shareMode.share')}
          </button>
        </div>
      </div>
    </div>
  );
}
