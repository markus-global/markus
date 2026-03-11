import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PathAccessPolicy } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import { defaultSecurityGuard, type SecurityGuard } from '../security.js';
import { resolveAndCheckAccess, denyMessage } from './file.js';

interface PatchHunk {
  file: string;
  action: 'edit' | 'create' | 'delete';
  hunks?: Array<{
    old_string: string;
    new_string: string;
  }>;
  content?: string; // for 'create' action
}

/**
 * Multi-file patch tool. Supports editing multiple hunks across multiple files
 * in a single atomic operation. Inspired by OpenClaw's apply_patch.
 */
export function createPatchTool(security?: SecurityGuard, workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'apply_patch',
    description:
      'Apply structured patches across one or more files in a single operation. ' +
      'Supports: editing (multiple hunks per file), creating new files, and deleting files. ' +
      'More efficient than multiple file_edit calls for large refactors.',
    inputSchema: {
      type: 'object',
      properties: {
        patches: {
          type: 'array',
          description: 'Array of file patches to apply',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'File path (relative to workspace)' },
              action: {
                type: 'string',
                enum: ['edit', 'create', 'delete'],
                description: 'edit: replace hunks, create: new file, delete: remove file',
              },
              hunks: {
                type: 'array',
                description: 'For "edit": array of {old_string, new_string} replacements (applied sequentially)',
                items: {
                  type: 'object',
                  properties: {
                    old_string: { type: 'string', description: 'Exact text to find' },
                    new_string: { type: 'string', description: 'Replacement text' },
                  },
                  required: ['old_string', 'new_string'],
                },
              },
              content: { type: 'string', description: 'For "create": file content to write' },
            },
            required: ['file', 'action'],
          },
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate patches without applying them (default: false)',
        },
      },
      required: ['patches'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const patches = args['patches'] as PatchHunk[];
      const dryRun = args['dry_run'] as boolean ?? false;

      if (!patches || !Array.isArray(patches) || patches.length === 0) {
        return JSON.stringify({ status: 'error', error: 'patches array is required and must not be empty' });
      }

      const basePath = workspacePath ?? process.cwd();
      const results: Array<{ file: string; action: string; status: string; detail?: string }> = [];

      // Validation pass
      for (const patch of patches) {
        const { resolved: filePath, access } = resolveAndCheckAccess(patch.file, workspacePath, policy);

        if (access === 'denied') {
          return JSON.stringify({ status: 'denied', error: denyMessage(filePath, workspacePath, policy) });
        }
        // All patch actions (edit, create, delete) are write operations
        if (access === 'readonly') {
          return JSON.stringify({ status: 'denied', error: `Path is read-only, cannot ${patch.action}: ${patch.file}` });
        }

        const check = guard.validateFilePath(filePath);
        if (!check.allowed) {
          return JSON.stringify({ status: 'denied', error: `Blocked: ${check.reason} (${patch.file})` });
        }

        if (patch.action === 'edit') {
          if (!patch.hunks || patch.hunks.length === 0) {
            return JSON.stringify({ status: 'error', error: `edit action requires hunks for ${patch.file}` });
          }
          if (!existsSync(filePath)) {
            return JSON.stringify({ status: 'error', error: `File not found for edit: ${patch.file}` });
          }

          // Validate all hunks can be found
          let content = readFileSync(filePath, 'utf-8');
          for (let i = 0; i < patch.hunks.length; i++) {
            const hunk = patch.hunks[i]!;
            const count = content.split(hunk.old_string).length - 1;
            if (count === 0) {
              return JSON.stringify({
                status: 'error',
                error: `Hunk ${i + 1} old_string not found in ${patch.file}`,
                hint: 'The text you provided does not exist verbatim. Re-read the file and try again.',
              });
            }
            if (count > 1) {
              return JSON.stringify({
                status: 'error',
                error: `Hunk ${i + 1} old_string found ${count} times in ${patch.file} — must be unique`,
              });
            }
            content = content.replace(hunk.old_string, hunk.new_string);
          }
        }

        if (patch.action === 'create' && !patch.content && patch.content !== '') {
          return JSON.stringify({ status: 'error', error: `create action requires content for ${patch.file}` });
        }
      }

      if (dryRun) {
        return JSON.stringify({
          status: 'success',
          message: `Dry run: all ${patches.length} patches validated successfully`,
          patchCount: patches.length,
        });
      }

      // Apply pass
      for (const patch of patches) {
        const filePath = resolve(basePath, patch.file);

        switch (patch.action) {
          case 'edit': {
            let content = readFileSync(filePath, 'utf-8');
            for (const hunk of patch.hunks!) {
              content = content.replace(hunk.old_string, hunk.new_string);
            }
            writeFileSync(filePath, content);
            results.push({
              file: patch.file,
              action: 'edit',
              status: 'success',
              detail: `${patch.hunks!.length} hunks applied`,
            });
            break;
          }

          case 'create': {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, patch.content ?? '');
            results.push({
              file: patch.file,
              action: 'create',
              status: 'success',
              detail: `${Buffer.byteLength(patch.content ?? '')} bytes written`,
            });
            break;
          }

          case 'delete': {
            if (existsSync(filePath)) {
              unlinkSync(filePath);
              results.push({ file: patch.file, action: 'delete', status: 'success' });
            } else {
              results.push({ file: patch.file, action: 'delete', status: 'skipped', detail: 'File not found' });
            }
            break;
          }
        }
      }

      return JSON.stringify({
        status: 'success',
        appliedPatches: results.length,
        results,
      });
    },
  };
}
