import { useRef, useEffect, useState, lazy, Suspense, useMemo } from 'react';

const LazyMarkdownMessage = lazy(() =>
  import('./MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage }))
);

export interface HtmlSelectionData {
  text: string;
  xpath: string;
  cssSelector: string;
  rect: { x: number; y: number; width: number; height: number };
}

interface ContentRendererProps {
  content: string;
  format?: string;
  className?: string;
  /** Base directory for resolving relative image paths in markdown */
  basePath?: string;
  /** Called when user selects text inside an HTML preview iframe */
  onHtmlSelection?: (data: HtmlSelectionData) => void;
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

function HtmlPreview({ content, className, onSelection }: { content: string; className?: string; onSelection?: (data: HtmlSelectionData) => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === '__htmlpreview_height' && typeof e.data.height === 'number') {
        setHeight(e.data.height);
      }
      if (e.data?.type === '__htmlpreview_selection' && onSelection) {
        onSelection(e.data as HtmlSelectionData);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onSelection]);

  const selectionScript = `<script>
(function(){
  function getXPath(el){
    if(!el||el.nodeType!==1)return'';
    var parts=[];var node=el;
    while(node&&node.nodeType===1){
      var idx=1;var sib=node.previousElementSibling;
      while(sib){idx++;sib=sib.previousElementSibling;}
      var tag=node.tagName.toLowerCase();
      parts.unshift(tag+'['+idx+']');
      node=node.parentElement;
    }
    return'/'+parts.join('/');
  }
  function getCssSelector(el){
    if(!el||el.nodeType!==1)return'';
    var parts=[];var node=el;
    while(node&&node.nodeType===1&&node!==document.body){
      var sel=node.tagName.toLowerCase();
      if(node.id){sel+='#'+node.id;parts.unshift(sel);break;}
      var nth=1;var sib=node.previousElementSibling;
      while(sib){if(sib.tagName===node.tagName)nth++;sib=sib.previousElementSibling;}
      var total=1;sib=node.nextElementSibling;
      while(sib){if(sib.tagName===node.tagName)total++;sib=sib.nextElementSibling;}
      if(total>0||nth>1)sel+=':nth-of-type('+nth+')';
      parts.unshift(sel);node=node.parentElement;
    }
    return parts.join(' > ');
  }
  document.addEventListener('mouseup',function(){
    var sel=window.getSelection();
    if(!sel||sel.isCollapsed||!sel.toString().trim())return;
    var text=sel.toString().trim();
    var range=sel.getRangeAt(0);
    var container=range.startContainer;
    var el=container.nodeType===1?container:container.parentElement;
    var rect=range.getBoundingClientRect();
    parent.postMessage({
      type:'__htmlpreview_selection',
      text:text,
      xpath:getXPath(el),
      cssSelector:getCssSelector(el),
      rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}
    },'*');
  });
})();
</script>`;

  const heightScript = `<script>
(function(){
  function send(){
    var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    if(h>0) parent.postMessage({type:'__htmlpreview_height',height:h},'*');
  }
  if(document.readyState==='complete') send();
  else window.addEventListener('load',send);
  new ResizeObserver(send).observe(document.body);
})();
</script>`;
  const sizeFixStyle = '<style>html,body{overflow:hidden!important;height:auto!important;}</style>';

  const themedContent = useMemo(() => {
    const inject = sizeFixStyle + heightScript + selectionScript;
    if (/<html[\s>]/i.test(content)) {
      let result = content;
      if (/<\/body>/i.test(result))
        result = result.replace(/<\/body>/i, `${inject}</body>`);
      else if (/<\/html>/i.test(result))
        result = result.replace(/<\/html>/i, `${inject}</html>`);
      else
        result = result + inject;
      return result;
    }
    const isDark = !document.documentElement.classList.contains('light') &&
      (document.documentElement.classList.contains('dark') ||
       document.documentElement.classList.contains('cyberpunk') ||
       !window.matchMedia('(prefers-color-scheme: light)').matches);
    const colors = isDark
      ? { text: '#e4e4e7', bg: 'transparent', border: '#3f3f46', thBg: 'rgba(63,63,70,0.5)', link: '#818cf8', codeBg: 'rgba(63,63,70,0.5)', preBg: 'rgba(24,24,27,0.8)', heading: '#fafafa' }
      : { text: '#1c1c1e', bg: 'transparent', border: '#d1d5db', thBg: 'rgba(0,0,0,0.04)', link: '#4f46e5', codeBg: 'rgba(0,0,0,0.05)', preBg: 'rgba(0,0,0,0.03)', heading: '#111827' };
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0; padding: 16px;
    color: ${colors.text}; background: ${colors.bg};
    line-height: 1.6;
    overflow: hidden;
  }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { border: 1px solid ${colors.border}; padding: 6px 10px; text-align: left; }
  th { background: ${colors.thBg}; font-weight: 600; }
  a { color: ${colors.link}; }
  code { background: ${colors.codeBg}; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
  pre { background: ${colors.preBg}; padding: 12px; border-radius: 6px; overflow-x: auto; }
  img { max-width: 100%; height: auto; }
  h1, h2, h3, h4, h5, h6 { color: ${colors.heading}; }
</style>
</head>
<body>${content}${heightScript}${selectionScript}</body>
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
        height: height != null ? `${height}px` : 'auto',
        minHeight: height == null ? '200px' : undefined,
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

export function ContentRenderer({ content, format, className, basePath, onHtmlSelection }: ContentRendererProps) {
  switch (format) {
    case 'html':
      return <HtmlPreview content={content} className={className} onSelection={onHtmlSelection} />;

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
