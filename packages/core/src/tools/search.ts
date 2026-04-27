import { execFile } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { PathAccessPolicy } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';

const execFileAsync = promisify(execFile);

/** Read-only search tools can access any path — no restrictions on reads by design */
function isPathAccessible(_resolvedPath: string, _workspacePath?: string, _policy?: PathAccessPolicy): boolean {
  return true;
}

/**
 * Ripgrep-based search tool. Falls back to native grep if rg is not installed.
 */
export function createGrepTool(workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  return {
    name: 'grep_search',
    description: 'Search file contents using regex patterns. Fast ripgrep-based search across the codebase. Use this to find function definitions, imports, string occurrences, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in (default: workspace root)' },
        include: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts" or "*.py"' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
        max_results: { type: 'number', description: 'Maximum number of matches to return (default: 50)' },
        context_lines: { type: 'number', description: 'Number of context lines around each match (default: 2)' },
      },
      required: ['pattern'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const pattern = args['pattern'] as string;
      const searchPath = args['path'] as string | undefined;
      const include = args['include'] as string | undefined;
      const caseInsensitive = args['case_insensitive'] as boolean | undefined;
      const maxResults = (args['max_results'] as number) ?? 50;
      const contextLines = (args['context_lines'] as number) ?? 2;

      const basePath = workspacePath ?? process.cwd();
      const target = searchPath ? resolve(basePath, searchPath) : basePath;

      if (!isPathAccessible(target, workspacePath, policy)) {
        return JSON.stringify({ status: 'denied', error: 'Search path must be within an accessible workspace zone' });
      }

      // Try ripgrep first, fall back to grep
      const rgArgs = [
        '--no-heading', '--line-number', '--color=never',
        '-C', String(contextLines),
        '-m', String(maxResults),
      ];
      if (caseInsensitive) rgArgs.push('-i');
      if (include) rgArgs.push('--glob', include);
      rgArgs.push(pattern, target);

      try {
        const { stdout } = await execFileAsync('rg', rgArgs, {
          timeout: 15_000,
          maxBuffer: 5 * 1024 * 1024,
          cwd: basePath,
        });
        const lines = stdout.trim().split('\n');
        const truncated = lines.length > maxResults * (contextLines * 2 + 1);

        return JSON.stringify({
          status: 'success',
          matchCount: lines.filter(l => !l.startsWith('--')).length,
          results: stdout.trim().slice(0, 30_000),
          truncated,
        });
      } catch (rgErr) {
        const err = rgErr as { code?: number; stdout?: string; stderr?: string };
        if (err.code === 1 && !err.stderr) {
          return JSON.stringify({ status: 'success', matchCount: 0, results: '', message: 'No matches found' });
        }
        // ripgrep not installed, try native grep
        try {
          const grepArgs = ['-rn', '--color=never'];
          if (caseInsensitive) grepArgs.push('-i');
          if (include) grepArgs.push('--include', include);
          grepArgs.push('-C', String(contextLines), pattern, target);
          const { stdout } = await execFileAsync('grep', grepArgs, {
            timeout: 15_000,
            maxBuffer: 5 * 1024 * 1024,
          });
          return JSON.stringify({
            status: 'success',
            results: stdout.trim().slice(0, 30_000),
          });
        } catch (grepErr) {
          const ge = grepErr as { code?: number };
          if (ge.code === 1) {
            return JSON.stringify({ status: 'success', matchCount: 0, results: '', message: 'No matches found' });
          }
          return JSON.stringify({ status: 'error', error: `Search failed: ${String(grepErr)}` });
        }
      }
    },
  };
}

/**
 * Glob-based file finder. Uses native filesystem traversal.
 */
export function createGlobTool(workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  return {
    name: 'glob_find',
    description: 'Find files by name pattern (glob). Use this to locate files by extension, name, or path pattern. Examples: "*.ts", "**/*.test.ts", "src/**/index.*"',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "*.ts", "**/*.test.ts", "src/**/*.tsx"' },
        path: { type: 'string', description: 'Base directory to search from (default: workspace root)' },
        max_results: { type: 'number', description: 'Maximum files to return (default: 100)' },
      },
      required: ['pattern'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const pattern = args['pattern'] as string;
      const searchPath = args['path'] as string | undefined;
      const maxResults = (args['max_results'] as number) ?? 100;

      const basePath = workspacePath ?? process.cwd();
      const target = searchPath ? resolve(basePath, searchPath) : basePath;

      if (!isPathAccessible(target, workspacePath, policy)) {
        return JSON.stringify({ status: 'denied', error: 'Search path must be within an accessible workspace zone' });
      }

      try {
        // Use `find` with shell globbing via sh -c
        const findArgs = ['-c', `find "${target}" -type f -name "${pattern}" 2>/dev/null | head -${maxResults}`];
        const { stdout } = await execFileAsync('sh', findArgs, {
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
        });

        const files = stdout.trim().split('\n').filter(Boolean);
        const relativePaths = files.map(f => relative(basePath, f));

        return JSON.stringify({
          status: 'success',
          fileCount: relativePaths.length,
          files: relativePaths,
          truncated: relativePaths.length >= maxResults,
        });
      } catch (error) {
        return JSON.stringify({ status: 'error', error: `Glob search failed: ${String(error)}` });
      }
    },
  };
}

/**
 * Directory listing tool with tree-like output.
 */
export function createListDirectoryTool(workspacePath?: string, policy?: PathAccessPolicy): AgentToolHandler {
  return {
    name: 'list_directory',
    description: 'List directory contents with file sizes and types. Provides a tree-like view of the project structure. Use this before reading files to understand the codebase layout.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (default: workspace root)' },
        depth: { type: 'number', description: 'Max depth for recursive listing (default: 2, max: 5)' },
        show_hidden: { type: 'boolean', description: 'Show hidden files/dirs (default: false)' },
      },
      required: [],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const dirPath = args['path'] as string | undefined;
      const maxDepth = Math.min((args['depth'] as number) ?? 2, 5);
      const showHidden = args['show_hidden'] as boolean ?? false;

      const basePath = workspacePath ?? process.cwd();
      const target = dirPath ? resolve(basePath, dirPath) : basePath;

      if (!isPathAccessible(target, workspacePath, policy)) {
        return JSON.stringify({ status: 'denied', error: 'Path must be within an accessible workspace zone' });
      }

      if (!existsSync(target)) {
        return JSON.stringify({ status: 'error', error: `Directory not found: ${target}` });
      }

      const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage', '.turbo']);
      const lines: string[] = [];
      let fileCount = 0;
      let dirCount = 0;

      function walk(dir: string, prefix: string, depth: number) {
        if (depth > maxDepth || fileCount + dirCount > 500) return;

        let entries: string[];
        try {
          entries = readdirSync(dir).sort();
        } catch {
          return;
        }

        if (!showHidden) {
          entries = entries.filter(e => !e.startsWith('.'));
        }

        entries = entries.filter(e => !SKIP_DIRS.has(e));

        for (let i = 0; i < entries.length; i++) {
          const name = entries[i]!;
          const fullPath = resolve(dir, name);
          const isLast = i === entries.length - 1;
          const connector = isLast ? '└── ' : '├── ';

          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              dirCount++;
              lines.push(`${prefix}${connector}${name}/`);
              walk(fullPath, prefix + (isLast ? '    ' : '│   '), depth + 1);
            } else {
              fileCount++;
              const sizeKB = (stat.size / 1024).toFixed(1);
              lines.push(`${prefix}${connector}${name}  (${sizeKB} KB)`);
            }
          } catch {
            lines.push(`${prefix}${connector}${name}  [access denied]`);
          }
        }
      }

      const rootName = relative(basePath, target) || '.';
      lines.push(`${rootName}/`);
      walk(target, '', 0);

      return JSON.stringify({
        status: 'success',
        path: target,
        tree: lines.join('\n'),
        summary: `${dirCount} directories, ${fileCount} files`,
      });
    },
  };
}
