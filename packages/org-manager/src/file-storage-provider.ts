import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { generateId, type FileStorageProvider, type FileStorageUploadResult } from '@markus/shared';

/**
 * Local filesystem implementation of FileStorageProvider.
 *
 * Files are stored under `baseDir` (default ~/.markus/uploads/) and served
 * via the API server at `/api/uploads/<key>`.
 *
 * To swap to cloud storage (S3, GCS, R2, etc.), implement the same
 * FileStorageProvider interface and return full URLs instead of relative paths.
 */
export class LocalFileStorageProvider implements FileStorageProvider {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.markus', 'uploads');
    mkdirSync(this.baseDir, { recursive: true });
  }

  async upload(data: Buffer, opts: { name: string; contentType: string; prefix?: string }): Promise<FileStorageUploadResult> {
    const ext = extname(opts.name) || mimeToExt(opts.contentType);
    const key = `${generateId('upl')}${ext}`;
    const subDir = opts.prefix ? join(this.baseDir, opts.prefix) : this.baseDir;
    mkdirSync(subDir, { recursive: true });

    writeFileSync(join(subDir, key), data);

    const urlPath = opts.prefix ? `/api/uploads/${opts.prefix}/${key}` : `/api/uploads/${key}`;
    return { url: urlPath, key: opts.prefix ? `${opts.prefix}/${key}` : key };
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.baseDir, key);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  /** Resolve a storage key to an absolute filesystem path (for serving). */
  resolve(key: string): string {
    return join(this.baseDir, key);
  }
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
  };
  return map[mime] ?? '';
}
