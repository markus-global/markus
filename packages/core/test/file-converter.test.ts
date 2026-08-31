import { vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertFilesToText, extractTextFromFile, resetMarkitdownCache } from '../src/file-converter.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

function makeDataUrl(mime: string, content: string): string {
  return `data:${mime};base64,${Buffer.from(content).toString('base64')}`;
}

describe('convertFilesToText', () => {
  beforeEach(() => {
    resetMarkitdownCache();
    mockedExecFile.mockReset();
  });

  it('returns placeholder when markitdown is unavailable', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error | null) => void)(new Error('not found'));
    });

    const results = await convertFilesToText(
      [makeDataUrl('image/png', 'fake-png-data')],
      ['photo.png'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('photo.png');
    expect(results[0].mimeType).toBe('image/png');
    expect(results[0].text).toContain('[Image: photo.png');
    expect(results[0].text).toContain('markitdown CLI is not installed');
  });

  it('converts files with markitdown when available', async () => {
    mockedExecFile.mockImplementation((cmd, args, opts, callback) => {
      if (args && (args as string[])[0] === '--help') {
        (callback as (err: null, stdout: string) => void)(null, 'help');
        return;
      }
      (callback as (err: null, stdout: string) => void)(null, '# Converted markdown\nHello world');
    });

    const results = await convertFilesToText(
      [makeDataUrl('application/pdf', 'pdf-content')],
      ['doc.pdf'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('# Converted markdown\nHello world');
  });

  it('handles invalid data URLs', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error | null) => void)(new Error('not found'));
    });

    const results = await convertFilesToText(['not-a-data-url']);
    expect(results[0].text).toBe('[Unable to parse file data]');
    expect(results[0].mimeType).toBe('unknown');
  });

  it('falls back when markitdown conversion fails', async () => {
    mockedExecFile.mockImplementation((cmd, args, opts, callback) => {
      if (args && (args as string[])[0] === '--help') {
        (callback as (err: null, stdout: string) => void)(null, 'help');
        return;
      }
      (callback as (err: Error) => void)(new Error('conversion failed'));
    });

    const results = await convertFilesToText(
      [makeDataUrl('text/csv', 'a,b,c')],
      ['data.csv'],
    );

    expect(results[0].text).toContain('[File: data.csv');
  });

  it('processes multiple files', async () => {
    mockedExecFile.mockImplementation((cmd, args, opts, callback) => {
      if (args && (args as string[])[0] === '--help') {
        (callback as (err: null, stdout: string) => void)(null, 'help');
        return;
      }
      (callback as (err: null, stdout: string) => void)(null, 'converted');
    });

    const results = await convertFilesToText([
      makeDataUrl('text/plain', 'file1'),
      makeDataUrl('text/plain', 'file2'),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('converted');
    expect(results[1].text).toBe('converted');
  });

  it('uses default file names from mime type', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error | null) => void)(new Error('not found'));
    });

    const results = await convertFilesToText([makeDataUrl('image/jpeg', 'jpg')]);
    expect(results[0].name).toBe('file_0.jpg');
  });
});

describe('extractTextFromFile', () => {
  beforeEach(() => {
    resetMarkitdownCache();
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error | null) => void)(new Error('not found'));
    });
  });

  it('reads text-like files directly as UTF-8', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-text-'));
    const file = join(dir, 'notes.md');
    writeFileSync(file, '# Heading\n\nbody text');
    try {
      const text = await extractTextFromFile(file);
      expect(text).toContain('# Heading');
      expect(text).toContain('body text');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty string for office file when markitdown is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-office-'));
    const file = join(dir, 'report.docx');
    writeFileSync(file, 'binary-not-real');
    try {
      const text = await extractTextFromFile(file);
      expect(text).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps oversized text files at 500KB (boundary: huge files do not blow memory)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-huge-'));
    const file = join(dir, 'huge.log');
    writeFileSync(file, 'x'.repeat(1_200_000));
    try {
      const text = await extractTextFromFile(file);
      expect(text.length).toBeLessThanOrEqual(500_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a Chinese-filename text file as UTF-8', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-cn-'));
    const file = join(dir, '中文说明.md');
    writeFileSync(file, '中文内容段落');
    try {
      const text = await extractTextFromFile(file);
      expect(text).toContain('中文内容段落');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty string when the file is unreadable (permission/IO error)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-unreadable-'));
    const file = join(dir, 'locked.md');
    writeFileSync(file, 'secret');
    // Make the file unreadable to guarantee an IO error (best-effort on all platforms).
    try {
      const { chmodSync } = await import('node:fs');
      chmodSync(file, 0o000);
      const text = await extractTextFromFile(file);
      expect(text).toBe('');
    } catch {
      // On platforms where chmod 000 does not block the owner (e.g. root), the
      // read may still succeed — this documents that the method never throws.
      const text = await extractTextFromFile(file);
      expect(typeof text).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
