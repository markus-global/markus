export function buildStyledHtml(sourceEl: HTMLElement, theme: 'light' | 'dark'): string {
  const clone = sourceEl.cloneNode(true) as HTMLElement;
  const t = theme === 'light'
    ? {
        bg: '#ffffff', text: '#24292f', heading: '#1f2328', strong: '#1f2328',
        link: '#0969da', codeBg: '#eff1f3', codeText: '#24292f',
        preBg: '#f6f8fa', preText: '#24292f', preBorder: '#d0d7de',
        border: '#d0d7de', blockquoteBorder: '#d0d7de', blockquoteText: '#656d76',
        tableBorder: '#d0d7de', tableHeaderBg: '#f6f8fa', tableHeaderText: '#24292f',
        hrColor: '#d8dee4',
      }
    : {
        bg: '#0d1117', text: '#e6edf3', heading: '#f0f6fc', strong: '#f0f6fc',
        link: '#58a6ff', codeBg: '#161b22', codeText: '#e6edf3',
        preBg: '#161b22', preText: '#e6edf3', preBorder: '#30363d',
        border: '#30363d', blockquoteBorder: '#3b82f6', blockquoteText: '#8b949e',
        tableBorder: '#30363d', tableHeaderBg: '#161b22', tableHeaderText: '#e6edf3',
        hrColor: '#21262d',
      };

  const styleMap: Record<string, string> = {
    'p': `margin:0 0 10px;color:${t.text};line-height:1.7;`,
    'h1': `font-size:1.6em;font-weight:700;color:${t.heading};margin:20px 0 10px;line-height:1.3;border-bottom:1px solid ${t.border};padding-bottom:6px;`,
    'h2': `font-size:1.35em;font-weight:700;color:${t.heading};margin:18px 0 8px;line-height:1.3;`,
    'h3': `font-size:1.15em;font-weight:600;color:${t.heading};margin:14px 0 6px;line-height:1.3;`,
    'h4': `font-size:1em;font-weight:600;color:${t.heading};margin:12px 0 4px;`,
    'strong': `font-weight:600;color:${t.strong};`,
    'em': `font-style:italic;`,
    'a': `color:${t.link};text-decoration:underline;`,
    'ul': `padding-left:1.5em;margin:0 0 10px;`,
    'ol': `padding-left:1.5em;margin:0 0 10px;`,
    'li': `margin:3px 0;line-height:1.7;color:${t.text};`,
    'blockquote': `border-left:3px solid ${t.blockquoteBorder};padding:2px 0 2px 14px;margin:10px 0;color:${t.blockquoteText};`,
    'hr': `border:none;border-top:1px solid ${t.hrColor};margin:20px 0;`,
    'table': `border-collapse:collapse;width:100%;margin:10px 0;`,
    'thead': `background:${t.tableHeaderBg};`,
    'th': `border:1px solid ${t.tableBorder};padding:8px 12px;text-align:left;font-weight:600;color:${t.tableHeaderText};`,
    'td': `border:1px solid ${t.tableBorder};padding:8px 12px;color:${t.text};`,
    'img': 'max-width:100%;height:auto;',
  };

  function processNode(el: Element) {
    el.removeAttribute('class');
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre') {
      el.setAttribute('style', `background:${t.preBg};color:${t.preText};padding:14px;border-radius:6px;overflow-x:auto;margin:10px 0;font-size:0.88em;line-height:1.5;border:1px solid ${t.preBorder};`);
      const codeChild = el.querySelector('code');
      if (codeChild) {
        codeChild.removeAttribute('class');
        codeChild.setAttribute('style', `background:transparent;padding:0;border-radius:0;color:inherit;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:inherit;`);
      }
      return;
    }

    if (tag === 'code') {
      el.setAttribute('style', `background:${t.codeBg};color:${t.codeText};padding:2px 6px;border-radius:4px;font-size:0.9em;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;`);
    } else if (styleMap[tag]) {
      el.setAttribute('style', styleMap[tag]!);
    }

    Array.from(el.children).forEach(processNode);
  }

  clone.removeAttribute('class');
  Array.from(clone.children).forEach(child => processNode(child as Element));

  return `<div style="background:${t.bg};color:${t.text};padding:20px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;max-width:800px;">${clone.innerHTML}</div>`;
}

export async function copyPlainText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

export async function copyAsHtml(sourceEl: HTMLElement, theme: 'light' | 'dark', sourceText: string): Promise<{ ok: boolean; method: 'html' | 'text' }> {
  const html = buildStyledHtml(sourceEl, theme);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([sourceText], { type: 'text/plain' }),
      }),
    ]);
    return { ok: true, method: 'html' };
  } catch {
    const ok = await copyPlainText(sourceText);
    return { ok, method: 'text' };
  }
}
