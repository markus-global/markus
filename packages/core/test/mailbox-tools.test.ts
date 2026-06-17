import { describe, it, expect, vi } from 'vitest';
import { createMailboxTools, type MailboxToolContext } from '../src/tools/mailbox-tools.js';
import type { AgentMindState } from '@markus/shared';

function createMockMindState(overrides: Partial<AgentMindState> = {}): AgentMindState {
  return {
    mailboxDepth: 2,
    currentFocus: {
      type: 'task',
      label: 'Implement feature',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    },
    queuedItems: [
      { id: 'item-1', sourceType: 'task', priority: 2, summary: 'Fix bug', queuedAt: new Date().toISOString() },
      { id: 'item-2', sourceType: 'notification', priority: 3, summary: 'Review PR', queuedAt: new Date().toISOString() },
    ],
    recentDecisions: [
      { decisionType: 'prioritize', reasoning: 'User asked for urgent fix' },
    ],
    ...overrides,
  } as AgentMindState;
}

function createContext(overrides: Partial<MailboxToolContext> = {}): MailboxToolContext {
  return {
    agentId: 'agt_test',
    getMindState: vi.fn(() => createMockMindState()),
    deferItem: vi.fn(() => true),
    dropItem: vi.fn(() => true),
    prioritizeItem: vi.fn(() => true),
    updateWorkingMemory: vi.fn(() => ({ status: 'updated', key: 'test' })),
    clearWorkingMemory: vi.fn(() => ({ status: 'cleared', cleared: 1 })),
    getWorkingMemorySnapshot: vi.fn(() => []),
    ...overrides,
  };
}

describe('createMailboxTools', () => {
  it('returns expected tools', () => {
    const tools = createMailboxTools(createContext());
    expect(tools.map(t => t.name)).toEqual([
      'check_mailbox',
      'update_working_memory',
      'clear_working_memory',
      'defer_mailbox_item',
      'drop_mailbox_item',
      'prioritize_mailbox_item',
    ]);
  });

  describe('check_mailbox', () => {
    it('returns mailbox queue snapshot', async () => {
      const ctx = createContext();
      const tool = createMailboxTools(ctx).find(t => t.name === 'check_mailbox')!;
      const result = JSON.parse(await tool.execute({}));
      expect(result.status).toBe('ok');
      expect(result.queueDepth).toBe(2);
      expect(result.currentFocus.label).toBe('Implement feature');
      expect(result.items).toHaveLength(2);
      expect(result.recentDecisions).toHaveLength(1);
    });
  });

  describe('defer_mailbox_item', () => {
    it('defers item with reason', async () => {
      const deferItem = vi.fn(() => true);
      const ctx = createContext({ deferItem });
      const tool = createMailboxTools(ctx).find(t => t.name === 'defer_mailbox_item')!;
      const result = JSON.parse(await tool.execute({
        item_id: 'item-1',
        reason: 'Waiting for dependency',
      }));
      expect(result.status).toBe('deferred');
      expect(result.item_id).toBe('item-1');
      expect(deferItem).toHaveBeenCalledWith('item-1', 'Waiting for dependency', undefined);
    });

    it('passes defer_minutes as milliseconds', async () => {
      const deferItem = vi.fn(() => true);
      const ctx = createContext({ deferItem });
      const tool = createMailboxTools(ctx).find(t => t.name === 'defer_mailbox_item')!;
      await tool.execute({ item_id: 'item-1', reason: 'Later', defer_minutes: 30 });
      expect(deferItem).toHaveBeenCalledWith('item-1', 'Later', 30 * 60_000);
    });

    it('returns error when defer fails', async () => {
      const ctx = createContext({ deferItem: vi.fn(() => false) });
      const tool = createMailboxTools(ctx).find(t => t.name === 'defer_mailbox_item')!;
      const result = JSON.parse(await tool.execute({ item_id: 'missing', reason: 'x' }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('protected human_chat');
    });

    it('requires item_id and reason', async () => {
      const tool = createMailboxTools(createContext()).find(t => t.name === 'defer_mailbox_item')!;
      const result = JSON.parse(await tool.execute({ item_id: 'item-1' }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('required');
    });
  });

  describe('drop_mailbox_item', () => {
    it('drops item with reason', async () => {
      const dropItem = vi.fn(() => true);
      const ctx = createContext({ dropItem });
      const tool = createMailboxTools(ctx).find(t => t.name === 'drop_mailbox_item')!;
      const result = JSON.parse(await tool.execute({
        item_id: 'item-2',
        reason: 'Stale notification',
      }));
      expect(result.status).toBe('dropped');
      expect(dropItem).toHaveBeenCalledWith('item-2', 'Stale notification');
    });

    it('returns error when drop fails', async () => {
      const ctx = createContext({ dropItem: vi.fn(() => false) });
      const tool = createMailboxTools(ctx).find(t => t.name === 'drop_mailbox_item')!;
      const result = JSON.parse(await tool.execute({ item_id: 'x', reason: 'y' }));
      expect(result.status).toBe('error');
    });
  });

  describe('prioritize_mailbox_item', () => {
    it('reprioritizes item', async () => {
      const prioritizeItem = vi.fn(() => true);
      const ctx = createContext({ prioritizeItem });
      const tool = createMailboxTools(ctx).find(t => t.name === 'prioritize_mailbox_item')!;
      const result = JSON.parse(await tool.execute({ item_id: 'item-1', priority: 0 }));
      expect(result.status).toBe('reprioritized');
      expect(result.priority).toBe(0);
      expect(prioritizeItem).toHaveBeenCalledWith('item-1', 0);
    });

    it('rounds priority to integer', async () => {
      const prioritizeItem = vi.fn(() => true);
      const ctx = createContext({ prioritizeItem });
      const tool = createMailboxTools(ctx).find(t => t.name === 'prioritize_mailbox_item')!;
      await tool.execute({ item_id: 'item-1', priority: 1.7 });
      expect(prioritizeItem).toHaveBeenCalledWith('item-1', 2);
    });

    it('rejects invalid priority values', async () => {
      const tool = createMailboxTools(createContext()).find(t => t.name === 'prioritize_mailbox_item')!;
      const tooHigh = JSON.parse(await tool.execute({ item_id: 'item-1', priority: 5 }));
      expect(tooHigh.status).toBe('error');
      expect(tooHigh.error).toContain('between 0 and 4');

      const notNumber = JSON.parse(await tool.execute({ item_id: 'item-1', priority: 'high' as unknown as number }));
      expect(notNumber.status).toBe('error');
    });

    it('returns error when prioritize fails', async () => {
      const ctx = createContext({ prioritizeItem: vi.fn(() => false) });
      const tool = createMailboxTools(ctx).find(t => t.name === 'prioritize_mailbox_item')!;
      const result = JSON.parse(await tool.execute({ item_id: 'item-1', priority: 1 }));
      expect(result.status).toBe('error');
    });
  });

  describe('working memory tools', () => {
    it('update_working_memory validates inputs', async () => {
      const tool = createMailboxTools(createContext()).find(t => t.name === 'update_working_memory')!;
      const missing = JSON.parse(await tool.execute({ key: 'k' }));
      expect(missing.status).toBe('error');

      const ctx = createContext();
      const ok = JSON.parse(await tool.execute({ key: 'ctx', content: 'data' }));
      expect(ok.status).toBe('updated');
    });

    it('clear_working_memory clears all when all=true', async () => {
      const clearWorkingMemory = vi.fn(() => ({ status: 'cleared', cleared: 3 }));
      const ctx = createContext({ clearWorkingMemory });
      const tool = createMailboxTools(ctx).find(t => t.name === 'clear_working_memory')!;
      const result = JSON.parse(await tool.execute({ all: true }));
      expect(result.cleared).toBe(3);
      expect(clearWorkingMemory).toHaveBeenCalledWith();
    });
  });
});
