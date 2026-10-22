/**
 * 附件存储：把图片/文件的 base64 从数据库行里彻底赶出去。
 *
 * 现状（修复前）：一条带图的聊天消息，图片以 `data:image/png;base64,...` 的形式
 * 塞在 `metadata.images` 里。实测最大单行 2.39 MB，`chat_messages.metadata`
 * 97% 的字节都是 base64。更糟的是**同一张图还另有一份文件**落在
 * `~/.markus/chat-attachments/`（给 Agent 读的本地抓手）——一个事实两个写者。
 *
 * 修复后：
 *   字节   → `~/.markus/blobs/<sha>`（内容寻址，同图只存一份）
 *   索引   → `attachments(sha256, mime, bytes, name)`（一行几十字节）
 *   消息行 → `metadata.imageRefs = [{sha, mime, bytes}]`
 *   读取出 → `metadata.images = ['/api/attachments/<sha>']`（前端 `<img src>` 直接可用，
 *            所以**前端零改动**；老数据里的 data URL 也照样能用，双读过渡）
 */

import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { BlobStore } from './blob-store.js';

export interface AttachmentRef {
  sha: string;
  mime: string;
  bytes: number;
  name?: string;
}

/** 前端/HTTP 层的附件地址。相对路径，同源直接可用。 */
export function attachmentUrl(sha: string): string {
  return `/api/attachments/${sha}`;
}

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,(.*)$/s;

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:');
}

export function isAttachmentRef(value: unknown): value is AttachmentRef {
  return !!value
    && typeof value === 'object'
    && typeof (value as Record<string, unknown>)['sha'] === 'string'
    && typeof (value as Record<string, unknown>)['mime'] === 'string';
}

export class AttachmentStore {
  constructor(private db: DatabaseSync, private blobs: BlobStore = new BlobStore()) {}

  /** data URL → 落盘 + 建索引。解析失败返回 null（调用方决定怎么降级）。 */
  putDataUrl(dataUrl: string, name?: string): AttachmentRef | null {
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return null;
    const mime = m[1]!.trim().toLowerCase();
    const isBase64 = Boolean(m[2]);
    const buf = isBase64 ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
    if (buf.length === 0) return null;
    return this.putBuffer(buf, mime, name);
  }

  putBuffer(buf: Buffer, mime: string, name?: string): AttachmentRef {
    const sha = createHash('sha256').update(buf).digest('hex');
    this.blobs.put(buf);
    this.db
      .prepare('INSERT INTO attachments (sha256, mime, bytes, name) VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING')
      .run(sha, mime, buf.length, name ?? null);
    return { sha, mime, bytes: buf.length, ...(name ? { name } : {}) };
  }

  get(sha: string): { buf: Buffer; mime: string } | null {
    const row = this.db.prepare('SELECT mime FROM attachments WHERE sha256 = ?').get(sha) as { mime?: string } | undefined;
    const buf = this.blobs.get(sha);
    if (!buf) return null;
    return { buf, mime: row?.mime ?? 'application/octet-stream' };
  }

  /** 给模型用的 data URL（只在真正需要喂视觉模型时才重建，避免常驻内存）。 */
  dataUrlFor(sha: string): string | null {
    const got = this.get(sha);
    return got ? `data:${got.mime};base64,${got.buf.toString('base64')}` : null;
  }

  has(sha: string): boolean {
    return this.blobs.has(sha);
  }
}

/**
 * 读方向：`imageRefs` → `images`（URL）。
 *
 * 这是**唯一**的展开点。消息读路径只要都经过 `fromJson` 之后的这一层，
 * 前端就永远看到 `images: string[]`，不需要知道背后是 base64 还是文件。
 */
export function expandImageRefs(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!meta || typeof meta !== 'object') return (meta ?? {}) as Record<string, unknown>;
  const refs = (meta as Record<string, unknown>)['imageRefs'];
  if (!Array.isArray(refs) || refs.length === 0) return meta;
  const urls = refs.filter(isAttachmentRef).map(r => attachmentUrl(r.sha));
  if (urls.length === 0) return meta;
  return { ...meta, images: urls };
}
