import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerAgentCommands } from '../src/commands/agent.js';
import * as apiClient from '../src/api-client.js';

const chatAnswerQueue: string[] = [];
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (ans: string) => void) => cb(chatAnswerQueue.shift() ?? 'quit'),
    close: vi.fn(),
  }),
}));

describe('agent command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet = vi.fn();
    mockPost = vi.fn();
    vi.spyOn(apiClient, 'createClient').mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as unknown as apiClient.ApiClient);
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function runAgent(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerAgentCommands(program);
    return program.parseAsync(['node', 'markus', 'agent', ...args]);
  }

  it('list fetches agents and prints table', async () => {
    mockGet.mockResolvedValue({
      agents: [{ id: 'a1', name: 'Bot', role: 'dev', status: 'idle', agentRole: 'worker' }],
    });
    await runAgent(['list']);
    expect(mockGet).toHaveBeenCalledWith('/agents');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Agents');
    expect(output).toContain('a1');
  });

  it('get fetches agent details by id', async () => {
    mockGet.mockResolvedValue({ id: 'a1', name: 'Secretary', role: 'assistant' });
    await runAgent(['get', 'a1']);
    expect(mockGet).toHaveBeenCalledWith('/agents/a1');
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Secretary');
  });

  it('message sends text to agent', async () => {
    mockPost.mockResolvedValue({ reply: 'Hello back' });
    await runAgent(['message', 'a1', '-t', 'Hi there']);
    expect(mockPost).toHaveBeenCalledWith('/agents/a1/message', { text: 'Hi there' });
    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Hello back');
  });

  it('message includes optional sender and session', async () => {
    mockPost.mockResolvedValue({ reply: 'ok' });
    await runAgent(['message', 'a1', '-t', 'Hi', '--sender', 'user1', '--session', 'sess1']);
    expect(mockPost).toHaveBeenCalledWith('/agents/a1/message', {
      text: 'Hi',
      senderId: 'user1',
      sessionId: 'sess1',
    });
  });

  it('chat exits when user types quit', async () => {
    chatAnswerQueue.length = 0;
    chatAnswerQueue.push('quit');

    mockGet.mockResolvedValue({ id: 'a1', name: 'Secretary' });
    await runAgent(['chat', 'a1']);
    await new Promise(r => setTimeout(r, 20));

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Secretary');
    expect(mockGet).toHaveBeenCalledWith('/agents/a1');
  });
});
