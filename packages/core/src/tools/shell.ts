import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentToolHandler } from '../agent.js';
import { defaultSecurityGuard, type SecurityGuard } from '../security.js';

const execFileAsync = promisify(execFile);

export function createShellTool(security?: SecurityGuard): AgentToolHandler {
  const guard = security ?? defaultSecurityGuard;

  return {
    name: 'shell_execute',
    description: 'Execute a shell command and return its output. Use this for running CLI tools, scripts, git operations, etc.',
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
      const cwd = args['cwd'] as string | undefined;
      const timeoutMs = (args['timeout_ms'] as number) ?? 60_000;

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

      try {
        const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
          cwd,
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
