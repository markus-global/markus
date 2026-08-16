/**
 * Deliverable 媒体引用解析与路径替换 —— web-ui 端轻量拷贝。
 *
 * 与 @markus/core `media-refs.ts` 保持同一契约（web-ui 为自包含 SPA，不依赖 core 包，
 * 沿用镜像共享契约的既有做法）。纯逻辑无副作用，便于单测。
 */

export interface LocalMediaRef {
  raw: string;
  localPath: string;
  kind: 'image' | 'media' | 'other';
}

export interface MediaRefParseResult {
  refs: LocalMediaRef[];
  baseDir: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const MEDIA_EXT = /\.(mp4|webm|mp3|wav|ogg|m4a|mov|avi|mkv|flac)$/i;

export function kindForFilename(filename: string): LocalMediaRef['kind'] {
  if (IMAGE_EXT.test(filename)) return 'image';
  if (MEDIA_EXT.test(filename)) return 'media';
  return 'other';
}

export function stripFileProtocol(p: string): string {
  return p.replace(/^file:\/\//i, '').replace(/^file:/i, '');
}

export function extractBarePath(raw: string): string | null {
  const md = raw.match(/!?\[[^\]]*\]\(([^)]+)\)/);
  if (md) {
    const path = md[1]!.trim().split(/\s+(?="|')/)[0]!.trim();
    return path || null;
  }
  const attr = raw.match(/(?:src|href|poster)\s*=\s*["']([^"']+)["']/i);
  if (attr) return attr[1]!;
  return null;
}

export function isLocalReference(path: string): boolean {
  if (!path) return false;
  if (/^(https?:|data:|mailto:|tel:|#)/i.test(path)) return false;
  if (path.startsWith('//')) return false;
  if (path.startsWith('/api/files/')) return true;
  return true;
}

export function normalizeReferencePath(path: string, baseDir?: string): string | null {
  if (!path) return null;
  const trimmed = path.trim();

  const apiMatch = trimmed.match(/^\/api\/files\/(?:image|stream|preview)\?path=([^&]+)/i);
  if (apiMatch) {
    try {
      const decoded = decodeURIComponent(apiMatch[1]!);
      return decoded || null;
    } catch {
      return apiMatch[1] || null;
    }
  }

  if (/^file:\/\//i.test(trimmed)) {
    return stripFileProtocol(trimmed).replace(/\\/g, '/');
  }

  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/\\/g, '/');
  }

  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  if (baseDir) {
    if (trimmed.startsWith('./') || trimmed.startsWith('../') || !trimmed.includes('://')) {
      const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
      return `${base}/${trimmed.replace(/^\.\//, '').replace(/\\/g, '/')}`;
    }
  }

  return null;
}

export function parseLocalMediaRefs(content: string, baseDir?: string): MediaRefParseResult {
  const refs: LocalMediaRef[] = [];
  const seen = new Set<string>();

  const mdRe = /!?\[[^\]]*\]\(([^)\s]+(?:\s+["'][^"']*["'])?)\)/g;
  for (const m of content.matchAll(mdRe)) {
    const raw = m[0]!;
    const bare = extractBarePath(raw);
    if (!bare || !isLocalReference(bare)) continue;
    const local = normalizeReferencePath(bare, baseDir);
    if (!local || seen.has(raw)) continue;
    seen.add(raw);
    refs.push({ raw, localPath: local, kind: kindForFilename(local.split('?')[0]!) });
  }

  const htmlRe = /<[a-zA-Z][^>]*(?:src|href|poster)\s*=\s*["'][^"']+["'][^>]*>/gi;
  for (const m of content.matchAll(htmlRe)) {
    const raw = m[0]!;
    const bare = extractBarePath(raw);
    if (!bare || !isLocalReference(bare)) continue;
    const local = normalizeReferencePath(bare, baseDir);
    if (!local || seen.has(raw)) continue;
    seen.add(raw);
    refs.push({ raw, localPath: local, kind: kindForFilename(local.split('?')[0]!) });
  }

  return { refs, baseDir: baseDir ?? '' };
}

export function replaceMediaRefs(content: string, replacements: ReadonlyMap<string, string>): string {
  let out = content;
  for (const [raw, url] of replacements) {
    // 重建完整片段（保留 markdown `![alt](...)` / HTML `src="..."` 结构），只替换其中的路径
    const rewritten = rewriteFragment(raw, url);
    out = out.split(raw).join(rewritten);
  }
  return out;
}

export function rewriteFragment(raw: string, newUrl: string): string {
  const md = raw.match(/^(!?\[[^\]]*\])\([^)]*\)$/);
  if (md) return `${md[1]}(${newUrl})`;
  const attr = raw.match(/(src|href|poster)(\s*=\s*)(["'])[^"']*\3/i);
  if (attr) {
    return raw.replace(/(src|href|poster)(\s*=\s*)(["'])[^"']*\3/i, `${attr[1]}${attr[2]}${attr[3]}${newUrl}${attr[3]}`);
  }
  return newUrl;
}

/**
 * 把 Hub 上传返回的相对 URL 补成绝对 URL（Hub 站点来源拼接）。
 * 若已是绝对 URL（http/https）则原样返回。
 */
export function toAbsoluteHubUrl(url: string, hubUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const origin = hubUrl.replace(/\/+$/, '');
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * 建立「raw 片段 → 绝对 URL」的替换映射。
 * 纯逻辑：给定解析出的引用列表与 Hub 批量上传返回结果（含 key=localPath），
 * 按 key 匹配生成替换表。失败/缺失项自动跳过。
 */
export function buildReplacementsFromUploads(
  refs: LocalMediaRef[],
  uploaded: Array<{ key?: string; url: string }>,
  hubUrl: string,
): Map<string, string> {
  const replacements = new Map<string, string>();
  const refByKey = new Map<string, LocalMediaRef>(refs.map(r => [r.localPath, r]));
  for (const item of uploaded) {
    if (!item.key) continue;
    const ref = refByKey.get(item.key);
    if (!ref || !item.url) continue;
    replacements.set(ref.raw, toAbsoluteHubUrl(item.url, hubUrl));
  }
  return replacements;
}