import {
  ToolHookRegistry,
  generateIdempotencyKey,
  auditLogHook,
} from '../src/tool-hooks.js';

const baseCtx = {
  agentId: 'agent-1',
  toolName: 'file_read',
  arguments: { path: '/tmp/test.txt' },
  attempt: 1,
};

describe('ToolHookRegistry', () => {
  it('registers and returns hooks', () => {
    const registry = new ToolHookRegistry();
    const hook = { name: 'test-hook' };
    registry.register(hook);
    expect(registry.getHooks()).toHaveLength(1);
    expect(registry.getHooks()[0].name).toBe('test-hook');
  });

  it('unregisters hooks by name', () => {
    const registry = new ToolHookRegistry();
    registry.register({ name: 'hook-a' });
    registry.register({ name: 'hook-b' });
    registry.unregister('hook-a');
    expect(registry.getHooks()).toHaveLength(1);
    expect(registry.getHooks()[0].name).toBe('hook-b');
  });

  it('runs before hooks and allows execution', async () => {
    const registry = new ToolHookRegistry();
    registry.register({
      name: 'modifier',
      async before(ctx) {
        return { proceed: true, modifiedArgs: { ...ctx.arguments, extra: true } };
      },
    });

    const result = await registry.runBefore(baseCtx);
    expect(result.proceed).toBe(true);
    expect(result.modifiedArgs).toEqual({ path: '/tmp/test.txt', extra: true });
  });

  it('blocks execution when before hook returns proceed false', async () => {
    const registry = new ToolHookRegistry();
    registry.register({
      name: 'blocker',
      async before() {
        return { proceed: false, reason: 'not allowed' };
      },
    });

    const result = await registry.runBefore(baseCtx);
    expect(result.proceed).toBe(false);
    expect(result.reason).toBe('not allowed');
  });

  it('runs after hooks and modifies result', async () => {
    const registry = new ToolHookRegistry();
    registry.register({
      name: 'redactor',
      async after() {
        return { modifiedResult: 'redacted output' };
      },
    });

    const result = await registry.runAfter({
      ...baseCtx,
      result: 'secret output',
      durationMs: 50,
      success: true,
    });
    expect(result).toBe('redacted output');
  });

  it('returns cached result for idempotency key hit', async () => {
    const registry = new ToolHookRegistry();
    const key = 'shell_execute:abc123';
    const ctx = {
      ...baseCtx,
      toolName: 'shell_execute',
      idempotencyKey: key,
    };

    await registry.runAfter({
      ...ctx,
      result: 'cached output',
      durationMs: 10,
      success: true,
    });

    const beforeResult = await registry.runBefore(ctx);
    expect(beforeResult.proceed).toBe(false);
    expect(beforeResult.reason).toBe('__idempotent__:cached output');
  });

  it('continues when before hook throws', async () => {
    const registry = new ToolHookRegistry();
    registry.register({
      name: 'broken',
      async before() {
        throw new Error('fail');
      },
    });

    const result = await registry.runBefore(baseCtx);
    expect(result.proceed).toBe(true);
  });
});

describe('generateIdempotencyKey', () => {
  it('returns undefined for non side-effect tools', () => {
    expect(generateIdempotencyKey('file_read', { path: '/a' })).toBeUndefined();
    expect(generateIdempotencyKey('grep_search', { query: 'foo' })).toBeUndefined();
  });

  it('returns stable key for side-effect tools', () => {
    const args = { command: 'echo hi' };
    const key1 = generateIdempotencyKey('shell_execute', args);
    const key2 = generateIdempotencyKey('shell_execute', args);
    expect(key1).toMatch(/^shell_execute:/);
    expect(key1).toBe(key2);
  });

  it('produces different keys for different arguments', () => {
    const key1 = generateIdempotencyKey('file_write', { path: '/a', content: 'x' });
    const key2 = generateIdempotencyKey('file_write', { path: '/b', content: 'x' });
    expect(key1).not.toBe(key2);
  });

  it('generates keys for file_edit', () => {
    expect(generateIdempotencyKey('file_edit', { path: '/a' })).toMatch(/^file_edit:/);
  });
});

describe('auditLogHook', () => {
  it('has after handler for side-effect tools', () => {
    expect(auditLogHook.name).toBe('audit-log');
    expect(auditLogHook.after).toBeDefined();
  });

  it('runs after without error for side-effect tools', async () => {
    await expect(
      auditLogHook.after!({
        agentId: 'agent-1',
        toolName: 'shell_execute',
        arguments: { command: 'ls' },
        attempt: 1,
        result: 'ok',
        durationMs: 100,
        success: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('runs after without error for non side-effect tools', async () => {
    await expect(
      auditLogHook.after!({
        ...baseCtx,
        result: 'content',
        durationMs: 10,
        success: true,
      }),
    ).resolves.toBeUndefined();
  });
});
