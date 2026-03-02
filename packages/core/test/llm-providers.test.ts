import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../src/llm/google.js';
import { OllamaProvider } from '../src/llm/ollama.js';
import { LLMRouter } from '../src/llm/router.js';

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider({ provider: 'google', model: 'gemini-2.0-flash', apiKey: 'test-key' });
  });

  it('should have correct name and model', () => {
    expect(provider.name).toBe('google');
    expect(provider.model).toBe('gemini-2.0-flash');
  });

  it('should allow reconfiguration', () => {
    provider.configure({ provider: 'google', model: 'gemini-pro', apiKey: 'new-key' });
    expect(provider.model).toBe('gemini-pro');
  });

  it('should handle API errors gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow('Gemini API error 400');

    vi.unstubAllGlobals();
  });

  it('should convert messages correctly with system instructions', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: { parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await provider.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
    });

    expect(response.content).toBe('Hello!');
    expect(response.usage.inputTokens).toBe(10);
    expect(capturedBody?.['systemInstruction']).toBeDefined();
    expect((capturedBody?.['contents'] as unknown[]).length).toBe(1);

    vi.unstubAllGlobals();
  });

  it('should handle tool calls in response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{
              functionCall: { name: 'search', args: { query: 'test' } },
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'search for test' }],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('search');
    expect(response.toolCalls![0].arguments).toEqual({ query: 'test' });

    vi.unstubAllGlobals();
  });
});

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider({ provider: 'ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434' });
  });

  it('should have correct name and model', () => {
    expect(provider.name).toBe('ollama');
    expect(provider.model).toBe('llama3.1');
  });

  it('should allow reconfiguration', () => {
    provider.configure({ provider: 'ollama', model: 'mistral', baseUrl: 'http://other:11434' });
    expect(provider.model).toBe('mistral');
  });

  it('should handle API errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow('Ollama API error 500');

    vi.unstubAllGlobals();
  });

  it('should make correct API call', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> | undefined;

    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          message: { role: 'assistant', content: 'Hello from Ollama!' },
          done: true,
          prompt_eval_count: 8,
          eval_count: 12,
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedUrl).toBe('http://localhost:11434/api/chat');
    expect(capturedBody?.['model']).toBe('llama3.1');
    expect(capturedBody?.['stream']).toBe(false);
    expect(response.content).toBe('Hello from Ollama!');
    expect(response.usage.inputTokens).toBe(8);
    expect(response.usage.outputTokens).toBe(12);

    vi.unstubAllGlobals();
  });

  it('should handle tool calls', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'git_status', arguments: {} } }],
        },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'check git' }],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('git_status');
    expect(response.finishReason).toBe('tool_use');

    vi.unstubAllGlobals();
  });
});

describe('LLMRouter - new providers', () => {
  it('should register google provider in createDefault', () => {
    const router = LLMRouter.createDefault({
      google: { provider: 'google', model: 'gemini-2.0-flash', apiKey: 'test' },
    });
    expect(router.listProviders()).toContain('google');
  });

  it('should register ollama provider in createDefault (no apiKey needed)', () => {
    const router = LLMRouter.createDefault({
      ollama: { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434' },
    });
    expect(router.listProviders()).toContain('ollama');
  });

  it('should show google and ollama in settings', () => {
    const router = LLMRouter.createDefault({});
    const settings = router.getSettings();
    expect(settings.providers).toHaveProperty('google');
    expect(settings.providers).toHaveProperty('ollama');
    expect(settings.providers['google'].configured).toBe(false);
  });

  it('should handle multiple providers together', () => {
    const router = LLMRouter.createDefault({
      anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'test' },
      google: { provider: 'google', model: 'gemini-2.0-flash', apiKey: 'test' },
      ollama: { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434' },
    });
    const providers = router.listProviders();
    expect(providers).toContain('anthropic');
    expect(providers).toContain('google');
    expect(providers).toContain('ollama');
    expect(router.isAutoSelectEnabled()).toBe(true);
  });
});
