import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { PathAccessPolicy } from '@markus/shared';
import type { AgentToolHandler, ToolOutputCallback } from '../agent.js';
import { defaultSecurityGuard, type SecurityGuard } from '../security.js';

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

export function createShellTool(security?: SecurityGuard, workspacePath?: string, agentMeta?: ShellAgentMeta, policy?: PathAccessPolicy): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  /** Shell commands can run from any directory — read access is unrestricted */
  function isCwdAllowed(_resolved: string): boolean {
    return true;
  }

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

    async execute(args: Record<string, unknown>, onOutput?: ToolOutputCallback): Promise<string> {
      const command = args['command'] as string;
      const requestedCwd = args['cwd'] as string | undefined;
      const timeoutMs = (args['timeout_ms'] as number) ?? 60_000;

      let effectiveCwd = workspacePath;
      if (requestedCwd) {
        const base = workspacePath ?? process.cwd();
        const resolved = resolve(base, requestedCwd);
        if (!isCwdAllowed(resolved)) {
          return JSON.stringify({ status: 'denied', error: `Working directory must be within an accessible workspace zone` });
        }
        effectiveCwd = resolved;
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

      if (workspacePath) {
        const gitCheck = validateGitBranchSafety(command);
        if (!gitCheck.allowed) {
          return JSON.stringify({ status: 'denied', error: gitCheck.reason });
        }
      }

      const finalCommand = injectGitCommitMeta(command, agentMeta);

      return new Promise<string>((resolve) => {
        const child = spawn('sh', ['-c', finalCommand], {
          cwd: effectiveCwd ?? undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        let killed = false;
        const maxBuffer = 10 * 1024 * 1024;

        const timeout = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
          setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
        }, timeoutMs);

        // Throttle streaming output to avoid flooding the SSE connection
        let outputBuffer = '';
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const FLUSH_INTERVAL = 200;

        const flushOutput = () => {
          if (outputBuffer && onOutput) {
            onOutput(outputBuffer);
            outputBuffer = '';
          }
          flushTimer = null;
        };

        const bufferOutput = (chunk: string) => {
          if (!onOutput) return;
          outputBuffer += chunk;
          if (!flushTimer) {
            flushTimer = setTimeout(flushOutput, FLUSH_INTERVAL);
          }
        };

        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          if (stdout.length < maxBuffer) stdout += chunk;
          bufferOutput(chunk);
        });

        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          if (stderr.length < maxBuffer) stderr += chunk;
          bufferOutput(chunk);
        });

        child.on('close', (code) => {
          clearTimeout(timeout);
          if (flushTimer) { clearTimeout(flushTimer); flushOutput(); }

          if (killed) {
            resolve(JSON.stringify({
              status: 'error',
              error: `Command timed out after ${timeoutMs}ms`,
              exitCode: code,
              stdout: stdout.slice(0, 4000),
              stderr: stderr.slice(0, 4000),
            }));
          } else if (code !== 0) {
            resolve(JSON.stringify({
              status: 'error',
              error: stderr.trim() || `Process exited with code ${code}`,
              exitCode: code,
              stdout: stdout.slice(0, 4000),
              stderr: stderr.slice(0, 4000),
            }));
          } else {
            resolve(JSON.stringify({
              status: 'success',
              stdout: stdout.trim() || undefined,
              stderr: stderr.trim() || undefined,
            }));
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          if (flushTimer) { clearTimeout(flushTimer); flushOutput(); }
          resolve(JSON.stringify({
            status: 'error',
            error: err.message,
            stdout: stdout.slice(0, 4000),
            stderr: stderr.slice(0, 4000),
          }));
        });
      });
    },
  };
}

// Default export for backward compatibility
export const ShellTool = createShellTool();
