import { useState, useEffect, useRef, useCallback } from 'react';

export interface SlashCommand {
  name: string;
  description: string;
  icon: string;
  action: (args: string) => void;
}

interface Props {
  commands: SlashCommand[];
  query: string;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
  anchorRect?: DOMRect | null;
}

export function SlashCommandMenu({ commands, query, onSelect, onClose, anchorRect }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = commands.filter(c =>
    c.name.toLowerCase().includes(query.toLowerCase()) ||
    c.description.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => { setSelectedIdx(0); }, [query]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIdx]) {
      e.preventDefault();
      onSelect(filtered[selectedIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [filtered, selectedIdx, onSelect, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  const style: React.CSSProperties = anchorRect ? {
    position: 'fixed',
    bottom: window.innerHeight - anchorRect.top + 8,
    left: anchorRect.left,
    minWidth: 280,
    maxWidth: 400,
  } : {};

  return (
    <div
      ref={menuRef}
      className="z-50 bg-surface-2 border border-border-default rounded-lg shadow-lg overflow-hidden"
      style={style}
    >
      <div className="px-3 py-1.5 text-[10px] text-fg-quaternary uppercase tracking-wider border-b border-border-subtle">
        Commands
      </div>
      <div className="max-h-64 overflow-y-auto">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.name}
            onClick={() => onSelect(cmd)}
            className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
              i === selectedIdx ? 'bg-brand-600/15 text-fg-primary' : 'text-fg-secondary hover:bg-surface-elevated/30'
            }`}
          >
            <span className="text-base shrink-0">{cmd.icon}</span>
            <div className="min-w-0">
              <div className="text-sm font-medium">/{cmd.name}</div>
              <div className="text-[11px] text-fg-tertiary truncate">{cmd.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
