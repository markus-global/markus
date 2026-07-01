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
const ENTITY_ID_RE = /(?<!\[)(?<!#entity:)\b(tsk|req|proj|dlv|agt)_[a-f0-9]{6,}\b(?!\]\(#entity:)/gi;
const ENTITY_LINK_IN_CODE_RE = /`\[([^\]]+)\]\(#entity:((?:tsk|req|proj|dlv|agt)_[a-f0-9]{6,})\)`/gi;

/** Unwrap entity links wrapped in backticks: `[id](#entity:id)` → [id](#entity:id) */
export function preprocessEntityLinksInCode(text: string): string {
  return text.replace(ENTITY_LINK_IN_CODE_RE, (_m, label, id) => `[${label}](${ENTITY_PREFIX}${id})`);
}

/** Convert bare entity IDs (tsk_xxx, dlv_xxx, etc.) to markdown links with #entity: href. */
export function preprocessEntityIds(text: string): string {
  return text.replace(ENTITY_ID_RE, (id) => `[${id}](${ENTITY_PREFIX}${id})`);
}

/** Detect PlantUML content by @startuml/@enduml markers */
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
