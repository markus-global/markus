import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DashScopeProvider } from '../src/llm/dashscope.js';

describe('DashScopeProvider', () => {
  let provider: DashScopeProvider;

  beforeEach(() => {
    provider = new DashScopeProvider({
      provider: 'dashscope' as any,
      model: 'qwen-max',
      apiKey: 'ds-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports correct capabilities', () => {
    const caps = provider.getCapabilities();
    expect(caps.imageGeneration).toBe(true);
    expect(caps.tts).toBe(true);
    expect(caps.stt).toBe(false);
    expect(caps.embedding).toBe(true);
  });

  it('generates image via native multimodal endpoint', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          output: {
            choices: [{
              message: {
                content: [{ image: 'https://dashscope.example/img.png' }],
              },
            }],
          },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await provider.generateImage('a cat', { size: '1024x1024', n: 1 });
    expect(capturedUrl).toContain('/api/v1/services/aigc/multimodal-generation/generation');
    expect(capturedBody?.model).toBe('qwen-image-2.0-pro');
    expect((capturedBody?.parameters as Record<string, unknown>)?.size).toBe('1024*1024');
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://dashscope.example/img.png');
  });

  it('throws on DashScope image API error code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 'InvalidParameter', message: 'bad prompt' }),
    }));

    await expect(provider.generateImage('bad')).rejects.toThrow('DashScope image generation error');
  });

  it('generates speech and downloads audio from URL', async () => {
    const audioBytes = Buffer.from('fake-mp3-data');
    const audioUrl = 'https://dashscope.example/audio.mp3';
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('multimodal-generation')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ output: { audio: { url: audioUrl } } }),
        });
      }
      if (url === audioUrl) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new Uint8Array(audioBytes).buffer),
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.generateSpeech('你好', { voice: 'Cherry', responseFormat: 'mp3' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(Buffer.from(result.audio)).toEqual(audioBytes);
    expect(result.format).toBe('mp3');
  });

  it('throws when TTS returns no audio URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ output: {} }),
    }));

    await expect(provider.generateSpeech('hello')).rejects.toThrow('DashScope TTS returned no audio URL');
  });
});
