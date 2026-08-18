/**
 * Chat attachment persistence for images sent by humans in Team Chat.
 *
 * Goal: give the AGENT a stable LOCAL file path ("抓手") for each image the
 * user sends, so it knows which image to process and can use file tools
 * (file_read / OCR / etc.) on it. Getting an external PUBLIC url is NOT this
 * module's job — the agent does that itself via the `upload_reference` tool
 * (passing the local path), which returns a temporary public URL.
 *
 * Images are stored under ~/.markus/chat-attachments/<channel>/ so the agent
 * (running on the same host) can read them by absolute path.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@markus/shared';

const log = createLogger('chat-attachments');

export interface PersistedChatImage {
  /** Absolute local path the agent can read/process. */
  path: string;
  /** Original file name (fallback img_<n>.<ext>). */
  name: string;
  mimeType: string;
  /** True for image/* mime types (rendered as markdown image). */
  isImage: boolean;
  /** Original base64 data URL (kept for vision injection where supported). */
  dataUrl: string;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls',
  'application/msword': '.doc',
  'text/html': '.html',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/epub+zip': '.epub',
};

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

function fallbackExt(mime: string): string {
  return MIME_EXT[mime] ?? (isImageMime(mime) ? '.png' : '.bin');
}

/**
 * Persist base64 data-URL images to a per-channel temp dir under ~/.markus.
 * Returns one entry per image, or [] if none / none parseable.
 */
export function persistChatImages(
  images: string[] | undefined,
  fileNames: string[] | undefined,
  channel: string,
): PersistedChatImage[] {
  if (!images?.length) return [];

  const baseDir = join(homedir(), '.markus', 'chat-attachments');
  // Sanitize channel to a safe path segment.
  const safeChannel = channel.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
  const runDir = join(baseDir, safeChannel, String(Date.now()));
  mkdirSync(runDir, { recursive: true });

  const out: PersistedChatImage[] = [];
  for (let i = 0; i < images.length; i++) {
    const dataUrl = images[i]!;
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) continue;
    const mimeType = m[1]!;
    const buf = Buffer.from(m[2]!, 'base64');
    const name = fileNames?.[i] && fileNames[i]!.trim()
      ? fileNames[i]!.trim()
      : `image_${i}${fallbackExt(mimeType)}`;
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') || `image_${i}.png`;
    const filePath = join(runDir, `${i}_${safeName}`);
    try {
      writeFileSync(filePath, buf);
      out.push({ path: filePath, name: safeName, mimeType, isImage: isImageMime(mimeType), dataUrl });
    } catch (err) {
      log.warn('Failed to persist chat image', { error: String(err) });
    }
  }

  if (!out.length) {
    try { /* best-effort cleanup */ } catch { /* ignore */ }
  }
  return out;
}

/** Exists guard helper (kept minimal; not exported API surface). */
export function attachmentExists(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}
