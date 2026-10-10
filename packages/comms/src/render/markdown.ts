/**
 * Markdown → platform dialect rendering.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Agents write GitHub-flavoured markdown (`**bold**`, `` `code` ``, `[x](url)`).
 * Every chat platform speaks a *different* formatting dialect, and none of them
 * is standard markdown:
 *
 *   telegram  an HTML subset  (<b> <i> <s> <u> <code> <pre> <a href>)
 *   slack     mrkdwn          (*bold* _italic_ ~strike~ `code` <url|label>)
 *   whatsapp  *bold* _italic_ ~strike~ ```mono```  (no links, no lists, no headings)
 *   discord   standard markdown (rendered natively — pass through untouched)
 *
 * Sending raw markdown to a platform that speaks another dialect prints the
 * markup literally — the "why does it show `**bold**`" bug. Sending raw text to
 * a platform *without* escaping also breaks: a message containing `<@everyone>`
 * or `&amp;` is a Slack/Telegram injection, not prose.
 *
 * ── Design ──────────────────────────────────────────────────────────────────
 *
 * One total function, `renderMarkdown(text, dialect)`, over a deliberately small
 * subset (bold / italic / strike / inline+block code / links / headings /
 * quotes / bullet+ordered lists). Anything outside the subset is passed through
 * *escaped*, never dropped — a platform that cannot express a construct still
 * shows its text. This mirrors the renderer's "degrade, never lose" rule
 * (gateway/render.ts).
 *
 * The dialect is a property of the **adapter** (the platform expert), not of the
 * payload, so two platforms cannot disagree about how one message looks.
 */

export type TextDialect = 'html' | 'mrkdwn' | 'whatsapp' | 'native';

/** Characters that must be escaped so user prose is not read as markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** mrkdwn shares HTML entities for `<`, `>`, `&` (Slack links/mentions are `<…>`). */
const escapeMrkdwn = escapeHtml;

function escapeFor(text: string, dialect: TextDialect): string {
  if (dialect === 'html' || dialect === 'mrkdwn') return escapeHtml(text);
  return text;
}

/**
 * One pass over emphasis markers. A single alternation means a span is matched
 * exactly once, so converting `**x**` → `*x*` (mrkdwn bold) can never be
 * re-read as markdown italic on a later pass — the classic double-conversion
 * bug that a two-pass bold-then-italic implementation always has.
 */
const INLINE_EMPHASIS =
  /(?<![\w*_])(\*\*|__)(?![\s*_])([^\n]+?)(?<![\s])\1(?![\w*_])|(?<![\w*_])(\*|_)(?![\s*_])([^\n]+?)(?<![\s])\3(?![\w*_])|(?<![\w~])~~(?![\s~])([^\n]+?)(?<![\s])~~(?![\w~])/g;

function renderInlineCode(code: string, dialect: TextDialect): string {
  switch (dialect) {
    case 'html':
      return `<code>${escapeHtml(code)}</code>`;
    default:
      return `\`${escapeFor(code, dialect)}\``;
  }
}

function renderCodeBlock(code: string, dialect: TextDialect): string {
  if (dialect === 'html') return `<pre>${escapeHtml(code)}</pre>`;
  return '```\n' + escapeFor(code, dialect) + '\n```';
}

function renderLink(label: string, url: string, dialect: TextDialect): string {
  switch (dialect) {
    case 'html':
      return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    case 'mrkdwn':
      return `<${url}|${escapeMrkdwn(label)}>`;
    case 'whatsapp':
      // WhatsApp has no inline link markup: show the label and the URL verbatim.
      return `${label} (${url})`;
    default:
      return `[${label}](${url})`;
  }
}

function emphasis(dialect: TextDialect, kind: 'bold' | 'italic' | 'strike', body: string): string {
  if (dialect === 'html') {
    return kind === 'bold' ? `<b>${body}</b>` : kind === 'italic' ? `<i>${body}</i>` : `<s>${body}</s>`;
  }
  if (dialect === 'mrkdwn') {
    return kind === 'bold' ? `*${body}*` : kind === 'italic' ? `_${body}_` : `~${body}~`;
  }
  // whatsapp
  return kind === 'bold' ? `*${body}*` : kind === 'italic' ? `_${body}_` : `~${body}~`;
}

/**
 * Inline pass: stash code/links (so emphasis regexes cannot see inside them),
 * escape the prose, convert emphasis in one pass, then restore the stashes.
 */
function renderInline(text: string, dialect: TextDialect): string {
  const stash: string[] = [];
  const keep = (rendered: string) => `\u0000${stash.push(rendered) - 1}\u0000`;

  let out = text.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(renderInlineCode(code, dialect)));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    keep(renderLink(label, url, dialect)),
  );
  out = escapeFor(out, dialect);
  out = out.replace(INLINE_EMPHASIS, (match, _bd, boldBody, _id, italicBody, strikeBody) => {
    if (boldBody !== undefined) return emphasis(dialect, 'bold', boldBody);
    if (italicBody !== undefined) return emphasis(dialect, 'italic', italicBody);
    if (strikeBody !== undefined) return emphasis(dialect, 'strike', strikeBody);
    return match;
  });
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)]);
}

const HEADING = /^#{1,6}\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)\.\s+(.*)$/;

function renderLine(line: string, dialect: TextDialect): string {
  const heading = line.match(HEADING);
  if (heading) {
    const body = renderInline(heading[1], dialect);
    return dialect === 'html' ? `<b>${body}</b>` : `*${body}*`;
  }
  const quote = line.match(QUOTE);
  if (quote) {
    // Telegram's HTML subset has no blockquote; a visual prefix degrades cleanly.
    const marker = dialect === 'html' ? '❯ ' : '> ';
    return marker + renderInline(quote[1], dialect);
  }
  const bullet = line.match(BULLET);
  if (bullet) return `${bullet[1]}• ${renderInline(bullet[2], dialect)}`;
  const ordered = line.match(ORDERED);
  if (ordered) return `${ordered[1]}${ordered[2]}. ${renderInline(ordered[3], dialect)}`;
  return renderInline(line, dialect);
}

/**
 * Convert markdown `text` into `dialect`. Total: every input yields output, and
 * `native` (Discord) is a verbatim pass-through because the platform already
 * renders standard markdown.
 */
export function renderMarkdown(text: string, dialect: TextDialect): string {
  if (!text || dialect === 'native') return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceBuf: string[] = [];

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceBuf = [];
      } else {
        inFence = false;
        out.push(renderCodeBlock(fenceBuf.join('\n'), dialect));
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    out.push(renderLine(line, dialect));
  }
  // An unterminated fence still renders its body rather than swallowing it.
  if (inFence) out.push(renderCodeBlock(fenceBuf.join('\n'), dialect));
  return out.join('\n');
}
