import { describe, it, expect } from 'vitest';
import type { ToolExecutionContext } from '@markus/shared';

/**
 * Backward compatibility tests for ToolExecutionContext.
 *
 * The ToolExecutionContext parameter is added as an OPTIONAL third argument
 * to AgentToolHandler.execute(). These tests verify that:
 * 1. Existing tool handlers work without the context parameter
 * 2. The context parameter is fully optional
 * 3. The onProgress callback is type-safe
 */
describe('ToolExecutionContext backward compatibility', () => {
  it('existing handler signature works without context', async () => {
    const handler = {
      name: 'legacy_tool',
      description: 'A tool written before ToolExecutionContext existed',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        return `processed: ${args.input}`;
      },
    };
    const result = await handler.execute({ input: 'test' });
    expect(result).toBe('processed: test');
  });

  it('handler can accept context as third parameter', async () => {
    let receivedTaskId: string | undefined;
    const handler = {
      name: 'context_aware_tool',
      description: 'A tool that uses ToolExecutionContext',
      inputSchema: { type: 'object', properties: {} },
      execute: async (
        _args: Record<string, unknown>,
        _onOutput?: (chunk: string) => void,
        context?: ToolExecutionContext,
      ): Promise<string> => {
        receivedTaskId = context?.taskId;
        return 'done';
      },
    };

    await handler.execute({}, undefined, { taskId: 'task-123' });
    expect(receivedTaskId).toBe('task-123');
  });

  it('handler works when context is undefined', async () => {
    const handler = {
      name: 'context_aware_tool',
      description: 'Handles missing context gracefully',
      inputSchema: { type: 'object', properties: {} },
      execute: async (
        _args: Record<string, unknown>,
        _onOutput?: (chunk: string) => void,
        context?: ToolExecutionContext,
      ): Promise<string> => {
        context?.onProgress?.({
          type: 'progress',
          content: 'test',
          timestamp: new Date().toISOString(),
        });
        return 'done';
      },
    };

    const result = await handler.execute({});
    expect(result).toBe('done');
  });

  it('onProgress callback receives events without error', async () => {
    const events: Array<{ type: string; content: string }> = [];
    const context: ToolExecutionContext = {
      taskId: 'task-456',
      sessionId: 'session-789',
      onProgress: (event) => {
        events.push({ type: event.type, content: event.content });
      },
    };

    context.onProgress!({
      type: 'progress',
      content: 'Starting work...',
      timestamp: '2026-01-01T00:00:00Z',
    });
    context.onProgress!({
      type: 'file_edit',
      content: 'Modified src/index.ts',
      metadata: { path: 'src/index.ts' },
      timestamp: '2026-01-01T00:01:00Z',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'progress', content: 'Starting work...' });
    expect(events[1]).toEqual({ type: 'file_edit', content: 'Modified src/index.ts' });
  });

  it('empty ToolExecutionContext is valid', () => {
    const ctx: ToolExecutionContext = {};
    expect(ctx.taskId).toBeUndefined();
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.onProgress).toBeUndefined();
  });
});
