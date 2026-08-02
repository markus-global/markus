/**
 * Markdown href classification for chat + file/deliverable preview.
 *
 * Decision tree (Electron desktop + browser):
 * 1. #mention: / #entity: / scheme:id / bare entity id → in-app chips (handled by renderer)
 * 2. #fragment (TOC / same-doc heading) → scroll inside the markdown root
 * 3. local / relative file paths → RightPanel file preview (or reveal)
 * 4. http(s) / mailto → RightPanel embedded browser when hostAvailable, else system browser
 * 5. never use target=_blank for app-origin hashes (hijacks SPA hash router → Home)
 */

export type MarkdownLinkKind =
  | { kind: 'fragment'; id: string }
  | { kind: 'file'; path: string; fragment?: string }
  | { kind: 'external'; url: string }
  | { kind: 'passthrough' };

const ABS_FILE_RE = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/;
const REL_FILE_RE = /^\.{1,2}\//;
/** Paths that look like files (have an extension) rather than site routes. */
const FILE_EXT_RE = /\.[a-zA-Z0-9]{1,12}(?:$|[?#])/;
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const UNC_PATH_RE = /^\\\\[^\\]/;

/** True for Windows drive / UNC / file:// / POSIX abs / ~/ relative-home paths. */
export function isLocalFilesystemPath(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  if (/^file:/i.test(s)) return true;
  if (WIN_DRIVE_RE.test(s) || UNC_PATH_RE.test(s)) return true;
  if (s.startsWith('~/') || s.startsWith('/')) return true;
  if (REL_FILE_RE.test(s)) return true;
  return false;
}

/**
 * Normalize local filesystem URLs for `/api/files/image` and file preview.
 * - file:///C:/Users/... → C:/Users/...
 * - C:\\Users\\... or C:\Users\... → C:/Users/...
 */
export function normalizeLocalFilesystemPath(src: string): string {
  let p = src.trim();
  if (/^file:/i.test(p)) {
    try {
      p = decodeURIComponent(p.replace(/^file:\/\//i, ''));
    } catch {
      p = p.replace(/^file:\/\//i, '');
    }
    // file:///C:/Users → /C:/Users → C:/Users
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  }
  // Collapse markdown-escaped doubled backslashes, then prefer `/` for APIs.
  p = p.replace(/\\+/g, '/');
  return p;
}

/**
 * Rewrite Windows absolute paths inside markdown link/image destinations to use
 * forward slashes so CommonMark does not eat `\.markus` via backslash escapes.
 */
export function normalizeWindowsPathsInMarkdown(text: string): string {
  return text.replace(
    /(!?\[[^\]]*]\()((?:[A-Za-z]:|\\\\)[^)\n]*)(\))/g,
    (_m, open: string, path: string, close: string) =>
      `${open}${path.replace(/\\+/g, '/')}${close}`,
  );
}

/** GitHub-flavored-ish heading slug (unicode letters kept). */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s\-_]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function dirnamePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const i = normalized.lastIndexOf('/');
  return i >= 0 ? normalized.slice(0, i) : normalized;
}

/** Resolve ./ and ../ against an absolute base directory. */
export function resolvePathAgainstBase(path: string, basePath?: string): string {
  if (!path) return path;
  if (ABS_FILE_RE.test(path)) {
    if (path.startsWith('~/')) {
      // Leave tilde paths for the backend file API to expand.
      return path;
    }
    return path.replace(/\\/g, '/');
  }
  if (!basePath) return path;
  const base = basePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const joined = `${base}/${path.replace(/^\.\//, '')}`;
  const parts = joined.split('/');
  const resolved: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') resolved.pop();
    else resolved.push(p);
  }
  // Preserve leading slash for POSIX abs paths
  const out = resolved.join('/');
  return joined.startsWith('/') ? `/${out}`.replace(/^\/+/, '/') : out;
}

function splitFragment(href: string): { path: string; fragment?: string } {
  const hashIdx = href.indexOf('#');
  if (hashIdx < 0) return { path: href };
  return {
    path: href.slice(0, hashIdx),
    fragment: decodeURIComponent(href.slice(hashIdx + 1)),
  };
}

/**
 * Classify a markdown href after entity/mention/chip schemes have been ruled out.
 */
export function classifyMarkdownHref(href: string | undefined, basePath?: string): MarkdownLinkKind {
  if (!href) return { kind: 'passthrough' };
  const trimmed = href.trim();
  if (!trimmed || trimmed === '#') return { kind: 'passthrough' };

  // Same-document fragment: #heading (but not #mention: / #entity:)
  if (trimmed.startsWith('#') && !trimmed.startsWith('#mention:') && !trimmed.startsWith('#entity:')) {
    return { kind: 'fragment', id: decodeURIComponent(trimmed.slice(1)) };
  }

  // Windows drive / UNC before the generic scheme check — `C:` looks like a URI scheme.
  if (WIN_DRIVE_RE.test(trimmed) || UNC_PATH_RE.test(trimmed)) {
    const { path, fragment } = splitFragment(trimmed);
    return { kind: 'file', path: resolvePathAgainstBase(path, basePath), fragment };
  }

  // Protocol URLs
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
      return { kind: 'external', url: trimmed };
    }
    // file:// → local path
    if (/^file:\/\//i.test(trimmed)) {
      return { kind: 'file', path: normalizeLocalFilesystemPath(trimmed) };
    }
    return { kind: 'passthrough' };
  }

  const { path, fragment } = splitFragment(trimmed);

  // Absolute / home-relative / UNC paths
  if (ABS_FILE_RE.test(path)) {
    return { kind: 'file', path: resolvePathAgainstBase(path, basePath), fragment };
  }

  // Relative ./ ../
  if (REL_FILE_RE.test(path)) {
    return { kind: 'file', path: resolvePathAgainstBase(path, basePath), fragment };
  }

  // Bare filename with extension (common in agent TOC / sibling docs)
  if (path && FILE_EXT_RE.test(path) && !path.includes('://')) {
    return { kind: 'file', path: resolvePathAgainstBase(path, basePath), fragment };
  }

  return { kind: 'passthrough' };
}

export function scrollToMarkdownFragment(root: HTMLElement | null | undefined, id: string): boolean {
  if (!root || !id) return false;
  let el: Element | null = null;
  try {
    el = root.querySelector(`#${CSS.escape(id)}`);
  } catch {
    el = null;
  }
  if (!el) {
    // Fallback: match by id attribute manually (odd characters)
    el = root.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`);
  }
  if (!el) {
    // Last resort: match heading text slug
    const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (const h of headings) {
      if (slugifyHeading(h.textContent || '') === id || h.id === id) {
        el = h;
        break;
      }
    }
  }
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

type HastLike = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
};

function hastTextContent(node: HastLike): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastTextContent).join('');
}

/** rehype plugin: assign GitHub-like `id` on headings for in-doc fragment links. */
export function rehypeSlugifyHeadings() {
  return (tree: HastLike) => {
    const used = new Map<string, number>();
    const walk = (node: HastLike) => {
      if (node.type === 'element' && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const text = hastTextContent(node).trim();
        let id = slugifyHeading(text);
        if (id) {
          const n = used.get(id) ?? 0;
          used.set(id, n + 1);
          if (n > 0) id = `${id}-${n}`;
          node.properties = { ...(node.properties ?? {}), id };
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
