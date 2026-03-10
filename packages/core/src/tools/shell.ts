import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentToolHandler } from '../agent.js';
import { defaultSecurityGuard, type SecurityGuard } from '../security.js';

const execFileAsync = promisify(execFile);

export interface ShellAgentMeta {
  agentId: string;
  agentName: string;
  teamName?: string;
  orgId?: string;
  currentTaskId?: string;
  currentTaskTitle?: string;
}

function injectGitCommitMeta(command: string, meta?: ShellAgentMeta): string {
  if (!meta) return command;
  const gitCommitRe = /git\s+commit\s/;
  if (!gitCommitRe.test(command)) return command;

  const trailerLines = [
    `Agent-Id: ${meta.agentId}`,
    `Agent-Name: ${meta.agentName}`,
  ];
  if (meta.teamName) trailerLines.push(`Team: ${meta.teamName}`);
  if (meta.orgId) trailerLines.push(`Org-Id: ${meta.orgId}`);
  if (meta.currentTaskId) trailerLines.push(`Task-Id: ${meta.currentTaskId}`);
  if (meta.currentTaskTitle) trailerLines.push(`Task-Title: ${meta.currentTaskTitle}`);

  const authorFlag = ` --author="${meta.agentName} <${meta.agentId}@markus.agent>"`;
  const trailerFlags = trailerLines.map(t => ` --trailer "${t}"`).join('');
  return command + authorFlag + trailerFlags;
}

const GIT_BRANCH_DENY_PATTERNS = [
  /\bgit\s+push\s+.*\b(main|master)\b/,
  /\bgit\s+push\s+--force/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+merge\s+(?!--abort)/,
  /\bgit\s+rebase\b/,
  /\bgit\s+checkout\s+(?!-b\b)(?!--\s)(\S+)/,
  /\bgit\s+switch\s+(?!-c\b)(?!--create\b)(\S+)/,
];

function validateGitBranchSafety(command: string): { allowed: boolean; reason?: string } {
  for (const pattern of GIT_BRANCH_DENY_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Git branch operation denied for workspace isolation: "${command.trim().slice(0, 80)}". Agents must work only on their assigned task branch. Do not checkout, merge, rebase, or push to protected branches.`,
      };
    }
  }
  return { allowed: true };
}

export function createShellTool(security?: SecurityGuard, workspacePath?: string, agentMeta?: ShellAgentMeta): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'shell_execute',
    description: workspacePath
      ? `Execute a shell command within workspace ${workspacePath}. Commands run in this directory by default.`
      : 'Execute a shell command and return its output. Use this for running CLI tools, scripts, git operations, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (optional)',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 60000)',
        },
      },
      required: ['command'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const command = args['command'] as string;
      const requestedCwd = args['cwd'] as string | undefined;
      const timeoutMs = (args['timeout_ms'] as number) ?? 60_000;

      // Enforce workspace isolation
      let effectiveCwd = workspacePath;
      if (requestedCwd && workspacePath) {
        const resolved = resolve(workspacePath, requestedCwd);
        if (!resolved.startsWith(resolve(workspacePath))) {
          return JSON.stringify({ status: 'denied', error: `Working directory must be within workspace: ${workspacePath}` });
        }
        effectiveCwd = resolved;
      } else if (requestedCwd) {
        effectiveCwd = requestedCwd;
      }

      const check = guard.validateShellCommand(command);
      if (!check.allowed) {
        return JSON.stringify({ status: 'denied', error: check.reason });
      }
      if (check.needsApproval) {
        return JSON.stringify({
          status: 'needs_approval',
          message: 'This command requires human approval before execution',
          command,
        });
      }

      // Enforce git branch isolation — deny checkout/merge/rebase/push to protected branches
      if (workspacePath) {
        const gitCheck = validateGitBranchSafety(command);
        if (!gitCheck.allowed) {
          return JSON.stringify({ status: 'denied', error: gitCheck.reason });
        }
      }

      const finalCommand = injectGitCommitMeta(command, agentMeta);

      try {
        const { stdout, stderr } = await execFileAsync('sh', ['-c', finalCommand], {
          cwd: effectiveCwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });

        return JSON.stringify({
          status: 'success',
          stdout: stdout.trim() || undefined,
          stderr: stderr.trim() || undefined,
        });
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
        return JSON.stringify({
          status: 'error',
          error: err.message ?? String(error),
          exitCode: err.code,
          stdout: err.stdout?.slice(0, 4000),
          stderr: err.stderr?.slice(0, 4000),
        });
      }
    },
  };
}

// Default export for backward compatibility
export const ShellTool = createShellTool();
