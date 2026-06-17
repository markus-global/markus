import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockMkdirSync = vi.fn();
const mockAppendFileSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
  };
});

describe('LLMLogger', () => {
  const savedEnv = process.env.MARKUS_LLM_LOG;

  beforeEach(() => {
    vi.resetModules();
    mockMkdirSync.mockReset();
    mockAppendFileSync.mockReset();
    mockMkdirSync.mockImplementation(() => undefined);
    delete process.env.MARKUS_LLM_LOG;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MARKUS_LLM_LOG;
    else process.env.MARKUS_LLM_LOG = savedEnv;
  });

  async function loadLogger(logDir?: string) {
    const { LLMLogger } = await import('../src/llm/llm-logger.js');
    return new LLMLogger(logDir);
  }

  it('creates log directory on construction', async () => {
    await loadLogger('/tmp/test-llm-logs');
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-llm-logs', { recursive: true });
  });

  it('writes JSONL entry to dated file', async () => {
    const logger = await loadLogger('/tmp/test-llm-logs');
    const entry = {
      timestamp: '2026-06-16T12:00:00.000Z',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      responseContent: 'hi',
      inputTokens: 5,
      outputTokens: 3,
      durationMs: 100,
      finishReason: 'end_turn',
    };

    logger.log(entry);

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [filePath, line] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(filePath).toMatch(/\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(JSON.parse(line.trim())).toEqual(entry);
  });

  it('does not write when MARKUS_LLM_LOG is false', async () => {
    process.env.MARKUS_LLM_LOG = 'false';
    const logger = await loadLogger('/tmp/test-llm-logs');
    logger.log({
      timestamp: new Date().toISOString(),
      provider: 'openai',
      model: 'gpt-4o',
      messages: [],
      responseContent: '',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      finishReason: 'end_turn',
    });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('disables logging when mkdir fails', async () => {
    mockMkdirSync.mockImplementation(() => {
      throw new Error('permission denied');
    });
    const logger = await loadLogger('/tmp/bad-dir');
    logger.log({
      timestamp: new Date().toISOString(),
      provider: 'openai',
      model: 'gpt-4o',
      messages: [],
      responseContent: '',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      finishReason: 'end_turn',
    });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});
