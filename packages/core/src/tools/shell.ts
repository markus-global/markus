import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentToolHandler } from '../agent.js';

const execFileAsync = promisify(execFile);

export const ShellTool: AgentToolHandler = {
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

    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });

      const parts: string[] = [];
      if (stdout.trim()) parts.push(stdout.trim());
      if (stderr.trim()) parts.push(`[stderr] ${stderr.trim()}`);
      return parts.join('\n') || '(no output)';
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      return JSON.stringify({
        error: err.message ?? String(error),
        exitCode: err.code,
        stdout: err.stdout?.slice(0, 2000),
        stderr: err.stderr?.slice(0, 2000),
      });
    }
  },
};
