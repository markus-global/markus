import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SearchResult } from '../api.js';

// ─── Highlight renderer ───────────────────────────────────────────

/**
 * Renders text with optional <mark> tags from FTS5 snippet.
 * Falls back to query-based highlighting when no snippetText is available.
 */
function renderHighlightedText(text: string, query: string): ReactNode {
  // If text contains <mark> tags (FTS5 snippet), render them with dangerouslySetInnerHTML.
  // We use a custom parser since we only allow <mark> tags for security.
  if (text.includes('<mark>')) {
    const parts: ReactNode[] = [];
    const regex = /<mark>(.*?)<\/mark>|([^<]+(?!<\/mark>))|<[^>]+>/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let key = 0;

    while ((match = regex.exec(text)) !== null) {
      if (match[1] !== undefined) {
        // Matched <mark>content</mark>
        parts.push(
          <mark key={key++} className="bg-amber-400/20 text-amber-400 rounded-sm px-0.5">
            {match[1]}
          </mark>
        );
      } else if (match[0]) {
        // Regular text
        parts.push(<span key={key++}>{match[0]}</span>);
      }
      lastIndex = match.index + match[0].length;
    }

    // Remaining text after last match
    if (lastIndex < text.length) {
      parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
    }

    return parts.length > 0 ? parts : text;
  }

  // Fallback: client-side query highlighting (case-insensitive)
  if (!query || query.length < 2) return text;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  if (parts.length === 1) return text;

  return parts.map((part, i) =>
    regex.test(part)
      ? <mark key={i} className="bg-amber-400/20 text-amber-400 rounded-sm px-0.5">{part}</mark>
      : part
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function truncateText(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

// ─── Component ────────────────────────────────────────────────────

interface SearchResultItemProps {
  result: SearchResult;
  query: string;
  selected?: boolean;
  onSelect: (result: SearchResult) => void;
}

export function SearchResultItem({ result, query, selected, onSelect }: SearchResultItemProps) {
  const { t } = useTranslation(['team', 'common']);

  // Determine the display text — prefer snippetText (with <mark> tags) from FTS5
  const displayText = result.snippetText ?? truncateText(result.text);

  const highlighted = useMemo(
    () => renderHighlightedText(displayText, query),
    [displayText, query]
  );

  return (
    <button
      onClick={() => onSelect(result)}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors group ${
        selected
          ? 'bg-brand-500/15 ring-1 ring-brand-500/30'
          : 'hover:bg-surface-elevated'
      }`}
    >
      {/* Meta row: source badge + sender + date */}
      <div className="flex items-center gap-2 text-[11px] text-fg-tertiary mb-1">
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
            result.source === 'channel'
              ? 'bg-blue-500/10 text-blue-500'
              : 'bg-emerald-500/10 text-emerald-500'
          }`}
        >
          {result.source === 'channel' ? '#' : '1:1'}
        </span>
        {result.senderName && <span className="truncate max-w-[120px]">{result.senderName}</span>}
        <span className="shrink-0">{formatDate(result.createdAt)}</span>
        {result.sessionName && (
          <span className="hidden sm:inline truncate text-fg-tertiary/70">
            · {result.sessionName}
          </span>
        )}
      </div>

      {/* Message content with highlights */}
      <div className="text-xs text-fg-secondary line-clamp-2 group-hover:text-fg-primary transition-colors leading-relaxed">
        {highlighted}
      </div>

      {/* Footer: match count + jump hint */}
      <div className="flex items-center gap-3 mt-1 pt-0.5 text-[10px] text-fg-tertiary/60">
        {result.matchCount !== undefined && result.matchCount > 1 && (
          <span>{result.matchCount} matches</span>
        )}
        <span className="ml-auto text-brand-500/70 group-hover:text-brand-500 transition-colors">
          {t('page.searchJump') || 'Jump →'}
        </span>
      </div>
    </button>
  );
}
