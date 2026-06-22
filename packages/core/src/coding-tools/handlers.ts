import type { AgentToolHandler, ToolOutputCallback } from '../agent.js';
import { isCodingToolName, type CodingToolName, type CodingToolConfig, type TaskContextResponse, type CodingToolEvent } from '@markus/shared';
import { getAdapter } from './adapters/index.js';
import { CodingToolRuntime } from './runtime.js';

export interface CodingToolHandlerOptions {
  /** Function to fetch task context from the API */
  getTaskContext?: (taskId: string) => Promise<TaskContextResponse | null>;
  /** Tool configurations (static snapshot — prefer getConfigs for live updates) */
  configs?: Record<string, CodingToolConfig>;
  /** Getter for live tool configs; called on each invocation so API updates are visible immediately */
  getConfigs?: () => Record<string, CodingToolConfig> | undefined;
  /** Markus CLI path for context injection */
  markusCli?: string;
  /** Markus API server URL */
  serverUrl?: string;
  /** Skills to inject into context */
  getSkills?: (toolName: CodingToolName) => Array<{ name: string; content: string }>;
}

export function createInvokeCodingToolHandler(options: CodingToolHandlerOptions = {}): AgentToolHandler {
  const runtime = new CodingToolRuntime();

  return {
    name: 'invoke_coding_tool',
    description:
      'Invoke an external coding tool (Claude Code, Codex, or Cursor) to work on a coding task. The tool runs in the specified working directory and returns its results.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          enum: ['claude-code', 'codex', 'cursor-agent'],
          description: 'Which coding tool to use',
        },
        prompt: {
          type: 'string',
          description: 'The instruction/prompt to send to the coding tool',
        },
        workdir: {
          type: 'string',
          description: 'Working directory (repository path) for the coding tool',
        },
        task_id: {
          type: 'string',
          description: 'Optional task ID for context injection',
        },
        model: {
          type: 'string',
          description: 'Model to use (overrides user default). E.g. "opus", "sonnet", "gpt-5-codex"',
        },
        mode: {
          type: 'string',
          description: 'Execution mode (tool-specific). Cursor: plan/ask. Claude Code: plan/auto. Codex: N/A',
        },
        effort: {
          type: 'string',
          description: 'Reasoning effort level. Claude Code: low/medium/high/xhigh/max. Codex: minimal/low/medium/high/xhigh',
        },
        approved: {
          type: 'boolean',
          description: 'Set to true after obtaining user approval via request_user_approval (required when approvalRequired is enabled)',
        },
      },
      required: ['tool', 'prompt', 'workdir'],
    },

    async execute(args: Record<string, unknown>, onOutput?: ToolOutputCallback): Promise<string> {
      const toolName = args.tool as string;
      const prompt = args.prompt as string;
      const workdir = args.workdir as string;
      const taskId = args.task_id as string | undefined;
      const modelOverride = args.model as string | undefined;
      const modeOverride = args.mode as string | undefined;
      const effortOverride = args.effort as string | undefined;
      const approved = args.approved === true;

      if (!isCodingToolName(toolName)) {
        return JSON.stringify({
          error: `Unknown coding tool: ${toolName}. Supported: claude-code, codex, cursor-agent`,
        });
      }

      const liveConfigs = options.getConfigs?.() ?? options.configs;
      const config = liveConfigs?.[toolName];

      if (config?.approvalRequired && !approved) {
        return JSON.stringify({
          error: 'approval_required',
          message: `${toolName} requires user approval before use. Call request_user_approval to get permission, then retry with approved: true.`,
        });
      }

      const adapter = getAdapter(toolName);

      const detection = await adapter.detect();
      if (!detection.available) {
        return JSON.stringify({
          error: `${adapter.displayName} is not installed. ${detection.installHint ?? ''}`.trim(),
          installHint: detection.installHint,
        });
      }

      const effectiveModel = modelOverride || config?.defaultModel;
      const budgetUsd = toolName === 'claude-code' ? config?.maxBudgetPerSessionUsd : undefined;

      onOutput?.(`Starting ${adapter.displayName}${effectiveModel ? ` (model: ${effectiveModel})` : ''}...\n`);

      let taskContext: TaskContextResponse | null = null;
      if (taskId && options.getTaskContext) {
        try {
          taskContext = await options.getTaskContext(taskId);
        } catch {
          /* proceed without context */
        }
      }

      if (!taskContext) {
        taskContext = {
          task: {
            id: taskId || 'unknown',
            title: 'Coding Task',
            description: prompt,
            status: 'in_progress',
            priority: 'medium',
            subtasks: [],
            assignedAgentId: '',
            reviewerId: '',
            executionRound: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          upstream: [],
          downstream: [],
        };
      }

      const skills = options.getSkills?.(toolName) ?? [];

      try {
        const session = await runtime.execute(prompt, {
          adapter,
          config,
          repoPath: workdir,
          taskContext,
          skills,
          markusCli: options.markusCli,
          serverUrl: options.serverUrl,
          model: effectiveModel,
          mode: modeOverride,
          effort: effortOverride,
          maxBudgetUsd: budgetUsd,
          onEvent: (event: CodingToolEvent) => {
            if (event.type === 'progress' || event.type === 'file_edit') {
              onOutput?.(`[${adapter.displayName}] ${event.content}\n`);
            }
          },
        });

        return JSON.stringify({
          status: session.status === 'completed' ? 'success' : 'error',
          sessionId: session.id,
          tool: toolName,
          model: effectiveModel,
          mode: modeOverride,
          result: session.result,
          cost: session.cost,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: errorMsg });
      }
    },
  };
}

export function createCodingToolApplyHandler(): AgentToolHandler {
  return {
    name: 'coding_tool_apply',
    description: 'Apply changes from a coding tool session. Merges the worktree changes back to the main branch.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID from invoke_coding_tool',
        },
        workdir: {
          type: 'string',
          description: 'The working directory where changes were made',
        },
        commit_message: {
          type: 'string',
          description: 'Optional commit message for the changes',
        },
      },
      required: ['session_id', 'workdir'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const workdir = args.workdir as string;
      const commitMessage = args.commit_message as string | undefined;

      try {
        const { execFileSync } = await import('node:child_process');

        const diffOutput = execFileSync('git', ['diff', '--stat', 'HEAD'], { cwd: workdir, encoding: 'utf-8', timeout: 10_000 });
        const statusOutput = execFileSync('git', ['status', '--porcelain'], { cwd: workdir, encoding: 'utf-8', timeout: 10_000 });

        if (!statusOutput.trim() && !diffOutput.trim()) {
          return JSON.stringify({ status: 'success', message: 'No changes to apply', filesChanged: 0 });
        }

        execFileSync('git', ['add', '-A'], { cwd: workdir, timeout: 10_000 });

        const msg = commitMessage || 'Apply coding tool changes';
        execFileSync('git', ['commit', '-m', msg], { cwd: workdir, encoding: 'utf-8', timeout: 10_000 });

        const logOutput = execFileSync('git', ['log', '-1', '--stat'], { cwd: workdir, encoding: 'utf-8', timeout: 10_000 });

        return JSON.stringify({
          status: 'success',
          message: 'Changes committed successfully',
          commitLog: logOutput.slice(0, 2000),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Failed to apply changes: ${errorMsg}` });
      }
    },
  };
}
