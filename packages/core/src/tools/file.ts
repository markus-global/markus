import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { type PathAccessPolicy, validateManifest } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import { defaultSecurityGuard, type SecurityGuard } from '../security.js';
import { assertWriteAllowed } from '../write-guard.js';
import { replaceLiteral } from './literal-replace.js';

const MANIFEST_FILENAMES = new Set(['agent.json', 'team.json', 'skill.json']);

function validateBuilderArtifactManifest(path: string, content: string): string[] {
  if (!path.includes('builder-artifacts/')) return [];
  const filename = basename(path);
  if (!MANIFEST_FILENAMES.has(filename)) return [];
  try {
    const parsed = JSON.parse(content);
    return validateManifest(parsed);
  } catch {
    return ['Manifest file is not valid JSON'];
  }
}

type AccessLevel = 'readwrite' | 'readonly' | 'denied';

/**
 * Resolve a raw path against the primary workspace, then check access.
 *
 * Write access is allowed everywhere EXCEPT paths in `denyWritePaths`
 * (other agents' directories). This prevents cross-agent interference
 * while allowing agents to modify any files the user asks them to.
 */
function resolveAndCheckAccess(
  rawPath: string,
  workspacePath: string | undefined,
  policy: PathAccessPolicy | undefined,
): { resolved: string; access: AccessLevel; reason?: string } {
  const resolved = workspacePath ? resolve(workspacePath, rawPath) : resolve(rawPath);

  // 判定收口到 write-guard（单一门禁，审计 P0-2 / G1），覆盖三类拒绝：
  // denyWritePaths（其他 agent 工作区）、系统敏感文件、**单一写入者记忆文件**
  // （knowledge.md / NOTEBOOK.md — 审计 P-01：禁止绕过记忆服务直写）。
  const decision = assertWriteAllowed(resolved, { policy, workspacePath });
  if (!decision.allowed) {
    return { resolved, access: 'denied', reason: decision.reason };
  }

  return { resolved, access: 'readwrite' };
}


interface FileReadRecord {
  mtimeMs: number;
  size: number;
  from: number;
  to: number;
  totalLines: number;
  readAt: number;
}

/**
 * Every file_read instance's dedupe cache, so a compaction can clear them all.
 *
 * The dedupe is only honest while the earlier content is still in the agent's
 * context. A compaction can drop it, so the caller must be able to reset —
 * otherwise "you already have it" becomes a lie the agent cannot escape without
 * knowing to pass `force`.
 */
const FILE_READ_CACHES = new Set<Map<string, FileReadRecord>>();

/** Drop all dedupe memory (call after a compaction rewrote history). */
export function resetAllFileReadCaches(): void {
  for (const cache of FILE_READ_CACHES) cache.clear();
}

export function createFileReadTool(security?: SecurityGuard, workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  // Per-tool-instance record of what this agent has ALREADY been shown.
  //
  // Measured failure: one task turn made 223 shell calls and repeatedly re-read
  // the same files. Re-emitting a file the agent still holds is pure cost — and
  // worse, it *feeds the loop*: the agent keeps "confirming" because asking is
  // free. Returning a cheap stub breaks that habit at the source.
  //
  // Registered so a compaction can clear it: after a compaction the earlier copy
  // may no longer be in the agent's context, and then "unchanged, you already
  // have it" would be a lie. See `resetAllFileReadCaches`.
  const readCache = new Map<string, FileReadRecord>();
  FILE_READ_CACHES.add(readCache);

  return {
    name: 'file_read',
    description: 'Read the contents of a file. Use absolute paths for reliability. Supports offset and limit for reading large files in chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file (e.g. /data/shared/report.md). Always use absolute paths.' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based, optional)' },
        limit: { type: 'number', description: 'Max number of lines to read (optional, default: all)' },
        force: { type: 'boolean', description: 'Re-read even if this exact file and range were already returned in this session. Use after a compaction, when the earlier copy may no longer be visible.' },
      },
      required: ['path'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = (args['path'] ?? args['file'] ?? args['file_path'] ?? args['filePath']) as string | undefined;
      if (!rawPath || typeof rawPath !== 'string') {
        return JSON.stringify({ status: 'error', error: 'path is required and must be a non-empty string' });
      }
      const { resolved: path } = resolveAndCheckAccess(rawPath, workspacePath, policy);

      const offset = (args['offset'] as number | undefined) ?? 1;
      const limit = args['limit'] as number | undefined;

      const check = guard.validateFileReadPath(path);
      if (!check.allowed) {
        return JSON.stringify({ status: 'denied', error: check.reason });
      }

      try {
        if (!existsSync(path)) {
          return JSON.stringify({ status: 'error', error: `File not found: ${path}` });
        }
        const stat = statSync(path);
        const content = readFileSync(path, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        const startIdx = Math.max(0, offset - 1);
        const AUTO_LINE_LIMIT = 500;
        const MAX_CHARS = 40_000;
        const userSpecifiedLimit = limit !== null && limit !== undefined;
        let endIdx = limit ? Math.min(startIdx + limit, totalLines) : totalLines;

        // Auto-limit: if no explicit limit and file is large, cap to avoid
        // excessive output that would get offloaded and create a read loop.
        let autoLimited = false;
        if (!userSpecifiedLimit && (endIdx - startIdx) > AUTO_LINE_LIMIT) {
          endIdx = Math.min(startIdx + AUTO_LINE_LIMIT, totalLines);
          autoLimited = true;
        }

        const selectedLines = lines.slice(startIdx, endIdx);
        let numbered = selectedLines.map((line, i) => `${startIdx + i + 1}|${line}`).join('\n');

        // If still too large in chars (e.g. lines are very long), trim further
        if (numbered.length > MAX_CHARS) {
          const trimmedLines: string[] = [];
          let charCount = 0;
          for (let i = 0; i < selectedLines.length; i++) {
            const line = `${startIdx + i + 1}|${selectedLines[i]}`;
            if (charCount + line.length + 1 > MAX_CHARS) break;
            trimmedLines.push(line);
            charCount += line.length + 1;
          }
          numbered = trimmedLines.join('\n');
          endIdx = startIdx + trimmedLines.length;
          autoLimited = true;
        }

        // ── Don't send the same bytes twice ────────────────────────────────
        // Same path, same line window, file untouched since → the agent already
        // has this verbatim. Answer with a stub instead of the payload, and say
        // exactly how to force a full re-read (a compaction may have dropped the
        // earlier copy).
        const force = args['force'] === true;
        const prior = readCache.get(path);
        if (
          !force &&
          prior &&
          prior.mtimeMs === stat.mtimeMs &&
          prior.size === stat.size &&
          prior.from === startIdx + 1 &&
          prior.to === endIdx &&
          prior.totalLines === totalLines
        ) {
          const preview = selectedLines
            .slice(0, 5)
            .map((line, i) => `${startIdx + i + 1}|${line}`)
            .join('\n');
          return JSON.stringify({
            status: 'success',
            path,
            unchanged: true,
            totalLines,
            shownLines: `${startIdx + 1}-${endIdx}`,
            size: stat.size,
            readAt: new Date(prior.readAt).toISOString(),
            note:
              'Identical to the read you already did this session — content not re-sent, to keep your context for work. ' +
              'First lines are repeated below only for orientation.',
            preview,
            hint:
              'Use the copy you already have. If it is no longer visible (e.g. after session_compact), ' +
              'call file_read again with force: true.',
          });
        }

        readCache.set(path, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          from: startIdx + 1,
          to: endIdx,
          totalLines,
          readAt: Date.now(),
        });

        const result: Record<string, unknown> = {
          status: 'success',
          path,
          totalLines,
          shownLines: `${startIdx + 1}-${endIdx}`,
          size: stat.size,
          content: numbered,
        };

        if (autoLimited) {
          result.truncated = true;
          result.hint = `File has ${totalLines} total lines but only lines ${startIdx + 1}-${endIdx} are shown to keep output manageable. Use 'offset' and 'limit' parameters to read specific sections (e.g. offset=${endIdx + 1}, limit=${AUTO_LINE_LIMIT}).`;
        }

        return JSON.stringify(result);
      } catch (error) {
        return JSON.stringify({ status: 'error', error: `Failed to read: ${String(error)}` });
      }
    },
  };
}

export function createFileWriteTool(security?: SecurityGuard, workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories if needed. WARNING: Do NOT write very large content (>200 lines) in a single call — this causes output truncation and timeouts. For large documents, write the first section with file_write, then append remaining sections with file_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = (args['path'] ?? args['file'] ?? args['file_path'] ?? args['filePath']) as string;
      const { resolved: path, access, reason } = resolveAndCheckAccess(rawPath, workspacePath, policy);

      if (access === 'denied') {
        return JSON.stringify({ status: 'denied', error: reason ?? 'Write denied: this path belongs to another agent\'s workspace. Create your own worktree or copy the files to your workspace.' });
      }

      const content = args['content'] as string;

      const check = guard.validateFilePath(path);
      if (!check.allowed) {
        return JSON.stringify({ status: 'denied', error: check.reason });
      }

      const manifestErrors = validateBuilderArtifactManifest(path, content);
      if (manifestErrors.length > 0) {
        return JSON.stringify({
          status: 'error',
          error: `Manifest validation failed. Fix these issues and retry:\n${manifestErrors.map(e => `- ${e}`).join('\n')}`,
          validationErrors: manifestErrors,
        });
      }

      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        return JSON.stringify({ status: 'success', path, bytesWritten: Buffer.byteLength(content) });
      } catch (error) {
        return JSON.stringify({ status: 'error', error: `Failed to write: ${String(error)}` });
      }
    },
  };
}

export function createFileEditTool(security?: SecurityGuard, workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'file_edit',
    description: 'Edit a file by replacing a specific string with a new string. Safer than full file rewrite — only changes the targeted section.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        old_string: { type: 'string', description: 'The exact text to find and replace (must be unique in the file)' },
        new_string: { type: 'string', description: 'The replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = (args['path'] ?? args['file'] ?? args['file_path'] ?? args['filePath']) as string;
      const { resolved: path, access, reason } = resolveAndCheckAccess(rawPath, workspacePath, policy);

      if (access === 'denied') {
        return JSON.stringify({ status: 'denied', error: reason ?? 'Edit denied: this path belongs to another agent\'s workspace. Create your own worktree or copy the files to your workspace.' });
      }

      const oldStr = args['old_string'] as string;
      const newStr = args['new_string'] as string;

      const check = guard.validateFilePath(path);
      if (!check.allowed) {
        return JSON.stringify({ status: 'denied', error: check.reason });
      }

      try {
        if (!existsSync(path)) {
          return JSON.stringify({ status: 'error', error: `File not found: ${path}` });
        }
        const content = readFileSync(path, 'utf-8');
        const count = content.split(oldStr).length - 1;

        if (count === 0) {
          const preview = content.length > 3000
            ? content.slice(0, 3000) + `\n... (truncated, total ${content.length} chars)`
            : content;
          return JSON.stringify({
            status: 'error',
            error: 'old_string not found in file — the text you provided does not exist verbatim.',
            hint: 'Read the current_content below, find the exact text to change, and retry file_edit with a correct old_string.',
            current_content: preview,
          });
        }
        if (count > 1) {
          return JSON.stringify({
            status: 'error',
            error: `old_string found ${count} times — must be unique. Add more surrounding context to make it unique.`,
          });
        }

        // Replacer must be a FUNCTION so newStr is inserted verbatim.
        // See tools/literal-replace.ts for the full failure mode.
        const updated = replaceLiteral(content, oldStr, newStr);
        writeFileSync(path, updated);

        return JSON.stringify({ status: 'success', path, replacements: 1 });
      } catch (error) {
        return JSON.stringify({ status: 'error', error: `Failed to edit: ${String(error)}` });
      }
    },
  };
}

// Shared access helpers exported for other tools (patch, search, shell)
export { resolveAndCheckAccess, type AccessLevel };

// Backward-compatible exports
export const FileReadTool = createFileReadTool();
export const FileWriteTool = createFileWriteTool();
export const FileEditTool = createFileEditTool();
