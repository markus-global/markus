import {
  createLogger,
  type LLMMessage,
  type LLMTool,
  SUBAGENT_TASK_PREVIEW_CHARS,
  SUBAGENT_THINKING_PREVIEW_CHARS,
  SUBAGENT_RESULT_PREVIEW_CHARS,
  SUBAGENT_LOG_ENTRY_CHARS,
  SUBAGENT_ERROR_PREVIEW_CHARS,
  SUBAGENT_MAX_PARALLEL,
  SUBAGENT_MAX_LLM_RETRIES,
  SUBAGENT_RETRY_BASE_MS,
} from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import type { ContextEngine } from '../context-engine.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const log = createLogger('subagent');

const DEFAULT_MAX_SUBAGENT_ITERATIONS = Infinity;

/**
 * Progress callback for subagent execution.
 * Emitted for each significant step so the caller can relay to the frontend.
 */
export type SubagentProgressCallback = (event: {
  type: 'started' | 'tool_start' | 'tool_end' | 'thinking' | 'iteration' | 'completed' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}) => void;

export interface SubagentContext {
  llmRouter: LLMRouter;
  contextEngine: ContextEngine;
  getTools: () => Map<string, AgentToolHandler>;
  getProvider: () => string | undefined;
  agentId: string;
  offloadLargeResult: (toolName: string, result: string) => string;
  maxToolIterations?: number;
  /** Directory to persist subagent logs (e.g. agent's dataDir) */
  dataDir?: string;
  /** Retrieve the progress callback from the current execution context (e.g. via ALS) */
  getProgressCallback?: () => SubagentProgressCallback | undefined;
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
  'notify_user', 'request_user_approval', 'discover_tools',
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
 * Strip `<think>...</think>` blocks leaked by reasoning models (DeepSeek, Qwen, etc.).
 * These are internal chain-of-thought and should not appear in tool results or final output.
 */
function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*\n/, '');
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) return true;
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (msg.includes('server_error') || msg.includes('internal server error')) return true;
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('fetch failed')) return true;
  for (const code of RETRYABLE_STATUS_CODES) {
    if (msg.includes(`${code}`)) return true;
  }
  return false;
}

async function llmCallWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= SUBAGENT_MAX_LLM_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt >= SUBAGENT_MAX_LLM_RETRIES) {
        throw err;
      }
      const delay = SUBAGENT_RETRY_BASE_MS * Math.pow(2, attempt);
      log.warn(`${label}: retryable error, attempt ${attempt + 1}/${SUBAGENT_MAX_LLM_RETRIES + 1}`, {
        error: String(err).slice(0, SUBAGENT_ERROR_PREVIEW_CHARS),
        delay,
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

interface SubagentLogEntry {
  ts: string;
  role: string;
  content?: string;
  toolCalls?: Array<{ name: string; arguments?: unknown }>;
  toolCallId?: string;
  toolName?: string;
}

function persistSubagentLog(dataDir: string, subagentId: string, entries: SubagentLogEntry[]): string | undefined {
  try {
    const logsDir = join(dataDir, 'subagent-logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    const filePath = join(logsDir, `${subagentId}.jsonl`);
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(filePath, content);
    log.debug('Subagent log persisted', { path: filePath, entries: entries.length });
    return filePath;
  } catch (err) {
    log.warn('Failed to persist subagent log', { error: String(err) });
    return undefined;
  }
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
    onProgress?: SubagentProgressCallback;
  },
): Promise<string> {
  const hardCap = ctx.maxToolIterations ?? DEFAULT_MAX_SUBAGENT_ITERATIONS;
  const maxIter = Math.min(opts?.maxIterations ?? hardCap, hardCap);
  const onProgress = opts?.onProgress;

  const subagentId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const logEntries: SubagentLogEntry[] = [];

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

  logEntries.push({ ts: new Date().toISOString(), role: 'system', content: systemContent });
  logEntries.push({ ts: new Date().toISOString(), role: 'user', content: task });

  log.info('Subagent started', {
    parentAgent: ctx.agentId,
    subagentId,
    taskLength: task.length,
    toolCount: toolMap.size,
    maxIterations: maxIter,
  });

  onProgress?.({
    type: 'started',
    content: `Subagent ${subagentId} started`,
    metadata: { subagentId, toolCount: toolMap.size, taskPreview: task.slice(0, SUBAGENT_TASK_PREVIEW_CHARS) },
  });

  let response = await llmCallWithRetry(
    () => ctx.llmRouter.chat({
      messages,
      tools: llmTools.length > 0 ? llmTools : undefined,
      metadata: { agentId: ctx.agentId, sessionId: subagentId },
    }, provider),
    `subagent-${subagentId}-init`,
  );

  let iterations = 0;

  while (
    (response.finishReason === 'tool_use' && response.toolCalls?.length) ||
    response.finishReason === 'max_tokens'
  ) {
    if (++iterations > maxIter) {
      log.warn('Subagent hit max iterations', { parentAgent: ctx.agentId, subagentId, iterations });
      onProgress?.({ type: 'error', content: `Subagent hit max iterations (${maxIter})` });
      break;
    }

    onProgress?.({
      type: 'iteration',
      content: `Iteration ${iterations}/${maxIter}`,
      metadata: { iteration: iterations, finishReason: response.finishReason },
    });

    if (response.finishReason === 'max_tokens' && !response.toolCalls?.length) {
      messages.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
      logEntries.push({ ts: new Date().toISOString(), role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: '[Continue from where you left off. Do not repeat what you already said.]',
      });
    } else {
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
        reasoningContent: response.reasoningContent,
      });
      logEntries.push({
        ts: new Date().toISOString(),
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls?.map(tc => ({ name: tc.name, arguments: tc.arguments })),
      });

      if (response.content) {
        onProgress?.({
          type: 'thinking',
          content: stripThinkTags(response.content).slice(0, SUBAGENT_THINKING_PREVIEW_CHARS),
        });
      }

      for (const tc of response.toolCalls!) {
        const handler = toolMap.get(tc.name);
        let result: string;

        onProgress?.({
          type: 'tool_start',
          content: tc.name,
          metadata: { toolCallId: tc.id, arguments: tc.arguments },
        });

        const toolStart = Date.now();
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
        const toolDuration = Date.now() - toolStart;

        onProgress?.({
          type: 'tool_end',
          content: tc.name,
          metadata: {
            toolCallId: tc.id,
            durationMs: toolDuration,
            success: !isErrorResult(result),
            resultPreview: result.slice(0, SUBAGENT_RESULT_PREVIEW_CHARS),
          },
        });

        logEntries.push({
          ts: new Date().toISOString(),
          role: 'tool',
          content: result.slice(0, SUBAGENT_LOG_ENTRY_CHARS),
          toolCallId: tc.id,
          toolName: tc.name,
        });

        messages.push({ role: 'tool', content: result, toolCallId: tc.id });
      }
    }

    messages = ctx.contextEngine.shrinkMessages(messages, contextWindow);

    response = await llmCallWithRetry(
      () => ctx.llmRouter.chat({
        messages,
        tools: llmTools.length > 0 ? llmTools : undefined,
        metadata: { agentId: ctx.agentId, sessionId: subagentId },
      }, provider),
      `subagent-${subagentId}-iter${iterations}`,
    );
  }

  const rawResult = response.content;
  const cleanResult = stripThinkTags(rawResult);

  logEntries.push({
    ts: new Date().toISOString(),
    role: 'assistant',
    content: cleanResult,
  });

  let logPath: string | undefined;
  if (ctx.dataDir) {
    logPath = persistSubagentLog(ctx.dataDir, subagentId, logEntries);
  }

  log.info('Subagent completed', {
    parentAgent: ctx.agentId,
    subagentId,
    iterations,
    resultLength: cleanResult.length,
    logPath,
  });

  onProgress?.({
    type: 'completed',
    content: `Subagent completed in ${iterations} iterations`,
    metadata: { subagentId, iterations, logPath, resultLength: cleanResult.length },
  });

  return cleanResult;
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
          onProgress: ctx.getProgressCallback?.(),
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
 * Runs multiple subagent loops concurrently via Promise.allSettled.
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
      const onProgress = ctx.getProgressCallback?.();
      const tasks = args['tasks'] as Array<{
        id: string;
        task: string;
        allowed_tools?: string[];
        max_iterations?: number;
      }>;
      if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
        return JSON.stringify({ status: 'error', error: 'tasks array is required and must not be empty' });
      }

      if (tasks.length > SUBAGENT_MAX_PARALLEL) {
        return JSON.stringify({
          status: 'error',
          error: `Too many parallel subagents (${tasks.length}). Maximum is ${SUBAGENT_MAX_PARALLEL}.`,
        });
      }

      const sharedSystemPrompt = args['system_prompt'] as string | undefined;

      log.info('Spawning parallel subagents', {
        parentAgent: ctx.agentId,
        count: tasks.length,
        taskIds: tasks.map(t => t.id),
      });

      onProgress?.({
        type: 'started',
        content: `Spawning ${tasks.length} parallel subagents`,
        metadata: { taskIds: tasks.map(t => t.id) },
      });

      const startTime = Date.now();

      const results = await Promise.allSettled(
        tasks.map(async (t) => {
          const perTaskProgress: SubagentProgressCallback | undefined = onProgress
            ? (event) => onProgress({
                ...event,
                content: `[${t.id}] ${event.content}`,
                metadata: { ...event.metadata, parallelTaskId: t.id },
              })
            : undefined;

          const result = await runSubagentLoop(ctx, t.task, {
            systemPrompt: sharedSystemPrompt,
            allowedTools: t.allowed_tools,
            maxIterations: t.max_iterations,
            onProgress: perTaskProgress,
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
      const durationMs = Date.now() - startTime;

      log.info('Parallel subagents finished', {
        parentAgent: ctx.agentId,
        completed,
        failed,
        totalDurationMs: durationMs,
      });

      onProgress?.({
        type: 'completed',
        content: `${completed}/${tasks.length} subagents completed (${durationMs}ms)`,
        metadata: { completed, failed, durationMs },
      });

      return JSON.stringify({
        status: 'completed',
        summary: `${completed}/${tasks.length} subagents completed successfully${failed > 0 ? `, ${failed} failed` : ''}`,
        durationMs,
        results: output,
      });
    },
  };
}
