import type { SkillInstance } from '../types.js';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

export function createCodeAnalysisSkill(): SkillInstance {
  return {
    manifest: {
      name: 'code-analysis',
      version: '1.0.0',
      description: 'Code analysis tools — search code, count lines, find patterns, analyze project structure',
      author: 'markus-official',
      category: 'development',
      tags: ['code', 'analysis', 'search', 'grep'],
      tools: [
        { name: 'code_search', description: 'Search code with regex patterns', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
        { name: 'project_structure', description: 'Get project directory structure', inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' } } } },
        { name: 'code_stats', description: 'Count lines of code by file type', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
      requiredPermissions: ['file'],
    },
    tools: [
      {
        name: 'code_search',
        description: 'Search for a regex pattern in code files. Returns matching lines with file paths and line numbers.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            path: { type: 'string', description: 'Directory to search in (default: cwd)' },
            file_glob: { type: 'string', description: 'File pattern filter, e.g. "*.ts"' },
          },
          required: ['pattern'],
        },
        async execute(args) {
          try {
            const dir = args['path'] as string || process.cwd();
            const glob = args['file_glob'] ? `--include="${args['file_glob']}"` : '';
            const out = execSync(
              `grep -rn ${glob} "${args['pattern']}" "${dir}" 2>/dev/null | head -50`,
              { encoding: 'utf-8', timeout: 15000 },
            );
            return JSON.stringify({ status: 'success', matches: out || '(no matches)', count: out.split('\n').filter(Boolean).length });
          } catch { return JSON.stringify({ status: 'success', matches: '(no matches)', count: 0 }); }
        },
      },
      {
        name: 'project_structure',
        description: 'Get the directory tree structure of a project.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Root directory (default: cwd)' },
            depth: { type: 'number', description: 'Max depth level (default: 3)' },
          },
        },
        async execute(args) {
          const root = args['path'] as string || process.cwd();
          const maxDepth = (args['depth'] as number) ?? 3;
          const ignorePatterns = ['node_modules', '.git', 'dist', '.markus', '__pycache__', '.next'];

          function walk(dir: string, depth: number, prefix: string): string[] {
            if (depth > maxDepth) return [];
            const lines: string[] = [];
            try {
              const entries = readdirSync(dir, { withFileTypes: true })
                .filter(e => !ignorePatterns.includes(e.name) && !e.name.startsWith('.'))
                .sort((a, b) => {
                  if (a.isDirectory() && !b.isDirectory()) return -1;
                  if (!a.isDirectory() && b.isDirectory()) return 1;
                  return a.name.localeCompare(b.name);
                });

              for (let i = 0; i < entries.length; i++) {
                const entry = entries[i]!;
                const isLast = i === entries.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = isLast ? '    ' : '│   ';

                if (entry.isDirectory()) {
                  lines.push(`${prefix}${connector}${entry.name}/`);
                  lines.push(...walk(join(dir, entry.name), depth + 1, prefix + childPrefix));
                } else {
                  lines.push(`${prefix}${connector}${entry.name}`);
                }
              }
            } catch { /* ignore permission errors */ }
            return lines;
          }

          const tree = walk(root, 0, '');
          return JSON.stringify({ status: 'success', tree: tree.join('\n').slice(0, 5000) });
        },
      },
      {
        name: 'code_stats',
        description: 'Count lines of code grouped by file extension.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Root directory (default: cwd)' },
          },
        },
        async execute(args) {
          const root = args['path'] as string || process.cwd();
          const ignorePatterns = ['node_modules', '.git', 'dist', '.markus'];
          const stats: Record<string, { files: number; lines: number }> = {};

          function countDir(dir: string): void {
            try {
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (ignorePatterns.includes(entry.name)) continue;
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                  countDir(full);
                } else {
                  const ext = extname(entry.name) || entry.name;
                  if (!stats[ext]) stats[ext] = { files: 0, lines: 0 };
                  stats[ext]!.files++;
                  try {
                    const content = readFileSync(full, 'utf-8');
                    stats[ext]!.lines += content.split('\n').length;
                  } catch { /* skip binary files */ }
                }
              }
            } catch { /* ignore */ }
          }

          countDir(root);
          const sorted = Object.entries(stats).sort(([, a], [, b]) => b.lines - a.lines);
          const totalLines = sorted.reduce((sum, [, v]) => sum + v.lines, 0);
          const totalFiles = sorted.reduce((sum, [, v]) => sum + v.files, 0);

          return JSON.stringify({
            status: 'success',
            totalFiles,
            totalLines,
            byExtension: Object.fromEntries(sorted.slice(0, 20)),
          });
        },
      },
    ],
  };
}
