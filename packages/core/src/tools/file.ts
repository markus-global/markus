import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentToolHandler } from '../agent.js';

export const FileReadTool: AgentToolHandler = {
  name: 'file_read',
  description: 'Read the contents of a file at the given path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args['path'] as string;
    try {
      return readFileSync(path, 'utf-8');
    } catch (error) {
      return JSON.stringify({ error: `Failed to read file: ${String(error)}` });
    }
  },
};

export const FileWriteTool: AgentToolHandler = {
  name: 'file_write',
  description: 'Write content to a file at the given path. Creates parent directories if needed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the file',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['path', 'content'],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args['path'] as string;
    const content = args['content'] as string;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return JSON.stringify({ success: true, path, bytesWritten: Buffer.byteLength(content) });
    } catch (error) {
      return JSON.stringify({ error: `Failed to write file: ${String(error)}` });
    }
  },
};
