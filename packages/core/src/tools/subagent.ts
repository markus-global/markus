import { createLogger, type LLMMessage, type LLMTool, type LLMToolCall } from '@markus/shared';
import type { AgentToolHandler, ToolOutputCallback } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import type { ContextEngine } from '../context-engine.js';

const log = createLogger('subagent');

const DEFAULT_MAX_SUBAGENT_ITERATIONS = 200;

export interface SubagentContext {
  /** Parent agent's LLM router for model calls */
  llmRouter: LLMRouter;
  /** Parent agent's context engine for message shrinking */
  contextEngine: ContextEngine;
  /** All tools available to the parent agent (subagent inherits these) */
  getTools: () => Map<string, AgentToolHandler>;
  /** LLM provider name (undefined = auto-select) */
  getProvider: () => string | undefined;
  /** Agent ID for metadata */
  agentId: string;
  /** Offload large results to filesystem */
  offloadLargeResult: (toolName: string, result: string) => string;
  /** Configurable max tool iterations (from system config) */
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

/**
 * Run a lightweight subagent loop: independent messages[], parent's tools, sync return.
 *
 * This mirrors Claude Code's subagent pattern (learn-claude-code s04):
 * - Fresh messages[] per child — clean context, no pollution of parent conversation
 * - Inherits parent tools — no separate registration needed
 * - Synchronous return — result flows back as tool_result to parent
 */
async function runSubagentLoop(
  ctx: SubagentContext,
  task: string,
  opts: {
    systemPrompt?: string;
    allowedTools?: string[];
    maxIterations?: number;
  },
): Promise<string> {
  const hardCap = ctx.maxToolIterations ?? DEFAULT_MAX_SUBAGENT_ITERATIONS;
  const maxIter = Math.min(opts.maxIterations ?? hardCap, hardCap);

  const parentTools = ctx.getTools();
  const provider = ctx.getProvider();
  const contextWindow = ctx.llmRouter.getModelContextWindow(provider);

  // Build tool subset: either filtered or full parent set (excluding spawn_subagent to prevent recursion)
  const toolMap = new Map<string, AgentToolHandler>();
  const BLOCKED_TOOLS = new Set(['spawn_subagent', 'send_user_message', 'discover_tools']);

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    for (const name of opts.allowedTools) {
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

  const llmTools: LLMTool[] = [...toolMap.values()].map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const systemContent = opts.systemPrompt
    ?? 'You are a focused subagent spawned to handle a specific subtask. Complete the task thoroughly and return a clear, concise result. Do not ask follow-up questions — work with what you have.';

  // Independent messages array — the core of subagent isolation
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

      // Execute tool calls sequentially (safer for subagent focused tasks)
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

    // Shrink context if needed before next LLM call
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
 * Creates the spawn_subagent tool.
 * The tool runs a lightweight agent loop with an independent context window.
 */
export function createSubagentTool(ctx: SubagentContext): AgentToolHandler {
  return {
    name: 'spawn_subagent',
    description:
      'Spawn a lightweight subagent with a clean, independent context to handle a focused subtask. ' +
      'The subagent inherits your tools but gets its own message history — it will not pollute your conversation. ' +
      'Use this to break down complex tasks: deep code analysis, research, file refactoring, test generation, etc. ' +
      'The subagent runs to completion and returns its final result to you.',
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
          description: 'Optional subset of tool names the subagent can use. If omitted, it inherits all parent tools (except spawn_subagent to prevent recursion).',
        },
        max_iterations: {
          type: 'number',
          description: `Max tool iterations (default and hard cap come from system config). Lower this for quick tasks.`,
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

        return JSON.stringify({
          status: 'completed',
          result,
        });
      } catch (err) {
        log.error('Subagent execution failed', { error: String(err) });
        return JSON.stringify({
          status: 'error',
          error: `Subagent failed: ${String(err)}`,
        });
      }
    },
  };
}
