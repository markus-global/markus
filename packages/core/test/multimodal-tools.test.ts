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

function createContext(candidatesByCapability: Record<string, ModalityCandidate[]>) {
  return {
    resolveCandidates: vi.fn((capabilityType: string) => candidatesByCapability[capabilityType] ?? []),
  };
}

describe('createMultiModalTools', () => {
  it('returns expected tool handlers', () => {
    const tools = createMultiModalTools(createContext({}));
    expect(tools.map(t => t.name)).toEqual([
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

  describe('generate_image', () => {
    it('returns error when no candidates available', async () => {
      const tools = createMultiModalTools(createContext({ image_generation: [] }));
      const result = JSON.parse(await tools[0].execute({ prompt: 'a cat' }));
      expect(result.error).toContain('No image generation provider configured');
    });

    it('filters out providers without generateImage', async () => {
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider: createMockProvider(), name: 'no-image', model: 'x' }],
      }));
      const result = JSON.parse(await tools[0].execute({ prompt: 'a cat' }));
      expect(result.error).toContain('No image generation provider configured');
    });

    it('executes image generation via first successful provider', async () => {
      const generateImage = vi.fn().mockResolvedValue([{ url: 'https://example.com/img.png' }]);
      const provider = createMockProvider({ generateImage, model: 'dall-e-3' });
      const tools = createMultiModalTools(createContext({
        image_generation: [{ provider, name: 'openai', model: 'dall-e-3' }],
      }));
      const result = JSON.parse(await tools[0].execute({ prompt: 'sunset', size: '1024x1024' }));
      expect(result.success).toBe(true);
      expect(result.provider).toBe('openai');
      expect(result.images).toHaveLength(1);
      expect(generateImage).toHaveBeenCalledWith('sunset', expect.objectContaining({ size: '1024x1024', model: 'dall-e-3' }));
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
      const result = JSON.parse(await tools[0].execute({ prompt: 'mountain' }));
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
      const result = JSON.parse(await tools[0].execute({ prompt: 'fail' }));
      expect(result.error).toContain('Image generation failed: API down');
    });
  });

  describe('text_to_speech', () => {
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
      expect(result.filePath).toContain('markus-audio');
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
      expect(result.error).toContain('TTS failed: TTS unavailable');
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
      await expect(stt.execute({ audio_url: 'https://example.com/missing.wav' }))
        .rejects.toThrow('Failed to fetch audio: HTTP 404');
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
        url: 'https://example.com/video.mp4',
        durationSeconds: 5,
      });
      const provider = createMockProvider({ generateVideo });
      const tools = createMultiModalTools(createContext({
        video_generation: [{ provider, name: 'runway', model: 'gen-3' }],
      }));
      const video = tools.find(t => t.name === 'generate_video')!;
      const result = JSON.parse(await video.execute({ prompt: 'ocean waves', duration: 5 }));
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-123');
      expect(result.url).toBe('https://example.com/video.mp4');
    });
  });
});
