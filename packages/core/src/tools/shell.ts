import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { SHELL_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS, type PathAccessPolicy } from '@markus/shared';
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

const GIT_ALWAYS_DENY: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+push\s+--force/, label: 'force push (--force)' },
  { pattern: /\bgit\s+push\s+-f\b/, label: 'force push (-f)' },
];

const GIT_NEEDS_APPROVAL: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+push\s+.*\b(main|master)\b/, label: 'push to protected branch' },
  { pattern: /\bgit\s+merge\s+(?!--abort)/, label: 'merge branches' },
  { pattern: /\bgit\s+rebase\b/, label: 'rebase' },
  { pattern: /\bgit\s+checkout\s+(?!-b\b)(?!--\s)(\S+)/, label: 'switch to existing branch' },
  { pattern: /\bgit\s+switch\s+(?!-c\b)(?!--create\b)(\S+)/, label: 'switch to existing branch' },
];

export type CommandApprovalCallback = (command: string, reason: string) => Promise<{ approved: boolean; comment?: string }>;

function validateGitBranchSafety(command: string): { allowed: boolean; needsApproval?: boolean; reason?: string } {
  for (const { pattern, label } of GIT_ALWAYS_DENY) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Git operation always denied: ${label}. Command: "${command.trim().slice(0, 80)}"`,
      };
    }
  }
  for (const { pattern, label } of GIT_NEEDS_APPROVAL) {
    if (pattern.test(command)) {
      return {
        allowed: true,
        needsApproval: true,
        reason: `Git operation requires approval: ${label}. Command: "${command.trim().slice(0, 80)}"`,
      };
    }
  }
  return { allowed: true };
}

export function createShellTool(security?: SecurityGuard, workspacePath?: string, agentMeta?: ShellAgentMeta, policy?: PathAccessPolicy, onCommandApproval?: CommandApprovalCallback): AgentToolHandler {
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
          description: `Timeout in milliseconds (default: ${SHELL_TIMEOUT_DEFAULT_MS}, max: ${SHELL_TIMEOUT_MAX_MS})`,
        },
      },
      required: ['command'],
    },

    async execute(args: Record<string, unknown>, onOutput?: ToolOutputCallback): Promise<string> {
      const command = args['command'] as string;
      const requestedCwd = args['cwd'] as string | undefined;
      const timeoutMs = Math.min(
        (args['timeout_ms'] as number) ?? SHELL_TIMEOUT_DEFAULT_MS,
        SHELL_TIMEOUT_MAX_MS,
      );

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
        if (onCommandApproval) {
          const result = await onCommandApproval(command, 'Command matches security approval policy');
          if (!result.approved) {
            const reason = result.comment ? `: ${result.comment}` : '';
            return JSON.stringify({ status: 'denied', error: `Command denied by human reviewer${reason}` });
          }
        } else {
          return JSON.stringify({
            status: 'needs_approval',
            message: 'This command requires human approval before execution, but no approval handler is available',
            command,
          });
        }
      }

      const gitCheck = validateGitBranchSafety(command);
      if (!gitCheck.allowed) {
        return JSON.stringify({ status: 'denied', error: gitCheck.reason });
      }
      if (gitCheck.needsApproval) {
        if (onCommandApproval) {
          const result = await onCommandApproval(command, gitCheck.reason!);
          if (!result.approved) {
            const reason = result.comment ? `: ${result.comment}` : '';
            return JSON.stringify({ status: 'denied', error: `Git operation denied by human${reason}` });
          }
        } else {
          return JSON.stringify({
            status: 'denied',
            error: `${gitCheck.reason} No approval handler available — cannot proceed.`,
          });
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
