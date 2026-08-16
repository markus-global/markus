/**
 * Deliverable 媒体引用解析与路径替换 —— 通用模块（Node & 浏览器通用）。
 *
 * 场景：交付物（markdown / html）内容中引用了本地文件系统任意位置的图片/音视频。
 * 本地查看时可正常渲染，但分享到 Hub 后这些绝对路径/本地 API 路径在远端不可达，
 * 导致网站破图。本模块负责在分享前：
 *   1. 解析（parse）—— 找出内容中所有本地媒体引用并归一化为绝对路径
 *   2. 生成可替换的纯文本（replace）—— 调用方拿到每个引用的原始片段 + 新 URL 后回填
 *
 * 支持语法：
 *   - Markdown 图片  `![alt](path)` / 链接 `[text](path)`
 *   - HTML `<img src="...">` / `<video src="...">` / `<audio src="...">` / `<source src="...">`
 *   - 任意 URL 形式（引号包裹或括号包裹均可）：绝对路径、file://、相对路径、
 *     本地 API 形式（/api/files/image?path=...、/api/files/stream?path=...）
 *
 * 纯逻辑无副作用：不读取文件、不发起网络请求，便于单测。
 */

/** 本地媒体引用的原始片段（在交付物文本中出现的形式）。 */
export interface LocalMediaRef {
  /** 原始片段，例如 `![alt](/Users/a/img.png)` 或 `src="/Users/a/img.png"`。 */
  raw: string;
  /** 归一化后的本地绝对路径（file:// 与相对路径均已解析）。 */
  localPath: string;
  /** 引用用途：图片 / 音视频 / 其他。 */
  kind: 'image' | 'media' | 'other';
}

/** 解析结果：原始片段 → 归一化路径。 */
export interface MediaRefParseResult {
  refs: LocalMediaRef[];
  /** 交付物所在目录（用于相对路径解析；可能为空）。 */
  baseDir: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const MEDIA_EXT = /\.(mp4|webm|mp3|wav|ogg|m4a|mov|avi|mkv|flac)$/i;

/** 按文件扩展名推断引用类型。 */
export function kindForFilename(filename: string): LocalMediaRef['kind'] {
  if (IMAGE_EXT.test(filename)) return 'image';
  if (MEDIA_EXT.test(filename)) return 'media';
  return 'other';
}

/** 去掉 file:// 前缀，返回本地路径。 */
export function stripFileProtocol(p: string): string {
  return p.replace(/^file:\/\//i, '').replace(/^file:/i, '');
}

/**
 * 从原始引用中提取「裸路径」（去掉 Markdown 括号 / HTML 引号）。
 * 例如：
 *   `![alt](/a/b.png "title")`      -> `/a/b.png`
 *   `src="/api/files/image?path=%2Fa%2Fb.png"` -> `/api/files/image?path=...`
 *   `target="_blank"`（无路径）       -> null
 */
export function extractBarePath(raw: string): string | null {
  // Markdown：![alt](path) 或 [text](path)
  const md = raw.match(/!?\[[^\]]*\]\(([^)]+)\)/);
  if (md) {
    // 去掉可选的 title（`path "title"`）
    const path = md[1]!.trim().split(/\s+(?="|')/)[0]!.trim();
    return path || null;
  }
  // HTML：attr="path" 或 attr='path'（src / href / xlink:href / poster）
  const attr = raw.match(/(?:src|href|poster)\s*=\s*["']([^"']+)["']/i);
  if (attr) return attr[1]!;
  return null;
}

/** 是否是本地文件引用（排除 http(s) / data: / 纯锚点 / 纯查询）。 */
export function isLocalReference(path: string): boolean {
  if (!path) return false;
  if (/^(https?:|data:|mailto:|tel:|#)/i.test(path)) return false;
  if (path.startsWith('//')) return false; // 协议相对 URL
  if (path.startsWith('/api/files/')) return true; // 本地 API 形式（Org Manager 文件端点）
  return true;
}

/**
 * 把引用路径归一化为潜在本地绝对路径。
 * 支持：
 *   - 绝对路径  `/Users/...`、`C:\...`、`C:/...`
 *   - file:// 协议
 *   - 本地 API 形式 `/api/files/image?path=<urlencoded-abs>`、`/api/files/stream?path=...`
 *   - 相对路径（相对 baseDir）
 * @returns 返回归一化路径；无法解析时返回 null。
 */
export function normalizeReferencePath(path: string, baseDir?: string): string | null {
  if (!path) return null;
  const trimmed = path.trim();

  // 本地 API 形式：从 query 提取真实文件路径
  const apiMatch = trimmed.match(/^\/api\/files\/(?:image|stream|preview)\?path=([^&]+)/i);
  if (apiMatch) {
    try {
      const decoded = decodeURIComponent(apiMatch[1]!);
      return decoded || null;
    } catch {
      return apiMatch[1] || null;
    }
  }

  // file:// 协议
  if (/^file:\/\//i.test(trimmed)) {
    return stripFileProtocol(trimmed).replace(/\\/g, '/');
  }

  // Windows 驱动器路径 C:\... 或 C:/...
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/\\/g, '/');
  }

  // 绝对 POSIX 路径
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  // 相对路径（需要 baseDir 才能解析）；如 ./, ../, 或纯文件名
  if (baseDir) {
    if (trimmed.startsWith('./') || trimmed.startsWith('../') || !trimmed.includes('://')) {
      const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
      return `${base}/${trimmed.replace(/^\.\//, '').replace(/\\/g, '/')}`;
    }
  }

  return null;
}

/**
 * 解析交付物文本中的全部本地媒体引用。
 * @param content 交付物文本（markdown 或 html）。
 * @param baseDir 交付物所在目录（用于相对路径解析；可选）。
 */
export function parseLocalMediaRefs(content: string, baseDir?: string): MediaRefParseResult {
  const refs: LocalMediaRef[] = [];
  const seen = new Set<string>();

  // 1) Markdown 图片/链接：![alt](path) / [text](path)
  const mdRe = /!?\[[^\]]*\]\(([^)\s]+(?:\s+["'][^"']*["'])?)\)/g;
  for (const m of content.matchAll(mdRe)) {
    const raw = m[0]!;
    const bare = extractBarePath(raw);
    if (!bare || !isLocalReference(bare)) continue;
    const local = normalizeReferencePath(bare, baseDir);
    if (!local || seen.has(raw)) continue;
    seen.add(raw);
    refs.push({
      raw,
      localPath: local,
      kind: kindForFilename(local.split('?')[0]!),
    });
  }

  // 2) HTML 标签：<img src> <video src> <audio src> <source src> <a href> 等
  const htmlRe = /<[a-zA-Z][^>]*(?:src|href|poster)\s*=\s*["'][^"']+["'][^>]*>/gi;
  for (const m of content.matchAll(htmlRe)) {
    const raw = m[0]!;
    const bare = extractBarePath(raw);
    if (!bare || !isLocalReference(bare)) continue;
    const local = normalizeReferencePath(bare, baseDir);
    if (!local || seen.has(raw)) continue;
    seen.add(raw);
    refs.push({
      raw,
      localPath: local,
      kind: kindForFilename(local.split('?')[0]!),
    });
  }

  return { refs, baseDir: baseDir ?? '' };
}

/**
 * 执行替换：把解析到的引用替换为新 URL。
 * 注意：只替换「完整片段」匹配，且每次替换前重新定位，避免
 * 同一片段被多次匹配时出现前半截残留。
 * @param content 原始交付物文本。
 * @param replacements 原始片段 → 新 URL。
 * @returns 替换后的文本。
 */
export function replaceMediaRefs(content: string, replacements: ReadonlyMap<string, string>): string {
  let out = content;
  for (const [raw, url] of replacements) {
    // 重建完整片段（保留 markdown `![alt](...)` / HTML `src="..."` 结构），只替换其中的路径
    const rewritten = rewriteFragment(raw, url);
    // 全文替换该片段的所有出现（同一图片可能被多处引用）
    out = out.split(raw).join(rewritten);
  }
  return out;
}

/**
 * 从替换后的文本构造 Markdown/HTML 的最终路径。
 * 这是个便捷函数：给定原始片段与新 URL，返回可直接写入文档的片段。
 * @param raw 原始片段，如 `![alt](/a/b.png)` 或 `src="/a/b.png"`。
 * @param newUrl 新的公网 URL。
 */
export function rewriteFragment(raw: string, newUrl: string): string {
  const md = raw.match(/^(!?\[[^\]]*\])\([^)]*\)$/);
  if (md) {
    const titleMatch = raw.match(/\)\s*$/);
    return `${md[1]}(${newUrl})`;
  }
  const attr = raw.match(/(src|href|poster)(\s*=\s*)(["'])[^"']*\3/i);
  if (attr) {
    return raw.replace(/(src|href|poster)(\s*=\s*)(["'])[^"']*\3/i, `${attr[1]}${attr[2]}${attr[3]}${newUrl}${attr[3]}`);
  }
  return newUrl;
}