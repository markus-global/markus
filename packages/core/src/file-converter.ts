import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createLogger } from '@markus/shared';

const log = createLogger('file-converter');

export interface ConvertedFile {
  name: string;
  mimeType: string;
  text: string;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
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
  'text/csv': '.csv',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/epub+zip': '.epub',
};

function parseDataUrl(dataUrl: string): { mimeType: string; data: Buffer } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1]!, data: Buffer.from(match[2]!, 'base64') };
}

function extensionForMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? '.bin';
}

let markitdownAvailable: boolean | null = null;

async function checkMarkitdown(): Promise<boolean> {
  if (markitdownAvailable !== null) return markitdownAvailable;
  return new Promise((resolve) => {
    execFile('markitdown', ['--help'], { timeout: 5000 }, (err) => {
      markitdownAvailable = !err;
      if (!markitdownAvailable) {
        log.info('markitdown CLI not found; file-to-text conversion will be limited. Install with: pip install "markitdown[all]"');
      }
      resolve(markitdownAvailable);
    });
  });
}

async function convertWithMarkitdown(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('markitdown', [filePath], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`markitdown failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function fallbackFileDescription(name: string, mimeType: string, sizeBytes: number): string {
  const sizeKB = Math.round(sizeBytes / 1024);
  const label = mimeType.startsWith('image/') ? 'Image' : 'File';
  return `[${label}: ${name} (${mimeType}, ${sizeKB} KB) — content not available because markitdown CLI is not installed. Install with: pip install "markitdown[all]"]`;
}

/**
 * Convert attached files (as data URLs) to text/markdown.
 * Uses markitdown CLI when available, otherwise returns a descriptive placeholder.
 */
export async function convertFilesToText(
  dataUrls: string[],
  fileNames?: string[],
): Promise<ConvertedFile[]> {
  const hasMarkitdown = await checkMarkitdown();
  const results: ConvertedFile[] = [];
  let tempDir: string | null = null;

  try {
    if (hasMarkitdown) {
      tempDir = await mkdtemp(join(tmpdir(), 'markus-convert-'));
    }

    for (let i = 0; i < dataUrls.length; i++) {
      const dataUrl = dataUrls[i]!;
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) {
        results.push({ name: fileNames?.[i] ?? `file_${i}`, mimeType: 'unknown', text: '[Unable to parse file data]' });
        continue;
      }

      const ext = extensionForMime(parsed.mimeType);
      const name = fileNames?.[i] ?? `file_${i}${ext}`;

      if (hasMarkitdown && tempDir) {
        const filePath = join(tempDir, `${i}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        try {
          await writeFile(filePath, parsed.data);
          const markdown = await convertWithMarkitdown(filePath);
          results.push({ name, mimeType: parsed.mimeType, text: markdown.trim() });
          await unlink(filePath).catch(() => {});
        } catch (err) {
          log.warn(`markitdown conversion failed for ${name}: ${err}`);
          results.push({ name, mimeType: parsed.mimeType, text: fallbackFileDescription(name, parsed.mimeType, parsed.data.length) });
        }
      } else {
        results.push({ name, mimeType: parsed.mimeType, text: fallbackFileDescription(name, parsed.mimeType, parsed.data.length) });
      }
    }
  } finally {
    if (tempDir) {
      const { rm } = await import('node:fs/promises');
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return results;
}

/** Reset cached markitdown availability (for testing) */
export function resetMarkitdownCache(): void {
  markitdownAvailable = null;
}

/** Extensions readable directly as UTF-8 text (no markitdown needed). */
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.html', '.htm', '.json', '.csv', '.tsv',
  '.xml', '.yaml', '.yml', '.js', '.ts', '.tsx', '.jsx', '.css', '.log', '.ini',
  '.conf', '.toml', '.py', '.sh', '.sql',
]);

/**
 * Extract searchable text from a file on disk.
 *
 * Strategy:
 *  - Text-like extensions → read directly as UTF-8.
 *  - Binary / Office (docx/xlsx/pptx/pdf) → markitdown CLI when available;
 *    otherwise returns a descriptive placeholder (filename-only index).
 *
 * Used by knowledge-base sync to populate deliverable `content` for full-text search.
 */
export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) {
    // Graceful degradation: an unreadable/missing text file (permission, IO,
    // vanished between scan and read) must not abort a whole knowledge sync.
    // Return '' so the caller still indexes the filename.
    try {
      const raw = await readFile(filePath, 'utf-8');
      // Hard cap to avoid indexing absurdly large files.
      return raw.slice(0, 500_000);
    } catch {
      return '';
    }
  }

  const hasMarkitdown = await checkMarkitdown();
  if (!hasMarkitdown) {
    return ''; // filename-only index; caller still creates the deliverable
  }
  try {
    const markdown = await convertWithMarkitdown(filePath);
    return markdown.trim().slice(0, 500_000);
  } catch (err) {
    log.warn('Text extraction via markitdown failed', { filePath, error: String(err) });
    return '';
  }
}
