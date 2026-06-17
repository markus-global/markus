import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MiniMaxProvider } from '../src/llm/minimax.js';

describe('MiniMaxProvider', () => {
  let provider: MiniMaxProvider;

  beforeEach(() => {
    provider = new MiniMaxProvider({
      provider: 'minimax',
      model: 'MiniMax-M3',
      apiKey: 'mm-key',
      baseUrl: 'https://api.minimax.io/v1',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('constructs with correct name and capabilities', () => {
    expect(provider.name).toBe('minimax');
    const caps = provider.getCapabilities();
    expect(caps.imageGeneration).toBe(true);
    expect(caps.tts).toBe(true);
    expect(caps.videoGeneration).toBe(true);
    expect(caps.stt).toBe(false);
  });

  it('generates image from image_urls response format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { image_urls: ['https://minimax.example/img1.png', 'https://minimax.example/img2.png'] },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await provider.generateImage('red circle', { size: '1024x1024' });
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe('https://minimax.example/img1.png');

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.aspect_ratio).toBe('1:1');
  });

  it('throws on MiniMax image base_resp error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        base_resp: { status_code: 1001, status_msg: 'invalid prompt' },
      }),
    }));

    await expect(provider.generateImage('bad')).rejects.toThrow('MiniMax image generation error');
  });

  it('generates speech from hex-encoded audio', async () => {
    const hexAudio = Buffer.from('hello-audio').toString('hex');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { audio: hexAudio },
        extra_info: { audio_format: 'mp3' },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    }));

    const result = await provider.generateSpeech('Hello world', { voice: 'Calm_Woman' });
    expect(result.audio.toString()).toBe('hello-audio');
    expect(result.format).toBe('mp3');
  });

  it('generates video with async polling until success', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          task_id: 'task-123',
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'Processing' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'Success', file_id: 'file-456' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          file: { download_url: 'https://minimax.example/video.mp4' },
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const promise = provider.generateVideo('a flying bird', { duration: 5 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.status).toBe('completed');
    expect(result.url).toBe('https://minimax.example/video.mp4');
    expect(result.taskId).toBe('task-123');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('throws when video generation fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ task_id: 'task-fail', base_resp: { status_code: 0, status_msg: 'ok' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'Fail', base_resp: { status_msg: 'content policy' } }),
      }));

    const promise = provider.generateVideo('bad content');
    const assertion = expect(promise).rejects.toThrow('MiniMax video generation failed');
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});
