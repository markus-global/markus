import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalFileStorageProvider } from '../src/file-storage-provider.js';

describe('LocalFileStorageProvider', () => {
  let baseDir: string;
  let provider: LocalFileStorageProvider;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'uploads-'));
    provider = new LocalFileStorageProvider(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('uploads, resolves, and deletes files', async () => {
    const result = await provider.upload(Buffer.from('hello'), {
      name: 'photo.png',
      contentType: 'image/png',
      prefix: 'avatars',
    });
    expect(result.url).toContain('/api/uploads/avatars/');
    expect(result.key).toContain('avatars/');
    expect(provider.resolve(result.key)).toContain(baseDir);

    await provider.delete(result.key);
  });

  it('uploads without prefix and unknown mime', async () => {
    const result = await provider.upload(Buffer.from('data'), {
      name: 'file',
      contentType: 'application/octet-stream',
    });
    expect(result.url).toMatch(/^\/api\/uploads\//);
    await provider.delete('missing-key');
  });
});
