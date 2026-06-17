import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AgentToolHandler } from '../agent.js';
import type { MultiModalProviderInterface } from '../llm/provider.js';
import { createLogger, type ModelTaskType } from '@markus/shared';

const log = createLogger('multimodal-tools');

export interface ModalityCandidate {
  provider: MultiModalProviderInterface;
  model?: string;
  name: string;
}

export interface MultiModalToolsContext {
  resolveCandidates: (taskType: ModelTaskType) => ModalityCandidate[];
}

async function fetchAudioBuffer(source: string): Promise<Buffer> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Failed to fetch audio: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFileSync(source);
}

function saveTempAudio(audio: Buffer, format: string): string {
  const dir = join(tmpdir(), 'markus-audio');
  mkdirSync(dir, { recursive: true });
  const filename = `tts-${Date.now()}.${format}`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, audio);
  return filepath;
}

export function createMultiModalTools(ctx: MultiModalToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'generate_image',
      description:
        'Generate images from a text prompt using the provider configured in Settings > Model Routing (image_generation task). ' +
        'Use llm_get_task_routing to check current configuration, or llm_set_task_routing to configure.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt:          { type: 'string', description: 'Detailed text description of the image to generate' },
          size:            { type: 'string', description: 'Image size – pixel dimensions (e.g. "1024x1024", "1792x1024") or aspect ratio (e.g. "16:9", "1:1"). MiniMax only supports aspect ratios: 1:1, 16:9, 4:3, 3:2, 2:3, 3:4, 9:16, 21:9' },
          quality:         { type: 'string', enum: ['standard', 'hd'], description: 'Image quality (some providers)' },
          style:           { type: 'string', description: 'Style preset: natural/vivid (OpenAI), or provider-specific style name' },
          n:               { type: 'number', description: 'Number of images to generate (default: 1)' },
          negative_prompt: { type: 'string', description: 'What to avoid in the image (some providers)' },
          seed:            { type: 'number', description: 'Seed for reproducibility (some providers)' },
          output_dir:      { type: 'string', description: 'Directory to save images' },
          output_format:   { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Output image format (default: png)' },
        },
        required: ['prompt'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const candidates = ctx.resolveCandidates('image_generation').filter(c => c.provider.generateImage);
        if (candidates.length === 0) {
          return JSON.stringify({
            error: 'No image generation provider configured. Use llm_set_task_routing to assign a provider+model for task_type "image_generation" (e.g. provider: "openai", model: "gpt-image-1").',
          });
        }
        const opts = {
          size: args.size as string | undefined,
          quality: args.quality as string | undefined,
          style: args.style as string | undefined,
          n: args.n as number | undefined,
          negative_prompt: args.negative_prompt as string | undefined,
          seed: args.seed as number | undefined,
          output_dir: args.output_dir as string | undefined,
          output_format: args.output_format as string | undefined,
        };
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const { provider, model, name } = candidates[i];
          try {
            const results = await provider.generateImage!(args.prompt as string, { ...opts, model });
            log.info(`Generated ${results.length} image(s) via ${name}/${model ?? provider.model}`);
            return JSON.stringify({ success: true, provider: name, model: model ?? provider.model, images: results });
          } catch (err) {
            lastError = err;
            log.warn(`Image generation via ${name} failed${i < candidates.length - 1 ? ', trying next provider' : ''}: ${err}`);
          }
        }
        log.error(`Image generation failed on all ${candidates.length} provider(s)`);
        return JSON.stringify({ error: `Image generation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}` });
      },
    },

    {
      name: 'text_to_speech',
      description:
        'Convert text to speech audio. Returns a file path to the generated audio. ' +
        'Requires a TTS provider to be configured via llm_set_task_routing (task_type: "audio_tts").',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to convert to speech' },
          voice: { type: 'string', description: 'Voice to use (provider-specific, e.g. "alloy", "echo", "nova")' },
          speed: { type: 'number', description: 'Speech speed multiplier (0.25-4.0)', default: 1.0 },
        },
        required: ['text'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const candidates = ctx.resolveCandidates('audio_tts').filter(c => c.provider.generateSpeech);
        if (candidates.length === 0) {
          return JSON.stringify({ error: 'No TTS provider configured. Use llm_set_task_routing to assign a provider+model for task_type "audio_tts" (e.g. provider: "openai", model: "tts-1").' });
        }
        const opts = { voice: args.voice as string | undefined, speed: args.speed as number | undefined };
        let lastError: unknown;
        for (const { provider, model, name } of candidates) {
          try {
            const result = await provider.generateSpeech!(args.text as string, { ...opts, model });
            const filepath = saveTempAudio(result.audio, result.format);
            log.info(`Generated speech via ${name}: ${result.format}, ${result.audio.length} bytes -> ${filepath}`);
            return JSON.stringify({ success: true, filePath: filepath, format: result.format, sizeBytes: result.audio.length, durationMs: result.durationMs });
          } catch (err) {
            lastError = err;
            log.warn(`TTS via ${name} failed: ${err}`);
          }
        }
        log.error(`TTS failed on all ${candidates.length} provider(s)`);
        return JSON.stringify({ error: `TTS failed: ${lastError instanceof Error ? lastError.message : String(lastError)}` });
      },
    },

    {
      name: 'speech_to_text',
      description:
        'Transcribe speech audio to text. Accepts a URL or local file path. ' +
        'Requires an STT provider to be configured via llm_set_task_routing (task_type: "audio_stt").',
      inputSchema: {
        type: 'object',
        properties: {
          audio_url: { type: 'string', description: 'URL or local file path of the audio to transcribe' },
          language: { type: 'string', description: 'Language code (e.g. "en", "zh", "ja") for better accuracy' },
        },
        required: ['audio_url'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const candidates = ctx.resolveCandidates('audio_stt').filter(c => c.provider.transcribeSpeech);
        if (candidates.length === 0) {
          return JSON.stringify({ error: 'No STT provider configured. Use llm_set_task_routing to assign a provider+model for task_type "audio_stt" (e.g. provider: "openai", model: "whisper-1").' });
        }
        const audioUrl = args.audio_url as string;
        log.info(`Transcribing audio from: ${audioUrl}`);
        const audioBuffer = await fetchAudioBuffer(audioUrl);
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const { provider, model, name } = candidates[i];
          try {
            const text = await provider.transcribeSpeech!(audioBuffer, { model, language: args.language as string | undefined });
            log.info(`Transcribed audio via ${name}`);
            return JSON.stringify({ success: true, text });
          } catch (err) {
            lastError = err;
            log.warn(`STT via ${name} failed${i < candidates.length - 1 ? ', trying next provider' : ''}: ${err}`);
          }
        }
        log.error(`STT failed on all ${candidates.length} provider(s)`);
        return JSON.stringify({ error: `STT failed: ${lastError instanceof Error ? lastError.message : String(lastError)}` });
      },
    },

    {
      name: 'generate_video',
      description:
        'Generate a video from a text prompt using an AI video generation model. ' +
        'Requires a video provider to be configured via llm_set_task_routing (task_type: "video_generation").',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the video to generate' },
          duration: { type: 'number', description: 'Desired video duration in seconds', default: 5 },
          size: { type: 'string', description: 'Video resolution (e.g. "1280x720", "1920x1080")' },
        },
        required: ['prompt'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const candidates = ctx.resolveCandidates('video_generation').filter(c => c.provider.generateVideo);
        if (candidates.length === 0) {
          return JSON.stringify({ error: 'No video generation provider configured. Use llm_set_task_routing to assign a provider+model for task_type "video_generation".' });
        }
        const opts = { duration: args.duration as number | undefined, size: args.size as string | undefined };
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const { provider, model, name } = candidates[i];
          try {
            const result = await provider.generateVideo!(args.prompt as string, { ...opts, model });
            log.info(`Video generation via ${name} ${result.status}`, { taskId: result.taskId });
            return JSON.stringify({ success: true, status: result.status, taskId: result.taskId, url: result.url, durationSeconds: result.durationSeconds });
          } catch (err) {
            lastError = err;
            log.warn(`Video generation via ${name} failed${i < candidates.length - 1 ? ', trying next provider' : ''}: ${err}`);
          }
        }
        log.error(`Video generation failed on all ${candidates.length} provider(s)`);
        return JSON.stringify({ error: `Video generation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}` });
      },
    },
  ];
}
