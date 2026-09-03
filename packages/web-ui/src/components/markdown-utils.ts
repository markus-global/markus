/** Apply a transform only to text outside fenced code blocks and inline code.
 *  Splits on ``` fences and backtick spans, passes only prose segments through `fn`. */
export function transformOutsideCode(text: string, fn: (segment: string) => string): string {
  const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/g;
  let last = 0;
  let out = '';
  for (const m of text.matchAll(CODE_RE)) {
    out += fn(text.slice(last, m.index));
    out += m[0];
    last = m.index! + m[0].length;
  }
  out += fn(text.slice(last));
  return out;
}

/** Normalise LaTeX delimiters from LLM output to remark-math's expected syntax.
 *  \(...\) → $...$  and  \[...\] → $$...$$ */
export function normalizeMathDelimiters(text: string): string {
  let out = text.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `$$${inner}$$`);
  out = out.replace(/\\\((.+?)\\\)/g, (_m, inner: string) => `$${inner}$`);
  return out;
}

/** Escape currency/price dollar signs ($90, $4,307.7, $5M…) into a literal
 *  dollar so remark-math does not misparse them as inline-math delimiters.
 *
 *  Without this, a price pair like "$90系统性阈值（$90.50）" gets the text
 *  between the two dollar signs swallowed into a KaTeX formula (math font +
 *  nowrap → broken line wrapping / overflow on narrow screens).
 *
 *  IMPORTANT: must run BEFORE normalizeMathDelimiters — the dollar signs that
 *  step generates from LaTeX parenthesised delimiters are genuine math and
 *  must NOT be re-escaped here. An already-escaped dollar (backslash-dollar)
 *  is left untouched. */
export function protectCurrencyDollarSigns(text: string): string {
  const BS = String.fromCharCode(92); // backslash
  return text.replace(/[$](?=[0-9])/g, (m: string, offset: number, s: string) =>
    offset > 0 && s.charCodeAt(offset - 1) === 92 ? m : BS + m,
  );
}

const MENTION_PREFIX = '#mention:';

/** Convert @mentions to markdown links. Supports bracketed (@[Name]) and word-boundary (@Name) forms. */
export function preprocessMentions(text: string, knownNames?: string[]): string {
  if (!knownNames || knownNames.length === 0) {
    return text.replace(/@\[([^\]]+)\]|@([\w\p{L}\p{N}]+)/gu, (_full, bracketName: string | undefined, wordName: string | undefined) => {
      const name = bracketName ?? wordName!;
      return `[@${name}](${MENTION_PREFIX}${encodeURIComponent(name)})`;
    });
  }

  const sorted = [...knownNames].sort((a, b) => b.length - a.length);
  let result = '';
  let idx = 0;
  while (idx < text.length) {
    const atPos = text.indexOf('@', idx);
    if (atPos < 0) {
      result += text.slice(idx);
      break;
    }
    result += text.slice(idx, atPos);

    if (text[atPos + 1] === '[') {
      const close = text.indexOf(']', atPos + 2);
      if (close > atPos + 2) {
        const name = text.slice(atPos + 2, close);
        result += `[@${name}](${MENTION_PREFIX}${encodeURIComponent(name)})`;
        idx = close + 1;
        continue;
      }
    }

    const after = text.slice(atPos + 1);
    const afterLower = after.toLowerCase();
    const fullMatch = sorted.find(n => afterLower.startsWith(n.toLowerCase()));
    if (fullMatch) {
      const actual = after.slice(0, fullMatch.length);
      result += `[@${actual}](${MENTION_PREFIX}${encodeURIComponent(actual)})`;
      idx = atPos + 1 + fullMatch.length;
      continue;
    }

    const tokenMatch = after.match(/^([\w\p{L}\p{N}]+)/u);
    if (tokenMatch) {
      const name = tokenMatch[1]!;
      result += `[@${name}](${MENTION_PREFIX}${encodeURIComponent(name)})`;
      idx = atPos + 1 + name.length;
      continue;
    }

    result += '@';
    idx = atPos + 1;
  }
  return result;
}

const ENTITY_PREFIX = '#entity:';
// Match bare entity IDs in prose, but NOT ones already inside a link / path:
//   - `[id](...)`            → preceded by `[`
//   - `](dlv_…)`             → preceded by `(`  (link destination)
//   - `deliverable:dlv_…`    → preceded by `:`  (custom scheme href)
//   - `/agents/agt_…/…`      → preceded by `/` or `\` (filesystem / URL path)
// Rewriting IDs inside a destination or path corrupts the URL into nested markdown
// (e.g. image `![x](/…/agents/agt_…/file.png)` became
// `![x](/…/agents/[agt_…](#entity:agt_…)/file.png)` → 404).
const ENTITY_ID_RE = /(?<!\[)(?<!\()(?<!:)(?<!\/)(?<!\\)\b(tsk|req|proj|dlv|agt|team)_[a-f0-9]{6,}\b(?!\]\(#entity:)/gi;
const ENTITY_LINK_IN_CODE_RE = /`\[([^\]]+)\]\(#entity:((?:tsk|req|proj|dlv|agt|team)_[a-f0-9]{6,})\)`/gi;

/** True when `index` sits inside a markdown link/image destination: `](…here…)`. */
function isInsideMarkdownDestination(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const open = before.lastIndexOf('](');
  if (open === -1) return false;
  const close = before.indexOf(')', open + 2);
  return close === -1;
}

/** Unwrap entity links wrapped in backticks: `[id](#entity:id)` → [id](#entity:id) */
export function preprocessEntityLinksInCode(text: string): string {
  return text.replace(ENTITY_LINK_IN_CODE_RE, (_m, label, id) => `[${label}](${ENTITY_PREFIX}${id})`);
}

/** Convert bare entity IDs (tsk_xxx, dlv_xxx, etc.) to markdown links with #entity: href. */
export function preprocessEntityIds(text: string): string {
  return text.replace(ENTITY_ID_RE, (id: string, _prefix: string, offset: number) => {
    // Defense in depth: even if lookbehinds miss a case, never rewrite inside ](...).
    if (isInsideMarkdownDestination(text, offset)) return id;
    return `[${id}](${ENTITY_PREFIX}${id})`;
  });
}

// ─── Bare-URL autolink normalization ─────────────────────────────────────────
//
// remark-gfm autolinks bare URLs in prose, but its boundary regex stops only at
// ASCII whitespace / punctuation — it does NOT stop at CJK ideographs or
// full-width punctuation. So `https://x.com/去接` renders the trailing Chinese
// (and any later CJK up to the next ASCII space) as part of the clickable link.
//
// Fix: pre-rewrite bare http(s) URLs into explicit `[url](url)` markdown links.
// Once explicit, remark-gfm no longer runs its own autolink on them, so the link
// boundary is under our control (we stop at the first CJK / full-width char).

// URL terminal chars: exclude CJK ideographs, CJK punctuation, full-width
// forms, whitespace and a few ASCII delimiters that announce a boundary.
const URL_END_BOUNDARY = [
  '\\s',
  '<', '>',
  '`',
  '\\u4e00-\\u9fff',      // CJK ideographs
  '\\u3000-\\u303f',      // CJK punctuation (。，「」、etc.)
  '\\uff00-\\uffef',      // fullwidth forms (），。；：！？etc.)
].join('');
const BARE_URL_RE = new RegExp(`https?://[^${URL_END_BOUNDARY}]+`, 'gi');

/** Wrap bare http(s) URLs in prose as explicit `[url](url)` links so GFM
 *  autolink does not swallow trailing CJK / full-width characters. */
export function autolinkBareUrls(text: string): string {
  return text.replace(BARE_URL_RE, (url: string, offset: number) => {
    // Defense in depth: never touch a URL inside a markdown destination `](...)`.
    if (isInsideMarkdownDestination(text, offset)) return url;
    const trimmed = url.replace(/[.,;:!?\]\)"']+$/, '');
    if (!trimmed) return url;
    const trail = url.slice(trimmed.length);
    // If the URL still carries problematic parens we'd have to escape in a
    // destination, leave it as-is rather than risk corrupting the source.
    if (/[()[\]]/.test(trimmed)) return url;
    return `[${trimmed}](${trimmed})${trail}`;
  });
}

/** Detect bare PlantUML content by @startuml/@enduml markers */
export function looksLikePlantUML(text: string): boolean {
  const t = text.trim();
  return t.startsWith('@startuml') && t.endsWith('@enduml');
}

const MERMAID_START_RE = /^(graph\s|flowchart\s|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline|journey)/m;

/** Detect Mermaid content by common diagram type keywords */
export function looksLikeMermaid(text: string): boolean {
  return MERMAID_START_RE.test(text.trim());
}

const LANG_DISPLAY: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript',
  ts: 'TypeScript', typescript: 'TypeScript',
  tsx: 'TSX', jsx: 'JSX',
  py: 'Python', python: 'Python',
  rb: 'Ruby', ruby: 'Ruby',
  rs: 'Rust', rust: 'Rust',
  go: 'Go', java: 'Java', kotlin: 'Kotlin',
  swift: 'Swift', cpp: 'C++', c: 'C',
  cs: 'C#', csharp: 'C#',
  php: 'PHP', sql: 'SQL',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', shell: 'Shell',
  html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
  json: 'JSON', yaml: 'YAML', yml: 'YAML',
  xml: 'XML', toml: 'TOML', ini: 'INI',
  md: 'Markdown', markdown: 'Markdown',
  dockerfile: 'Dockerfile', docker: 'Dockerfile',
  graphql: 'GraphQL', gql: 'GraphQL',
  lua: 'Lua', perl: 'Perl', r: 'R',
  scala: 'Scala', elixir: 'Elixir', erlang: 'Erlang',
  haskell: 'Haskell', clojure: 'Clojure',
  dart: 'Dart', zig: 'Zig', nim: 'Nim',
  powershell: 'PowerShell', ps1: 'PowerShell',
  vue: 'Vue', svelte: 'Svelte',
  plaintext: 'Text', text: 'Text', txt: 'Text',
};

/** Map a language identifier to a human-readable display name */
export function languageDisplayName(lang: string): string {
  return LANG_DISPLAY[lang.toLowerCase()] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
}

/** Extract language identifier from a className like "language-typescript" or "hljs language-typescript" */
export function extractLanguageFromClass(cls: string): string | null {
  const match = cls.match(/language-(\S+)/);
  return match ? match[1]! : null;
}
