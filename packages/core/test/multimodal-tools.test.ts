import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMultiModalTools, type ModalityCandidate } from '../src/tools/multimodal.js';
import type { MultiModalProviderInterface } from '../src/llm/provider.js';

function createMockProvider(overrides: Partial<MultiModalProviderInterface> = {}): MultiModalProviderInterface {
  return {
    name: 'mock',
    model: 'mock-model',
    ...overrides,
  } as MultiModalProviderInterface;
}

function createContext(
  candidatesByCapability: Record<string, ModalityCandidate[]>,
  extras: {
    resolveProvider?: (name: string) => ModalityCandidate | undefined;
    listProviderNames?: () => string[];
    isProviderDisabled?: (name: string) => boolean;
  } = {},
) {
  return {
    resolveCandidates: vi.fn((capabilityType: string) => candidatesByCapability[capabilityType] ?? []),
    resolveProvider: extras.resolveProvider,
    listProviderNames: extras.listProviderNames,
    isProviderDisabled: extras.isProviderDisabled,
  };
}

describe('createMultiModalTools', () => {
  it('returns expected tool handlers', () => {
    const tools = createMultiModalTools(createContext({}));
    expect(tools.map(t => t.name)).toEqual([
      'describe_image',
      'upload_reference',
      'generate_image',
      'text_to_speech',
      'speech_to_text',
      'generate_video',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.execute).toBe('function');
    }
  });

  describe('describe_image', () => {
    const di = (tools: ReturnType<typeof createMultiModalTools>) => tools.find(t => t.name === 'describe_image')!;

    it('rejects empty args with a clear error', async () => {
      const tools = createMultiModalTools(createContext({ image_recognition: [] }));
      const result = JSON.parse(await di(tools).execute({}));
      expect(result.status).toBe('error');
      expect(result.error).toContain('Missing required argument "images"');
    });

    it('successfully describes a local image via a vision chat provider', async () => {
      const tmp = join(tmpdir(), `markus-multimodal-test-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      const imgPath = join(tmp, 'test.png');
      writeFileSync(imgPath, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ));

      const chat = vi.fn().mockResolvedValue({ content: 'A tiny 1x1 PNG image.', toolCalls: undefined, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'end_turn' });
      const provider = createMockProvider({ chat, model: 'google/gemini-3.7-flash' });
      const tools = createMultiModalTools(createContext({
        image_recognition: [{ provider, name: 'markus', model: 'google/gemini-3.7-flash' }],
      }));

      const result = JSON.parse(await di(tools).execute({ images: [imgPath] }));
      expect(result.status).toBe('success');
      expect(result.content).toBe('A tiny 1x1 PNG image.');
      expect(result.provider).toBe('markus');
      expect(chat).toHaveBeenCalledTimes(1);
      const req = chat.mock.calls[0][0];
      expect(req.messages[0].role).toBe('user');
      expect(req.messages[0].content).toHaveLength(2); // text + image_url
      expect(req.messages[0].content[1].type).toBe('image_url');
      expect(req.model).toBe('google/gemini-3.7-flash');
    });

    it('returns error when no vision-capable candidates', async () => {
      const tools = createMultiModalTools(createContext({ image_recognition: [] }));
      const result = JSON.parse(await di(tools).execute({ images: ['/nope/test.png'] }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('No vision-capable model');
    });
  });

  describe('generate_image', () => {
    const img = (tools: ReturnType<typeof createMultiModalTools>) => tools.find(t => t.name === 'generate_image')!;
    it('rejects empty args with a model-clear missing-prompt error (not upstream Zod)', async () => {
      const generateImage = vi.fn();
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider: createMockProvider({ generateImage }), name: 'markus', model: 'openai/gpt-image-1' }],
      }));
      const result = JSON.parse(await img(tools).execute({}));
      expect(result.status).toBe('error');
      expect(result.error).toContain('Missing required argument "prompt"');
      expect(result.error).toContain('empty arguments {}');
      expect(result.error).toContain('do NOT rename');
      expect(generateImage).not.toHaveBeenCalled();
    });

    it('accepts description alias for prompt', async () => {
      const tinyPng =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const generateImage = vi.fn().mockResolvedValue([{ base64: tinyPng }]);
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider: createMockProvider({ generateImage }), name: 'markus', model: 'openai/gpt-image-1' }],
      }));
      const result = JSON.parse(await img(tools).execute({ description: 'a cat' }));
      expect(result.status).toBe('success');
      expect(generateImage).toHaveBeenCalledWith('a cat', expect.any(Object));
    });

    it('returns error when no candidates available', async () => {
      const tools = createMultiModalTools(createContext({ image_generation: [] }));
      const result = JSON.parse(await img(tools).execute({ prompt: 'a cat' }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('No image generation provider configured');
    });

    it('filters out providers without generateImage', async () => {
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider: createMockProvider(), name: 'no-image', model: 'x' }],
      }));
      const result = JSON.parse(await img(tools).execute({ prompt: 'a cat' }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('No image generation provider configured');
    });

    it('executes image generation via first successful provider', async () => {
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
      }));
      const generateImage = vi.fn().mockResolvedValue([{ url: 'https://example.com/img.png' }]);
      const provider = createMockProvider({ generateImage, model: 'dall-e-3' });
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider, name: 'openai', model: 'dall-e-3' }],
      }));
      const result = JSON.parse(await img(tools).execute({ prompt: 'sunset', size: '1024x1024' }));
      expect(result.status).toBe('success');
      expect(result.success).toBe(true);
      expect(result.provider).toBe('openai');
      expect(result.images).toHaveLength(1);
      expect(result.images[0].filePath).toBeTruthy();
      expect(result.images[0].markdown).toContain(result.images[0].filePath);
      expect(result.images[0].base64).toBeUndefined();
      expect(JSON.stringify(result).length).toBeLessThan(2000);
      expect(generateImage).toHaveBeenCalledWith('sunset', expect.objectContaining({ size: '1024x1024', model: 'dall-e-3' }));
      vi.unstubAllGlobals();
    });

    it('persists base64 images to disk instead of returning them in the tool result', async () => {
      const tinyPng =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const generateImage = vi.fn().mockResolvedValue([{ base64: tinyPng }]);
      const provider = createMockProvider({ generateImage, model: 'gpt-image-1' });
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider, name: 'markus', model: 'openai/gpt-image-1' }],
      }));
      const result = JSON.parse(await img(tools).execute({ prompt: 'dot' }));
      expect(result.success).toBe(true);
      expect(result.images[0].filePath).toMatch(/img-\d+-0\.png$/);
      expect(result.images[0].base64).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(tinyPng);
    });

    it('falls back to next provider on failure', async () => {
      const failProvider = createMockProvider({
        generateImage: vi.fn().mockRejectedValue(new Error('rate limited')),
        model: 'fail-model',
      });
      const okProvider = createMockProvider({
        generateImage: vi.fn().mockResolvedValue([{ path: '/tmp/img.png' }]),
        model: 'ok-model',
      });
      const tools = createMultiModalTools(createContext({
        image_generation: [
          { provider: failProvider, name: 'first', model: 'fail-model' },
          { provider: okProvider, name: 'second', model: 'ok-model' },
        ],
      }));
      const result = JSON.parse(await img(tools).execute({ prompt: 'mountain' }));
      expect(result.success).toBe(true);
      expect(result.provider).toBe('second');
    });

    it('returns error when all providers fail', async () => {
      const provider = createMockProvider({
        generateImage: vi.fn().mockRejectedValue(new Error('API down')),
      });
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider, name: 'broken', model: 'x' }],
      }));
      const result = JSON.parse(await img(tools).execute({ prompt: 'fail' }));
      expect(result.error).toContain('API down');
      expect(result.error).toMatch(/Image generation failed/);
    });

    it('uses explicit provider+model even when that provider is not in capability routing', async () => {
      const tinyPng =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const generateImage = vi.fn().mockResolvedValue([{ base64: tinyPng }]);
      const openai = createMockProvider({ generateImage, name: 'openai', model: 'gpt-image-1' });
      const tools = createMultiModalTools(
        createContext(
          // Capability routing only has markus (and that entry has no generateImage) — empty list.
          { image_generation: [] },
          {
            resolveProvider: (name) => (name === 'openai' ? { provider: openai, name: 'openai' } : undefined),
            listProviderNames: () => ['openai', 'markus'],
          },
        ),
      );
      const result = JSON.parse(await img(tools).execute({
        prompt: 'a cat',
        provider: 'openai',
        model: 'gpt-image-1',
      }));
      expect(result.status).toBe('success');
      expect(result.provider).toBe('openai');
      expect(generateImage).toHaveBeenCalledWith('a cat', expect.objectContaining({ model: 'gpt-image-1' }));
    });

    it('lists available providers when explicit provider is unknown', async () => {
      const tools = createMultiModalTools(
        createContext(
          { image_generation: [] },
          {
            resolveProvider: () => undefined,
            listProviderNames: () => ['markus', 'openai'],
          },
        ),
      );
      const result = JSON.parse(await img(tools).execute({
        prompt: 'a cat',
        provider: 'not-a-real-provider',
        model: 'x',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('not configured');
      expect(result.error).toContain('markus');
      expect(result.error).toContain('openai');
    });

    it('rejects disabled provider with an explicit disabled error', async () => {
      const generateImage = vi.fn();
      const tools = createMultiModalTools(
        createContext(
          { image_generation: [] },
          {
            resolveProvider: () => undefined,
            listProviderNames: () => ['markus'],
            isProviderDisabled: (name) => name === 'openai',
          },
        ),
      );
      const result = JSON.parse(await img(tools).execute({
        prompt: 'a cat',
        provider: 'openai',
        model: 'gpt-image-1',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('is disabled');
      expect(result.error).toContain('markus');
      expect(generateImage).not.toHaveBeenCalled();
    });
  });

  describe('text_to_speech', () => {
    it('documents sync blocking and short-chunk guidance for the agent', () => {
      const tools = createMultiModalTools(createContext({ audio_tts: [] }));
      const tts = tools.find(t => t.name === 'text_to_speech')!;
      const desc = tts.getDescription?.() ?? tts.description;
      expect(desc).toMatch(/synchronous/i);
      expect(desc).toMatch(/split/i);
      const textProp = (tts.getInputSchema?.() ?? tts.inputSchema).properties?.text as { description?: string };
      expect(textProp?.description).toMatch(/short/i);
    });

    it('returns error when no TTS provider configured', async () => {
      const tools = createMultiModalTools(createContext({ audio_tts: [] }));
      const tts = tools.find(t => t.name === 'text_to_speech')!;
      const result = JSON.parse(await tts.execute({ text: 'hello' }));
      expect(result.error).toContain('No TTS provider configured');
    });

    it('generates speech and saves temp audio file', async () => {
      const audio = Buffer.from('fake-audio-data');
      const generateSpeech = vi.fn().mockResolvedValue({ audio, format: 'mp3', durationMs: 1200 });
      const provider = createMockProvider({ generateSpeech, model: 'tts-1' });
      const tools = createMultiModalTools(createContext({
        audio_tts: [{ provider, name: 'openai', model: 'tts-1' }],
      }));
      const tts = tools.find(t => t.name === 'text_to_speech')!;
      const result = JSON.parse(await tts.execute({ text: 'Hello world', voice: 'alloy' }));
      expect(result.success).toBe(true);
      expect(result.format).toBe('mp3');
      expect(result.sizeBytes).toBe(audio.length);
      expect(result.filePath).toMatch(/generated\/audio|markus-audio/);
      expect(generateSpeech).toHaveBeenCalledWith('Hello world', expect.objectContaining({ voice: 'alloy', model: 'tts-1' }));
    });

    it('returns error when TTS fails on all providers', async () => {
      const provider = createMockProvider({
        generateSpeech: vi.fn().mockRejectedValue(new Error('TTS unavailable')),
      });
      const tools = createMultiModalTools(createContext({
        audio_tts: [{ provider, name: 'broken', model: 'tts-1' }],
      }));
      const tts = tools.find(t => t.name === 'text_to_speech')!;
      const result = JSON.parse(await tts.execute({ text: 'fail' }));
      expect(result.error).toContain('TTS unavailable');
      expect(result.error).toMatch(/TTS failed/);
    });
  });

  describe('speech_to_text', () => {
    const audioDir = join(tmpdir(), 'markus-stt-test');
    const audioPath = join(audioDir, 'sample.wav');

    beforeEach(() => {
      mkdirSync(audioDir, { recursive: true });
      writeFileSync(audioPath, Buffer.from('fake-wav-data'));
    });

    it('returns error when no STT provider configured', async () => {
      const tools = createMultiModalTools(createContext({ audio_stt: [] }));
      const stt = tools.find(t => t.name === 'speech_to_text')!;
      const result = JSON.parse(await stt.execute({ audio_url: audioPath }));
      expect(result.error).toContain('No STT provider configured');
    });

    it('transcribes local audio file', async () => {
      const transcribeSpeech = vi.fn().mockResolvedValue('Hello from audio');
      const provider = createMockProvider({ transcribeSpeech, model: 'whisper-1' });
      const tools = createMultiModalTools(createContext({
        audio_stt: [{ provider, name: 'openai', model: 'whisper-1' }],
      }));
      const stt = tools.find(t => t.name === 'speech_to_text')!;
      const result = JSON.parse(await stt.execute({ audio_url: audioPath, language: 'en' }));
      expect(result.success).toBe(true);
      expect(result.text).toBe('Hello from audio');
      expect(transcribeSpeech).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ model: 'whisper-1', language: 'en' }),
      );
      const passedBuffer = transcribeSpeech.mock.calls[0][0] as Buffer;
      expect(passedBuffer.toString()).toBe('fake-wav-data');
    });

    it('fetches remote audio via HTTP', async () => {
      const audioBytes = Buffer.from('remote-audio');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength),
      }));

      const transcribeSpeech = vi.fn().mockResolvedValue('Remote transcript');
      const provider = createMockProvider({ transcribeSpeech });
      const tools = createMultiModalTools(createContext({
        audio_stt: [{ provider, name: 'openai', model: 'whisper-1' }],
      }));
      const stt = tools.find(t => t.name === 'speech_to_text')!;
      const result = JSON.parse(await stt.execute({ audio_url: 'https://example.com/audio.wav' }));
      expect(result.success).toBe(true);
      expect(result.text).toBe('Remote transcript');
      expect(fetch).toHaveBeenCalledWith('https://example.com/audio.wav', expect.any(Object));

      vi.unstubAllGlobals();
    });

    it('returns error when fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      const provider = createMockProvider({ transcribeSpeech: vi.fn() });
      const tools = createMultiModalTools(createContext({
        audio_stt: [{ provider, name: 'openai', model: 'whisper-1' }],
      }));
      const stt = tools.find(t => t.name === 'speech_to_text')!;
      const result = JSON.parse(await stt.execute({ audio_url: 'https://example.com/missing.wav' }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to fetch audio: HTTP 404');
      vi.unstubAllGlobals();
    });
  });

  describe('generate_video', () => {
    it('returns error when no video provider configured', async () => {
      const tools = createMultiModalTools(createContext({ video_generation: [] }));
      const video = tools.find(t => t.name === 'generate_video')!;
      const result = JSON.parse(await video.execute({ prompt: 'a bird flying' }));
      expect(result.error).toContain('No video generation provider configured');
    });

    it('executes video generation successfully', async () => {
      const generateVideo = vi.fn().mockResolvedValue({
        status: 'completed',
        taskId: 'task-123',
        path: '/tmp/markus-videos/vid-task-123.mp4',
        url: 'https://example.com/video.mp4',
        durationSeconds: 5,
      });
      const provider = createMockProvider({ generateVideo });
      const tools = createMultiModalTools(createContext({
        video_generation: [{ provider, name: 'markus', model: 'alibaba/happyhorse-1.1' }],
      }));
      const video = tools.find(t => t.name === 'generate_video')!;
      const result = JSON.parse(await video.execute({ prompt: 'ocean waves', duration: 5 }));
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-123');
      expect(result.filePath).toBe('/tmp/markus-videos/vid-task-123.mp4');
      // Local path wins — do not clutter the tool result with the remote URL.
      expect(result.url).toBeUndefined();
    });
  });
});
