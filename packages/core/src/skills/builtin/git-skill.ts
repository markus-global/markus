import type { SkillInstance } from '../types.js';
import { execSync } from 'node:child_process';

export function createGitSkill(): SkillInstance {
  return {
    manifest: {
      name: 'git',
      version: '1.0.0',
      description: 'Git version control operations — status, diff, log, branch management',
      author: 'markus-official',
      category: 'development',
      tags: ['git', 'vcs', 'version-control'],
      tools: [
        { name: 'git_status', description: 'Get git repository status', inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } } },
        { name: 'git_diff', description: 'Show git diff', inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, staged: { type: 'boolean' } } } },
        { name: 'git_log', description: 'Show recent git commits', inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, count: { type: 'number' } } } },
        { name: 'git_branch', description: 'List or create git branches', inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, create: { type: 'string' } } } },
      ],
      requiredPermissions: ['shell'],
    },
    tools: [
      {
        name: 'git_status',
        description: 'Get git repository status including staged, modified, and untracked files.',
        inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Working directory' } } },
        async execute(args) {
          try {
            const out = execSync('git status --porcelain', { cwd: args['cwd'] as string || process.cwd(), encoding: 'utf-8', timeout: 10000 });
            return JSON.stringify({ status: 'success', output: out || '(clean working tree)' });
          } catch (e) { return JSON.stringify({ status: 'error', error: String(e) }); }
        },
      },
      {
        name: 'git_diff',
        description: 'Show git diff of current changes. Use staged=true for staged changes only.',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory' },
            staged: { type: 'boolean', description: 'Show only staged changes' },
          },
        },
        async execute(args) {
          try {
            const cmd = args['staged'] ? 'git diff --cached' : 'git diff';
            const out = execSync(cmd, { cwd: args['cwd'] as string || process.cwd(), encoding: 'utf-8', timeout: 10000 });
            return JSON.stringify({ status: 'success', output: out.slice(0, 8000) || '(no changes)' });
          } catch (e) { return JSON.stringify({ status: 'error', error: String(e) }); }
        },
      },
      {
        name: 'git_log',
        description: 'Show recent git commit log.',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory' },
            count: { type: 'number', description: 'Number of commits to show (default: 10)' },
          },
        },
        async execute(args) {
          try {
            const n = (args['count'] as number) ?? 10;
            const out = execSync(`git log --oneline -${n}`, { cwd: args['cwd'] as string || process.cwd(), encoding: 'utf-8', timeout: 10000 });
            return JSON.stringify({ status: 'success', output: out || '(no commits)' });
          } catch (e) { return JSON.stringify({ status: 'error', error: String(e) }); }
        },
      },
      {
        name: 'git_branch',
        description: 'List branches or create a new branch.',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory' },
            create: { type: 'string', description: 'Name of branch to create (omit to just list)' },
          },
        },
        async execute(args) {
          try {
            const cwd = args['cwd'] as string || process.cwd();
            if (args['create']) {
              execSync(`git checkout -b ${args['create']}`, { cwd, encoding: 'utf-8', timeout: 10000 });
              return JSON.stringify({ status: 'success', message: `Branch ${args['create']} created and checked out` });
            }
            const out = execSync('git branch -a', { cwd, encoding: 'utf-8', timeout: 10000 });
            return JSON.stringify({ status: 'success', output: out });
          } catch (e) { return JSON.stringify({ status: 'error', error: String(e) }); }
        },
      },
    ],
  };
}
