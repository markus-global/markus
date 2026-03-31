import { createLogger, type LLMMessage, type LLMTool } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import type { ContextEngine } from '../context-engine.js';

const log = createLogger('subagent');

const DEFAULT_MAX_SUBAGENT_ITERATIONS = 200;

export interface SubagentContext {
  llmRouter: LLMRouter;
  contextEngine: ContextEngine;
  getTools: () => Map<string, AgentToolHandler>;
  getProvider: () => string | undefined;
  agentId: string;
  offloadLargeResult: (toolName: string, result: string) => string;
  maxToolIterations?: number;
}

function isErrorResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed.status === 'error' || parsed.status === 'denied';
  } catch {
    return false;
  }
}

const BLOCKED_TOOLS = new Set([
  'spawn_subagent', 'spawn_subagents',
  'send_user_message', 'discover_tools',
]);

function buildToolMap(
  parentTools: Map<string, AgentToolHandler>,
  allowedTools?: string[],
): Map<string, AgentToolHandler> {
  const toolMap = new Map<string, AgentToolHandler>();
  if (allowedTools && allowedTools.length > 0) {
    for (const name of allowedTools) {
      const handler = parentTools.get(name);
      if (handler && !BLOCKED_TOOLS.has(name)) {
        toolMap.set(name, handler);
      }
    }
  } else {
    for (const [name, handler] of parentTools) {
      if (!BLOCKED_TOOLS.has(name)) {
        toolMap.set(name, handler);
      }
    }
  }
  return toolMap;
}

/**
 * Run a lightweight subagent loop: independent messages[], parent's tools, sync return.
 *
 * Claude Code subagent pattern (learn-claude-code s04):
 * - Fresh messages[] per child — clean context, no pollution of parent conversation
 * - Inherits parent tools — no separate registration needed
 * - Synchronous return — result flows back as tool_result to parent
 *
 * Exported so other modules (e.g. task system) can invoke subagent execution
 * without going through the tool dispatch path.
 */
export async function runSubagentLoop(
  ctx: SubagentContext,
  task: string,
  opts?: {
    systemPrompt?: string;
    allowedTools?: string[];
    maxIterations?: number;
  },
): Promise<string> {
  const hardCap = ctx.maxToolIterations ?? DEFAULT_MAX_SUBAGENT_ITERATIONS;
  const maxIter = Math.min(opts?.maxIterations ?? hardCap, hardCap);

  const parentTools = ctx.getTools();
  const provider = ctx.getProvider();
  const contextWindow = ctx.llmRouter.getModelContextWindow(provider);

  const toolMap = buildToolMap(parentTools, opts?.allowedTools);

  const llmTools: LLMTool[] = [...toolMap.values()].map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const systemContent = opts?.systemPrompt
    ?? 'You are a focused subagent spawned to handle a specific subtask. Complete the task thoroughly and return a clear, concise result. Do not ask follow-up questions — work with what you have.';

  let messages: LLMMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: task },
  ];

  log.info('Subagent started', {
    parentAgent: ctx.agentId,
    taskLength: task.length,
    toolCount: toolMap.size,
    maxIterations: maxIter,
  });

  let response = await ctx.llmRouter.chat({
    messages,
    tools: llmTools.length > 0 ? llmTools : undefined,
    metadata: { agentId: ctx.agentId, sessionId: `subagent_${Date.now()}` },
  }, provider);

  let iterations = 0;

  while (
    (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
    response.finishReason === 'max_tokens'
  ) {
    if (++iterations > maxIter) {
      log.warn('Subagent hit max iterations', { parentAgent: ctx.agentId, iterations });
      break;
    }

    if (response.finishReason === 'max_tokens' && !response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: '[Continue from where you left off. Do not repeat what you already said.]',
      });
    } else {
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const tc of response.toolCalls!) {
        const handler = toolMap.get(tc.name);
        let result: string;
        if (!handler) {
          result = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
        } else {
          try {
            result = await handler.execute(tc.arguments);
            result = ctx.offloadLargeResult(tc.name, result);
          } catch (err) {
            result = `Error: ${String(err)}`;
          }
        }
        messages.push({ role: 'tool', content: result, toolCallId: tc.id });
      }
    }

    messages = ctx.contextEngine.shrinkEphemeralMessages(messages, contextWindow);

    response = await ctx.llmRouter.chat({
      messages,
      tools: llmTools.length > 0 ? llmTools : undefined,
      metadata: { agentId: ctx.agentId, sessionId: `subagent_${Date.now()}` },
    }, provider);
  }

  log.info('Subagent completed', {
    parentAgent: ctx.agentId,
    iterations,
    resultLength: response.content.length,
  });

  return response.content;
}

/**
 * Creates the spawn_subagent tool (single subagent).
 */
export function createSubagentTool(ctx: SubagentContext): AgentToolHandler {
  return {
    name: 'spawn_subagent',
    description:
      'Spawn a lightweight subagent with a clean, independent context to handle a focused subtask. ' +
      'The subagent inherits your tools but gets its own message history — it will not pollute your conversation. ' +
      'Use this to break down complex tasks: deep code analysis, research, file refactoring, test generation, etc. ' +
      'The subagent runs to completion and returns its final result to you. ' +
      'For running multiple subagents in parallel, use spawn_subagents instead.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The focused task prompt for the subagent. Be specific about what you want it to do and what result to return.',
        },
        system_prompt: {
          type: 'string',
          description: 'Optional custom system prompt for the subagent. Defaults to a focused task-execution prompt.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of tool names the subagent can use. If omitted, it inherits all parent tools.',
        },
        max_iterations: {
          type: 'number',
          description: 'Max tool iterations. Lower this for quick tasks.',
        },
      },
      required: ['task'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const task = args['task'] as string;
      if (!task) {
        return JSON.stringify({ status: 'error', error: 'task is required' });
      }
      try {
        const result = await runSubagentLoop(ctx, task, {
          systemPrompt: args['system_prompt'] as string | undefined,
          allowedTools: args['allowed_tools'] as string[] | undefined,
          maxIterations: args['max_iterations'] as number | undefined,
        });
        return JSON.stringify({ status: 'completed', result });
      } catch (err) {
        log.error('Subagent execution failed', { error: String(err) });
        return JSON.stringify({ status: 'error', error: `Subagent failed: ${String(err)}` });
      }
    },
  };
}

/**
 * Creates the spawn_subagents tool (parallel batch execution).
 *
 * Runs multiple subagent loops concurrently via Promise.all.
 * Each subagent gets an independent context and tool set.
 * All results are collected and returned together.
 *
 * This solves the limitation where the task execution path runs tools
 * sequentially — by accepting multiple tasks in a single tool call,
 * the subagents execute in parallel regardless of the calling path.
 */
export function createParallelSubagentTool(ctx: SubagentContext): AgentToolHandler {
  return {
    name: 'spawn_subagents',
    description:
      'Spawn multiple subagents in PARALLEL, each with an independent context. ' +
      'All subagents run concurrently and their results are collected and returned together. ' +
      'Use this when you have multiple independent subtasks that can be worked on simultaneously: ' +
      'analyzing different files, researching different topics, implementing separate modules, etc. ' +
      'Each subagent gets its own clean message history and inherits your tools. ' +
      'IMPORTANT: Only use for truly independent tasks — subagents cannot communicate with each other.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'A short identifier for this subtask (used to label results). E.g. "auth-review", "api-tests".',
              },
              task: {
                type: 'string',
                description: 'The focused task prompt for this subagent.',
              },
              allowed_tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional subset of tools this subagent can use.',
              },
              max_iterations: {
                type: 'number',
                description: 'Optional max iterations for this subagent.',
              },
            },
            required: ['id', 'task'],
          },
          description: 'Array of subtasks to execute in parallel. Each gets an independent subagent.',
        },
        system_prompt: {
          type: 'string',
          description: 'Optional shared system prompt for all subagents.',
        },
      },
      required: ['tasks'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const tasks = args['tasks'] as Array<{
        id: string;
        task: string;
        allowed_tools?: string[];
        max_iterations?: number;
      }>;
      if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
        return JSON.stringify({ status: 'error', error: 'tasks array is required and must not be empty' });
      }

      const MAX_PARALLEL = 10;
      if (tasks.length > MAX_PARALLEL) {
        return JSON.stringify({
          status: 'error',
          error: `Too many parallel subagents (${tasks.length}). Maximum is ${MAX_PARALLEL}.`,
        });
      }

      const sharedSystemPrompt = args['system_prompt'] as string | undefined;

      log.info('Spawning parallel subagents', {
        parentAgent: ctx.agentId,
        count: tasks.length,
        taskIds: tasks.map(t => t.id),
      });

      const startTime = Date.now();

      const results = await Promise.allSettled(
        tasks.map(async (t) => {
          const result = await runSubagentLoop(ctx, t.task, {
            systemPrompt: sharedSystemPrompt,
            allowedTools: t.allowed_tools,
            maxIterations: t.max_iterations,
          });
          return { id: t.id, result };
        })
      );

      const output: Array<{
        id: string;
        status: 'completed' | 'error';
        result?: string;
        error?: string;
      }> = results.map((r, i) => {
        if (r.status === 'fulfilled') {
          return { id: r.value.id, status: 'completed' as const, result: r.value.result };
        }
        return { id: tasks[i]!.id, status: 'error' as const, error: String(r.reason) };
      });

      const completed = output.filter(o => o.status === 'completed').length;
      const failed = output.filter(o => o.status === 'error').length;

      log.info('Parallel subagents finished', {
        parentAgent: ctx.agentId,
        completed,
        failed,
        totalDurationMs: Date.now() - startTime,
      });

      return JSON.stringify({
        status: 'completed',
        summary: `${completed}/${tasks.length} subagents completed successfully${failed > 0 ? `, ${failed} failed` : ''}`,
        durationMs: Date.now() - startTime,
        results: output,
      });
    },
  };
}
