import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentToolHandler } from '../agent.js';
import { defaultSecurityGuard, type SecurityGuard } from '../security.js';

export function createFileReadTool(security?: SecurityGuard, workspacePath?: string): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'file_read',
    description: 'Read the contents of a file. Supports offset and limit for reading large files in chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based, optional)' },
        limit: { type: 'number', description: 'Max number of lines to read (optional, default: all)' },
      },
      required: ['path'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const rawPath = args['path'] as string;
      const path = workspacePath ? resolve(workspacePath, rawPath) : resolve(rawPath);

      // Enforce workspace isolation
      if (workspacePath && !path.startsWith(resolve(workspacePath))) {
        return JSON.stringify({ status: 'denied', error: `File path must be within workspace: ${workspacePath}` });
      }
      const offset = (args['offset'] as number | undefined) ?? 1;
      const limit = args['limit'] as number | undefined;

      const check = guard.validateFilePath(path);
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
        const endIdx = limit ? Math.min(startIdx + limit, totalLines) : totalLines;
        const selectedLines = lines.slice(startIdx, endIdx);

        const numbered = selectedLines.map((line, i) => `${startIdx + i + 1}|${line}`).join('\n');
        return JSON.stringify({
          status: 'success',
          path,
          totalLines,
          shownLines: `${startIdx + 1}-${endIdx}`,
          size: stat.size,
          content: numbered,
        });
      } catch (error) {
        return JSON.stringify({ status: 'error', error: `Failed to read: ${String(error)}` });
      }
    },
  };
}

export function createFileWriteTool(security?: SecurityGuard, workspacePath?: string): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories if needed.',
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
      const path = workspacePath ? resolve(workspacePath, rawPath) : resolve(rawPath);

      // Enforce workspace isolation
      if (workspacePath && !path.startsWith(resolve(workspacePath))) {
        return JSON.stringify({ status: 'denied', error: `File path must be within workspace: ${workspacePath}` });
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

export function createFileEditTool(security?: SecurityGuard, workspacePath?: string): AgentToolHandler {
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
      const path = workspacePath ? resolve(workspacePath, rawPath) : resolve(rawPath);

      // Enforce workspace isolation
      if (workspacePath && !path.startsWith(resolve(workspacePath))) {
        return JSON.stringify({ status: 'denied', error: `File path must be within workspace: ${workspacePath}` });
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
          // Include the actual file content so the LLM can self-correct with the right old_string
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

// Backward-compatible exports
export const FileReadTool = createFileReadTool();
export const FileWriteTool = createFileWriteTool();
export const FileEditTool = createFileEditTool();
