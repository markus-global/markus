import { createLogger } from '@markus/shared';

const log = createLogger('tool-hooks');

export interface ToolHookContext {
  agentId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  attempt: number;
  idempotencyKey?: string;
}

export interface BeforeToolResult {
  /** If false, tool execution is blocked */
  proceed: boolean;
  /** Reason for blocking */
  reason?: string;
  /** Modified arguments (if transformation is needed) */
  modifiedArgs?: Record<string, unknown>;
}

export interface AfterToolResult {
  /** If set, replaces the tool's original result */
  modifiedResult?: string;
}

export interface ToolHook {
  name: string;
  /** Called before tool execution. Return { proceed: false } to block. */
  before?(ctx: ToolHookContext): Promise<BeforeToolResult>;
  /** Called after tool execution with the result. */
  after?(ctx: ToolHookContext & { result: string; durationMs: number; success: boolean }): Promise<AfterToolResult | void>;
}

export class ToolHookRegistry {
  private hooks: ToolHook[] = [];
  private idempotencyCache = new Map<string, { result: string; timestamp: number }>();
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

  register(hook: ToolHook): void {
    this.hooks.push(hook);
    log.info(`Tool hook registered: ${hook.name}`);
  }

  unregister(name: string): void {
    this.hooks = this.hooks.filter(h => h.name !== name);
  }

  getHooks(): ToolHook[] {
    return [...this.hooks];
  }

  async runBefore(ctx: ToolHookContext): Promise<BeforeToolResult> {
    // Check idempotency cache first
    if (ctx.idempotencyKey) {
      const cached = this.idempotencyCache.get(ctx.idempotencyKey);
      if (cached && Date.now() - cached.timestamp < ToolHookRegistry.IDEMPOTENCY_TTL_MS) {
        log.debug('Idempotency cache hit', { key: ctx.idempotencyKey, tool: ctx.toolName });
        return { proceed: false, reason: `__idempotent__:${cached.result}` };
      }
    }

    let currentArgs = ctx.arguments;
    for (const hook of this.hooks) {
      if (!hook.before) continue;
      try {
        const result = await hook.before({ ...ctx, arguments: currentArgs });
        if (!result.proceed) {
          log.warn(`Tool hook "${hook.name}" blocked execution of ${ctx.toolName}`, { reason: result.reason });
          return result;
        }
        if (result.modifiedArgs) {
          currentArgs = result.modifiedArgs;
        }
      } catch (error) {
        log.error(`Tool hook "${hook.name}" before() threw`, { error: String(error) });
      }
    }
    return { proceed: true, modifiedArgs: currentArgs !== ctx.arguments ? currentArgs : undefined };
  }

  async runAfter(ctx: ToolHookContext & { result: string; durationMs: number; success: boolean }): Promise<string> {
    // Store in idempotency cache if key is provided
    if (ctx.idempotencyKey && ctx.success) {
      this.idempotencyCache.set(ctx.idempotencyKey, { result: ctx.result, timestamp: Date.now() });
      this.pruneIdempotencyCache();
    }

    let currentResult = ctx.result;
    for (const hook of this.hooks) {
      if (!hook.after) continue;
      try {
        const afterResult = await hook.after({ ...ctx, result: currentResult });
        if (afterResult?.modifiedResult !== undefined) {
          currentResult = afterResult.modifiedResult;
        }
      } catch (error) {
        log.error(`Tool hook "${hook.name}" after() threw`, { error: String(error) });
      }
    }
    return currentResult;
  }

  private pruneIdempotencyCache(): void {
    if (this.idempotencyCache.size < 100) return;
    const now = Date.now();
    for (const [key, entry] of this.idempotencyCache) {
      if (now - entry.timestamp > ToolHookRegistry.IDEMPOTENCY_TTL_MS) {
        this.idempotencyCache.delete(key);
      }
    }
  }
}

/** Built-in hook: audit logging for side-effect tools */
export const auditLogHook: ToolHook = {
  name: 'audit-log',
  async after(ctx) {
    const sideEffectTools = ['shell_execute', 'file_write', 'file_edit'];
    if (sideEffectTools.includes(ctx.toolName)) {
      log.info(`[audit] ${ctx.toolName}`, {
        agentId: ctx.agentId,
        args: JSON.stringify(ctx.arguments).slice(0, 300),
        success: ctx.success,
        durationMs: ctx.durationMs,
      });
    }
  },
};

/** Generate an idempotency key from tool name + arguments */
export function generateIdempotencyKey(toolName: string, args: Record<string, unknown>): string | undefined {
  const sideEffectTools = ['shell_execute', 'file_write', 'file_edit'];
  if (!sideEffectTools.includes(toolName)) return undefined;
  const argsStr = JSON.stringify(args, Object.keys(args).sort());
  let hash = 0;
  for (let i = 0; i < argsStr.length; i++) {
    hash = ((hash << 5) - hash + argsStr.charCodeAt(i)) | 0;
  }
  return `${toolName}:${hash.toString(36)}`;
}
