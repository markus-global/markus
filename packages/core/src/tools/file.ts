import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PathAccessPolicy } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import { defaultSecurityGuard, type SecurityGuard } from '../security.js';

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
): { resolved: string; access: AccessLevel } {
  const resolved = workspacePath ? resolve(workspacePath, rawPath) : resolve(rawPath);

  if (policy?.denyWritePaths) {
    for (const denied of policy.denyWritePaths) {
      if (resolved.startsWith(resolve(denied))) {
        return { resolved, access: 'denied' };
      }
    }
  }

  return { resolved, access: 'readwrite' };
}

function denyMessage(_resolved: string, _workspacePath?: string, _policy?: PathAccessPolicy): string {
  return 'Write denied: this path belongs to another agent\'s workspace.';
}

export function createFileReadTool(security?: SecurityGuard, workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'file_read',
    description: 'Read the contents of a file. Use absolute paths for reliability. Supports offset and limit for reading large files in chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file (e.g. /data/shared/report.md). Always use absolute paths.' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based, optional)' },
        limit: { type: 'number', description: 'Max number of lines to read (optional, default: all)' },
      },
      required: ['path'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = args['path'] as string;
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
      const rawPath = args['path'] as string;
      const { resolved: path, access } = resolveAndCheckAccess(rawPath, workspacePath, policy);

      if (access === 'denied') {
        return JSON.stringify({ status: 'denied', error: 'Write denied: this path belongs to another agent\'s workspace. Create your own worktree or copy the files to your workspace.' });
      }

      const content = args['content'] as string;

      const check = guard.validateFilePath(path);
      if (!check.allowed) {
        return JSON.stringify({ status: 'denied', error: check.reason });
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
      const rawPath = args['path'] as string;
      const { resolved: path, access } = resolveAndCheckAccess(rawPath, workspacePath, policy);

      if (access === 'denied') {
        return JSON.stringify({ status: 'denied', error: 'Edit denied: this path belongs to another agent\'s workspace. Create your own worktree or copy the files to your workspace.' });
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

        const updated = content.replace(oldStr, newStr);
        writeFileSync(path, updated);

        return JSON.stringify({ status: 'success', path, replacements: 1 });
      } catch (error) {
        return JSON.stringify({ status: 'error', error: `Failed to edit: ${String(error)}` });
      }
    },
  };
}

// Shared access helpers exported for other tools (patch, search, shell)
export { resolveAndCheckAccess, denyMessage, type AccessLevel };

// Backward-compatible exports
export const FileReadTool = createFileReadTool();
export const FileWriteTool = createFileWriteTool();
export const FileEditTool = createFileEditTool();
