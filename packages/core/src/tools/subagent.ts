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
  SUBAGENT_DEFAULT_ITERATION_BUDGET,
  SUBAGENT_MAX_LLM_RETRIES,
  SUBAGENT_RETRY_BASE_MS,
  WORK_UNIT_REF,
} from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import type { ContextEngine } from '../context-engine.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isToolErrorResult } from './result.js';

const log = createLogger('subagent');

/**
 * C7-B — 委派产生的子 WU 句柄（父 WU 已知时立刻产生，禁止绕过唯一写者）。
 *
 * core 不认识 org-manager 的 `WorkUnitService`（依赖方向），只认这一个最小端口；
 * 端口未注入 ⇒ 子代理照常跑，只是「这条活没有身份」（可知的降级，不是隐藏的崩溃）。
 */
export interface DelegationWorkUnitHandle {
  id: string;
  ref: string;
  status: string;
  contextRef: string | null;
}

export interface DelegationWorkUnitPort {
  /** 按 ref 读回 WU（用于「这一轮跑在哪个会话」与父 WU 解析）。 */
  resolve(ref: string): DelegationWorkUnitHandle | null;
  /** 幂等建子 WU；`parentId` 来自当前回合的父 WU，没有就显式 null。 */
  ensureChild(seed: {
    ref: string;
    agentId: string;
    parentId: string | null;
    budget: number | null;
    contextRef: string | null;
  }): DelegationWorkUnitHandle | null;
  /**
   * 子 WU 收口：记 `used`（iteration 次数）+ 迁移状态。
   * 到线 → `paused_budget`（留痕在 `status_transitions`），正常结束 → `idle`。
   */
  settle(
    ref: string,
    opts: { used: number; status: 'idle' | 'paused_budget'; reason: string },
  ): void;
}

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
  /**
   * C7-B：委派即产生子 WU 的端口（由装配处注入；未注入 = 子代理没有 WU 身份）。
   * 与 `getProgressCallback` 同样的注入方向：core 不反向依赖 org-manager。
   */
  workUnits?: DelegationWorkUnitPort;
  /**
   * C7-B：本回合父 WU 的 ref（回合进行中才有；首轮/未接线为 null）。
   *
   * **必填而非可选**：`?` 会让「忘了接线」与「确实没有父 WU」在类型上无法区分，
   * 而两者后果不同（前者是装配缺陷，后者是 root 回合）。装配处没有父 WU 时
   * 显式写 `() => null`。
   *
   * 只读内存中由 `onFocusChanged` 设置的当前回合 ref —— **不得**用库查询实现
   * （库里没有「当前」这个概念，只有历史，按 agentId 反查得到的是错的那一条）。
   */
  turnWorkUnitRef: () => string | null;
}

/**
 * H6 — terminal status of a single subagent loop. A child is NEVER reported as a bare
 * success string: an exhausted budget or a hit iteration cap is surfaced explicitly.
 */
export type SubagentStopStatus = 'completed' | 'budget_exhausted' | 'max_iterations';

/**
 * H6 — structured result of one subagent loop. `output` is guaranteed non-empty so the
 * parent can always distinguish a truncated child from a successful one.
 */
export interface SubagentLoopResult {
  status: SubagentStopStatus;
  /** Never an empty string. When `status !== 'completed'` it carries an explicit
   *  "incomplete" note describing why the child stopped early. */
  output: string;
  /** Tool iterations actually executed by this child. */
  iterations: number;
  /** True when the child was stopped by the shared fan-out ceiling (`aggregateBudget`). */
  aggregateCeilingReached: boolean;
  /**
   * F1 — WHICH budget stopped this child, so a parent can tell "this child ran out of its
   * own rope" from "a sibling drained the shared fan-out breaker":
   *   'own'            → its own `iterationBudget`
   *   'aggregate'      → the shared `aggregateBudget` circuit breaker
   *   'max_iterations' → the legacy hard cap (`maxIterations` / `ctx.maxToolIterations`)
   *   null             → it completed normally
   */
  budgetHit: 'own' | 'aggregate' | 'max_iterations' | null;
  /**
   * F2 — distinct file paths this child changed through a file-writing tool
   * (`file_write` / `file_edit` / `apply_patch`, ignoring `dry_run`). A **best-effort hint, not
   * an audit**: a child can also change files by means that are not counted (shell redirection,
   * scripts, builds). Read a non-empty list as "it wrote these"; read an empty list as "no
   * file-tool write was recorded" — never as "nothing changed".
   */
  filesTouched: string[];
  /**
   * F3 — tool-call accounting. `writes` counts successful file-tool write calls — the same
   * best-effort scope and caveat as {@link filesTouched} (a hint, not proof that nothing else
   * changed).
   */
  toolCalls: { total: number; writes: number };
}

export interface SubagentLoopOptions {
  systemPrompt?: string;
  allowedTools?: string[];
  /** Hard cap on tool iterations for this child (legacy option). */
  maxIterations?: number;
  /**
   * H6: the child's OWN, INDEPENDENT iteration budget. Reaching it stops only this child
   * and yields `status: 'budget_exhausted'` — one child can never drain a sibling's quota.
   */
  iterationBudget?: number;
  /**
   * H6: aggregate circuit breaker shared across one `spawn_subagents` fan-out. It is a
   * breaker only — when exhausted the child stops with `aggregateCeilingReached: true`
   * and `status: 'budget_exhausted'`. Mutated in place so the caller can observe it.
   */
  aggregateBudget?: { remaining: number };
  /** @deprecated Legacy alias for {@link SubagentLoopOptions.aggregateBudget}. */
  sharedBudget?: { remaining: number };
  onProgress?: SubagentProgressCallback;
}

const isErrorResult = isToolErrorResult;

const BLOCKED_TOOLS = new Set([
  'spawn_subagent', 'spawn_subagents',
  'notify_user', 'request_user_input', 'request_user_approval', 'discover_tools',
  'schedule_wakeup', 'cancel_wakeup',
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

function stringPaths(v: unknown): string[] {
  return typeof v === 'string' && v.length > 0 ? [v] : [];
}

/**
 * F2 — the tools that mutate files, and how to read the path(s) they touched out of their
 * arguments. Schema-copied from `tools/file.ts` (`file_write` / `file_edit`) and
 * `tools/patch.ts` (`apply_patch`). An `apply_patch` with `dry_run: true` writes nothing and
 * is therefore ignored.
 */
const FILE_WRITE_TOOLS: Record<string, (args: Record<string, unknown>) => string[]> = {
  file_write: (args) => stringPaths(args['path'] ?? args['file'] ?? args['file_path'] ?? args['filePath']),
  file_edit: (args) => stringPaths(args['path'] ?? args['file'] ?? args['file_path'] ?? args['filePath']),
  apply_patch: (args) => {
    if (args['dry_run'] === true) return [];
    const patches = args['patches'];
    if (!Array.isArray(patches)) return [];
    return patches.flatMap((p) => stringPaths((p as Record<string, unknown> | null)?.['file']));
  },
};

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
 *
 * H6: returns a structured {@link SubagentLoopResult}. The child's iteration budget is
 * INDEPENDENT (`iterationBudget`); `aggregateBudget` is only an overall circuit breaker.
 * When either is hit the result is explicit (`status: 'budget_exhausted'`) and `output`
 * is never empty — a parent can always tell a truncated child from a successful one.
 */
export async function runSubagentLoop(
  ctx: SubagentContext,
  task: string,
  opts?: SubagentLoopOptions,
): Promise<SubagentLoopResult> {
  const hardCap = ctx.maxToolIterations ?? SUBAGENT_DEFAULT_ITERATION_BUDGET;
  const maxIterations = Math.min(opts?.maxIterations ?? hardCap, hardCap);
  /**
   * C7-B：这个孩子自己的迭代预算 —— **永远有限**，绝不与 sibling 共享。
   *
   * 6b 的 `Infinity` 默认是这一整类「零产物全灭」的根因：没有 per-child 绳子，
   * 唯一能停下来的就是共享断路器，于是断路器事实上变成了日程。现在缺省就是
   * `SUBAGENT_DEFAULT_ITERATION_BUDGET`，到线返回结构化 `budget_exhausted`。
   */
  const iterationBudget = opts?.iterationBudget ?? SUBAGENT_DEFAULT_ITERATION_BUDGET;
  /** Shared fan-out circuit breaker (legacy `sharedBudget` treated as the same thing). */
  const aggregateBudget = opts?.aggregateBudget ?? opts?.sharedBudget;
  const onProgress = opts?.onProgress;
  let status: SubagentStopStatus = 'completed';
  let aggregateCeilingReached = false;
  /** F1: which budget stopped this child. */
  let budgetHit: SubagentLoopResult['budgetHit'] = null;
  /** F2/F3: what the child actually touched, and how much of its work was writes. */
  const filesTouched = new Set<string>();
  let toolCallCount = 0;
  let writeCallCount = 0;

  const subagentId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const logEntries: SubagentLogEntry[] = [];

  const parentTools = ctx.getTools();
  const provider = ctx.getProvider();
  // Cold-start fix: same bounded, never-throwing readiness wait as the main turn
  // preflight. A subagent spawned on the very first turn must pack against real
  // Hub values rather than the fallback window. O(1) no-op once warm.
  await ctx.llmRouter.ensureMarkusCatalogLoaded?.({ timeoutMs: 3000 });
  const contextWindow = ctx.llmRouter.getModelContextWindow(provider);

  const toolMap = buildToolMap(parentTools, opts?.allowedTools);

  const llmTools: LLMTool[] = [...toolMap.values()].map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const systemContent = opts?.systemPrompt
    ?? 'You are a focused subagent spawned to handle a specific subtask. Your goal is to complete the assigned work thoroughly and return a clear, concise result.\n\nGuidelines:\n- Work with the information provided — do not ask follow-up questions\n- Stay within the scope of the assigned subtask — do not expand beyond what was asked\n- If you encounter an error, try an alternative approach before reporting failure\n- Verify your results before returning — check for correctness, completeness, and edge cases\n- Return structured output: what you did, what you found, and any caveats or limitations\n- Never include secrets, credentials, or system internals in your output';

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
    maxIterations,
    iterationBudget,
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
    // H6: aggregate circuit breaker — shared across the fan-out, checked first. Its
    // stop is explicit so the parent never mistakes it for a clean completion.
    if (aggregateBudget) {
      if (aggregateBudget.remaining <= 0) {
        aggregateCeilingReached = true;
        status = 'budget_exhausted';
        budgetHit = 'aggregate';
        log.warn('Subagent stopped: aggregate budget ceiling reached', {
          parentAgent: ctx.agentId, subagentId, iterations,
        });
        onProgress?.({ type: 'error', content: 'Aggregate subagent budget ceiling reached' });
        break;
      }
      aggregateBudget.remaining--;
    }

    // H6: the child's OWN iteration budget. Independent per child — reaching it stops
    // only this child and is reported as `budget_exhausted`, never as a silent success.
    if (iterationBudget !== undefined && iterations >= iterationBudget) {
      status = 'budget_exhausted';
      budgetHit = 'own';
      log.warn('Subagent stopped: own iteration budget exhausted', {
        parentAgent: ctx.agentId, subagentId, iterations, iterationBudget,
      });
      onProgress?.({ type: 'error', content: `Subagent iteration budget exhausted (${iterationBudget})` });
      break;
    }

    // Hard iteration cap (legacy `maxIterations` / ctx.maxToolIterations).
    if (iterations >= maxIterations) {
      status = 'max_iterations';
      budgetHit = 'max_iterations';
      log.warn('Subagent hit max iterations', { parentAgent: ctx.agentId, subagentId, iterations, maxIterations });
      onProgress?.({ type: 'error', content: `Subagent hit max iterations (${maxIterations})` });
      break;
    }

    iterations++;

    onProgress?.({
      type: 'iteration',
      content: `Iteration ${iterations}/${maxIterations}`,
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

        // F2/F3: count every tool call; record the paths a *successful* file-writing call
        // actually changed. An error result touches nothing, so it is not counted.
        toolCallCount++;
        const writePaths = FILE_WRITE_TOOLS[tc.name];
        if (writePaths && !isErrorResult(result)) {
          const paths = writePaths((tc.arguments ?? {}) as Record<string, unknown>);
          if (paths.length > 0) {
            writeCallCount++;
            for (const p of paths) filesTouched.add(p);
          }
        }

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
  let cleanResult = stripThinkTags(rawResult ?? '');

  // H6: make any early stop visible, and GUARANTEE a non-empty result. A parent must
  // never receive an empty string that looks like a successful child.
  if (status !== 'completed') {
    const reason = status === 'max_iterations'
      ? `reached its ${maxIterations}-iteration cap`
      : aggregateCeilingReached
        ? 'shared aggregate iteration budget exhausted'
        : `own iteration budget (${iterationBudget}) exhausted`;
    // F2/F3 (scoped 2026-10-09): this note is a *reminder to verify*, not an audit. A child can
    // change the workspace in ways we cannot enumerate (shell redirection, scripts, builds), so we
    // never assert a negative we cannot prove — we report what we saw and tell the parent to check.
    const wroteHint = filesTouched.size > 0
      ? ` Files written via file tools (may be half-applied): ${[...filesTouched].join(', ')}.`
      : '';
    const note =
      `[INCOMPLETE: subagent stopped early — ${reason} after ${iterations} iteration(s); ` +
      `${toolCallCount} tool call(s), ${writeCallCount} write(s).${wroteHint} ` +
      `Its result is incomplete — verify the workspace before trusting it (a subagent can also ` +
      `change files by means this notice does not track, e.g. shell).]`;
    cleanResult = cleanResult.trim().length > 0
      ? `${cleanResult.trimEnd()}\n\n${note}`
      : note;
  } else if (cleanResult.trim().length === 0) {
    // A genuine `end_turn` with no text still must not serialise to an empty string.
    cleanResult = '[Subagent completed without producing textual output.]';
  }

  logEntries.push({
    ts: new Date().toISOString(),
    role: 'assistant',
    content: cleanResult,
  });

  let logPath: string | undefined;
  if (ctx.dataDir) {
    logPath = persistSubagentLog(ctx.dataDir, subagentId, logEntries);
  }

  log.info('Subagent finished', {
    parentAgent: ctx.agentId,
    subagentId,
    status,
    iterations,
    aggregateCeilingReached,
    budgetHit,
    toolCalls: toolCallCount,
    writes: writeCallCount,
    filesTouched: [...filesTouched],
    resultLength: cleanResult.length,
    logPath,
  });

  onProgress?.({
    type: status === 'completed' ? 'completed' : 'error',
    content: status === 'completed'
      ? `Subagent completed in ${iterations} iterations`
      : `Subagent stopped early (${status}) after ${iterations} iterations`,
    metadata: { subagentId, status, iterations, aggregateCeilingReached, budgetHit, filesTouched: [...filesTouched], logPath, resultLength: cleanResult.length },
  });

  return {
    status,
    output: cleanResult,
    iterations,
    aggregateCeilingReached,
    budgetHit,
    filesTouched: [...filesTouched],
    toolCalls: { total: toolCallCount, writes: writeCallCount },
  };
}

/**
 * C7-B — 这个孩子自己的迭代预算（**永远有限**）。
 *
 * 缺省 = `SUBAGENT_DEFAULT_ITERATION_BUDGET`，不由共享池反向推出 —— 共享池已不再
 * 是日程（见 `limits.ts` 的 `SUBAGENT_MAX_AGGREGATE_ITERATIONS` 说明）。
 */
function resolveChildBudget(requested: unknown): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : SUBAGENT_DEFAULT_ITERATION_BUDGET;
}

/**
 * C7-B — 委派前的身份登记：一次委派 = 一个子 WU，父 WU 已知时立刻落 `parent_id`。
 *
 * 纪律：
 *   · 端口未注入 ⇒ 返回 null（没有台账），子代理照常跑；
 *   · 父 ref 只能来自 `turnWorkUnitRef()`（这一轮的真实身份）；没有就用
 *     `root:<agentId>` 显式表态 —— **不猜**「最近那条」（那是从时序推断结构）；
 *   · ref 只能由 `WORK_UNIT_REF.delegation` 生成（禁止第二套命名）。
 */
function beginDelegation(
  ctx: SubagentContext,
  childKey: string,
  budget: number,
): DelegationWorkUnitHandle | null {
  const port = ctx.workUnits;
  if (!port) return null;
  try {
    const parentRef = ctx.turnWorkUnitRef();
    const parent = parentRef ? port.resolve(parentRef) : null;
    return port.ensureChild({
      ref: WORK_UNIT_REF.delegation(parent?.ref ?? `root:${ctx.agentId}`, childKey),
      agentId: ctx.agentId,
      parentId: parent?.id ?? null,
      budget,
      contextRef: parent?.contextRef ?? null,
    });
  } catch (err) {
    log.warn('Delegation WorkUnit ensure failed (subagent still runs)', {
      childKey, error: String(err),
    });
    return null;
  }
}

/**
 * C7-B — 子 WU 收口：`used` = 实际 iteration 次数（唯一口径），到线进 `paused_budget`。
 *
 * `paused_budget` 与 `idle` 的差别就是「它是被预算停下的，还是干完了」——这个区别
 * 必须落在结构上（状态 + `status_transitions` 行），不能只写在输出文本里。
 * 观测设施不得成为业务故障点：异常在这里吞掉并留 warn。
 */
function settleDelegation(
  ctx: SubagentContext,
  handle: DelegationWorkUnitHandle | null,
  loop: SubagentLoopResult,
): void {
  const port = ctx.workUnits;
  if (!handle || !port) return;
  const stoppedByBudget = loop.budgetHit === 'own' || loop.budgetHit === 'aggregate';
  const reason = stoppedByBudget
    ? 'subagent_budget_exhausted'
    : loop.status === 'max_iterations'
      ? 'subagent_max_iterations'
      : 'subagent_completed';
  try {
    port.settle(handle.ref, {
      used: loop.iterations,
      status: stoppedByBudget ? 'paused_budget' : 'idle',
      reason,
    });
  } catch (err) {
    log.warn('Delegation WorkUnit settle failed (observation degraded)', {
      ref: handle.ref, error: String(err),
    });
  }
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
      'The subagent runs to completion and returns a STRUCTURED result: `status` ' +
      "('completed' | 'budget_exhausted' | 'max_iterations'), `budgetHit`, `filesTouched`, `toolCalls`. " +
      'A child that stops early is reported as incomplete — never as an empty success — and tells you ' +
      'to verify the workspace; `filesTouched` is a best-effort hint, not an exhaustive audit. ' +
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
          description: 'Hard cap on tool iterations for THIS child (per child — never shared with siblings). Prefer iteration_budget when you want a clean budget_exhausted status.',
        },
        iteration_budget: {
          type: 'number',
          description: 'Optional per-child iteration budget. When reached, the subagent returns an explicit budget_exhausted status (never an empty success).',
        },
      },
      required: ['task'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const task = args['task'] as string;
      if (!task) {
        return JSON.stringify({ status: 'error', error: 'task is required' });
      }
      // C7-B：先登记子 WU（父 WU 已知时立刻落 parent_id），再跑；跑完把 used 记账收口。
      const budget = resolveChildBudget(args['iteration_budget']);
      const childKey = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const child = beginDelegation(ctx, childKey, budget);
      try {
        const loop = await runSubagentLoop(ctx, task, {
          systemPrompt: args['system_prompt'] as string | undefined,
          allowedTools: args['allowed_tools'] as string[] | undefined,
          maxIterations: args['max_iterations'] as number | undefined,
          iterationBudget: budget,
          onProgress: ctx.getProgressCallback?.(),
        });
        settleDelegation(ctx, child, loop);
        // H6 + F1–F3: surface the child's real terminal status and an auditable schema
        // (status / which budget / what files / how much of the work was writes) verbatim.
        // `result` is never empty. C7-B adds the WorkUnit ref so the parent can query
        // the ledger (`work_status()` / `children(parentId)`) instead of guessing.
        return JSON.stringify({
          status: loop.status,
          result: loop.output,
          iterations: loop.iterations,
          budget,
          aggregateCeilingReached: loop.aggregateCeilingReached,
          budgetHit: loop.budgetHit,
          filesTouched: loop.filesTouched,
          toolCalls: loop.toolCalls,
          ...(child ? { workUnitRef: child.ref } : {}),
        });
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
      'BUDGETS: every child gets its own FINITE iteration budget (`iteration_budget`, else a default) — ' +
      'a budget is private to the child, so one child can never drain a sibling, and an exhausted child ' +
      'stops only itself. The stop is always explicit: ' +
      "`budgetHit` ('own' | 'aggregate' | 'max_iterations') plus `filesTouched`. " +
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
              iteration_budget: {
                type: 'number',
                description: 'Optional INDEPENDENT iteration budget for this subagent. Reaching it stops only this child and returns an explicit budget_exhausted status.',
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
        iteration_budget?: number;
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

      // C7-B：**每个孩子自己的预算**，不再预分配一个共享池。
      //
      // 6b 的写法是 `{ remaining: 100 }` 全体分食：一个孩子跑得多，sibling 就没绳子，
      // 于是「共享断路器」事实上变成了日程。现在每个孩子拿到有限的、彼此独立的
      // 预算（`iteration_budget` ?? 缺省），并各自登记一个子 WU；到线只停它自己，
      // 且交回结构化结果 (`budgetHit` / `filesTouched`) —— 不再 writes=0 全灭。
      const results = await Promise.allSettled(
        tasks.map(async (t) => {
          const perTaskProgress: SubagentProgressCallback | undefined = onProgress
            ? (event) => onProgress({
                ...event,
                content: `[${t.id}] ${event.content}`,
                metadata: { ...event.metadata, parallelTaskId: t.id },
              })
            : undefined;

          const budget = resolveChildBudget(t.iteration_budget);
          const child = beginDelegation(ctx, t.id, budget);
          try {
            const loop = await runSubagentLoop(ctx, t.task, {
              systemPrompt: sharedSystemPrompt,
              allowedTools: t.allowed_tools,
              maxIterations: t.max_iterations,
              iterationBudget: budget,
              onProgress: perTaskProgress,
            });
            settleDelegation(ctx, child, loop);
            return { id: t.id, loop, budget, workUnitRef: child?.ref ?? null };
          } catch (err) {
            // 子代理失败也要收口子 WU：否则它会永远停在 `running`，台账开始漂。”
            settleDelegation(ctx, child, {
              status: 'budget_exhausted',
              output: `[failed: ${String(err)}]`,
              iterations: 0,
              aggregateCeilingReached: false,
              budgetHit: null,
              filesTouched: [],
              toolCalls: { total: 0, writes: 0 },
            });
            throw err;
          }
        })
      );

      const output: Array<{
        id: string;
        status: SubagentStopStatus | 'error';
        result: string;
        iterations?: number;
        budget?: number;
        workUnitRef?: string | null;
        aggregateCeilingReached?: boolean;
        budgetHit?: 'own' | 'aggregate' | 'max_iterations' | null;
        filesTouched?: string[];
        toolCalls?: { total: number; writes: number };
        error?: string;
      }> = results.map((r, i) => {
        if (r.status === 'fulfilled') {
          const { id, loop, budget, workUnitRef } = r.value;
          // H6: `result` is NEVER empty — a child that produced nothing still surfaces
          // an explicit, actionable message instead of an empty success.
          const result = loop.output.trim().length > 0
            ? loop.output
            : `[INCOMPLETE: subagent "${id}" produced no output (status: ${loop.status}).]`;
          return {
            id,
            status: loop.status,
            result,
            iterations: loop.iterations,
            budget,
            workUnitRef,
            aggregateCeilingReached: loop.aggregateCeilingReached,
            budgetHit: loop.budgetHit,
            filesTouched: loop.filesTouched,
            toolCalls: loop.toolCalls,
          };
        }
        const reason = String(r.reason);
        return {
          id: tasks[i]!.id,
          status: 'error' as const,
          result: `[INCOMPLETE: subagent failed — ${reason}]`,
          error: reason,
        };
      });

      const completed = output.filter(o => o.status === 'completed').length;
      const stoppedEarly = output.filter(o => o.status === 'budget_exhausted' || o.status === 'max_iterations').length;
      const pausedBudget = output.filter(o => o.status === 'budget_exhausted').length;
      const failed = output.filter(o => o.status === 'error').length;
      const durationMs = Date.now() - startTime;

      log.info('Parallel subagents finished', {
        parentAgent: ctx.agentId,
        completed,
        stoppedEarly,
        pausedBudget,
        failed,
        totalDurationMs: durationMs,
      });

      onProgress?.({
        type: stoppedEarly > 0 || failed > 0 ? 'error' : 'completed',
        content: `${completed}/${tasks.length} subagents completed${stoppedEarly > 0 ? `, ${stoppedEarly} stopped early` : ''} (${durationMs}ms)`,
        metadata: { completed, stoppedEarly, pausedBudget, failed, durationMs },
      });

      // H6: make a partial fan-out legible at a glance.
      const summaryParts = [`${completed}/${tasks.length} subagents completed`];
      if (stoppedEarly > 0) summaryParts.push(`${stoppedEarly} stopped early (incomplete)`);
      if (failed > 0) summaryParts.push(`${failed} failed`);

      return JSON.stringify({
        status: 'completed',
        summary: summaryParts.join('; '),
        durationMs,
        results: output,
      });
    },
  };
}
