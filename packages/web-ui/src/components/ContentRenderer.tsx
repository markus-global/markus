import { useRef, useEffect, useState, lazy, Suspense, useMemo } from 'react';

const LazyMarkdownMessage = lazy(() =>
  import('./MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage }))
);

interface ContentRendererProps {
  content: string;
  format?: string;
  className?: string;
  /** Base directory for resolving relative image paths in markdown */
  basePath?: string;
}

/**
 * Detect content format from a file path extension.
 * Returns undefined if no known format is matched.
 */
export function detectFormatFromPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'html':
    case 'htm':
      return 'html';
    case 'json':
      return 'json';
    case 'csv':
    case 'tsv':
      return 'csv';
    default:
      return undefined;
  }
}

/**
 * Detect content format by sniffing the content itself.
 * Returns undefined if no known format is matched.
 */
export function detectFormatFromContent(content: string): string | undefined {
  const trimmed = content.trimStart();
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return 'html';
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(content);
      return 'json';
    } catch { /* not valid JSON */ }
  }
  return undefined;
}

/**
 * Resolve the effective format for content using a fallback chain:
 * 1. Explicit format field (highest priority)
 * 2. File extension of reference path
 * 3. Content sniffing
 * 4. Default to 'markdown'
 */
export function resolveFormat(opts: {
  format?: string;
  reference?: string;
  content?: string;
}): string {
  if (opts.format) return opts.format;
  if (opts.reference) {
    const detected = detectFormatFromPath(opts.reference);
    if (detected) return detected;
  }
  if (opts.content) {
    const detected = detectFormatFromContent(opts.content);
    if (detected) return detected;
  }
  return 'markdown';
}

function HtmlPreview({ content, className }: { content: string; className?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const onLoad = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          const h = doc.documentElement.scrollHeight;
          if (h > 0) setHeight(Math.min(h + 16, 3000));
        }
      } catch { /* cross-origin — keep default height */ }
    };

    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [content]);

  const themedContent = useMemo(() => {
    if (/<html[\s>]/i.test(content)) return content;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0; padding: 16px;
    color: #e4e4e7; background: transparent;
    line-height: 1.6;
  }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { border: 1px solid #3f3f46; padding: 6px 10px; text-align: left; }
  th { background: rgba(63,63,70,0.5); font-weight: 600; }
  a { color: #818cf8; }
  code { background: rgba(63,63,70,0.5); padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
  pre { background: rgba(24,24,27,0.8); padding: 12px; border-radius: 6px; overflow-x: auto; }
  img { max-width: 100%; height: auto; }
  h1, h2, h3, h4, h5, h6 { color: #fafafa; }
</style>
</head>
<body>${content}</body>
</html>`;
  }, [content]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={themedContent}
      sandbox="allow-scripts"
      className={className}
      style={{
        width: '100%',
        height: `${height}px`,
        border: 'none',
        borderRadius: '8px',
        background: 'transparent',
      }}
      title="HTML Preview"
    />
  );
}

function JsonPreview({ content, className }: { content: string; className?: string }) {
  const formatted = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }, [content]);

  return (
    <pre className={`text-xs font-mono whitespace-pre-wrap break-words bg-surface-primary/50 rounded-lg p-4 leading-relaxed text-fg-secondary ${className ?? ''}`}>
      {formatted}
    </pre>
  );
}

export function ContentRenderer({ content, format, className, basePath }: ContentRendererProps) {
  switch (format) {
    case 'html':
      return <HtmlPreview content={content} className={className} />;

    case 'json':
      return <JsonPreview content={content} className={className} />;

    case 'csv':
    case 'text':
      return (
        <pre className={`text-xs font-mono whitespace-pre-wrap break-words bg-surface-primary/50 rounded-lg p-4 leading-relaxed text-fg-secondary ${className ?? ''}`}>
          {content}
        </pre>
      );

    case 'markdown':
    default:
      return (
        <Suspense fallback={<div className="text-xs text-fg-tertiary">Loading…</div>}>
          <LazyMarkdownMessage content={content} className={className ?? 'text-sm'} basePath={basePath} />
        </Suspense>
      );
  }
}
