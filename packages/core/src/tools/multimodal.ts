import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AgentToolHandler } from '../agent.js';
import type { MultiModalProviderInterface } from '../llm/provider.js';
import { createLogger, type ModelTaskType } from '@markus/shared';

const log = createLogger('multimodal-tools');

export interface MultiModalToolsContext {
  resolveProvider: (taskType: ModelTaskType) => MultiModalProviderInterface | undefined;
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
      description: 'Generate an image from a text prompt using an AI image generation model (e.g. DALL-E, Flux, Stable Diffusion).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the image to generate' },
          size: { type: 'string', description: 'Image size (e.g. "1024x1024", "1792x1024")', default: '1024x1024' },
          quality: { type: 'string', description: 'Image quality ("standard" or "hd")', default: 'standard' },
          n: { type: 'number', description: 'Number of images to generate (1-4)', default: 1 },
        },
        required: ['prompt'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = ctx.resolveProvider('image_generation');
        if (!provider?.generateImage) {
          return JSON.stringify({ error: 'No image generation provider configured. Please assign a model for "Image Generation" in Settings > Model Routing.' });
        }
        try {
          const results = await provider.generateImage(args.prompt as string, {
            size: args.size as string | undefined,
            quality: args.quality as string | undefined,
            n: args.n as number | undefined,
          });
          log.info(`Generated ${results.length} image(s)`);
          return JSON.stringify({ success: true, images: results });
        } catch (err) {
          log.error(`Image generation failed: ${err}`);
          return JSON.stringify({ error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      },
    },

    {
      name: 'text_to_speech',
      description: 'Convert text to speech audio. Returns a file path to the generated audio.',
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
        const provider = ctx.resolveProvider('audio_tts');
        if (!provider?.generateSpeech) {
          return JSON.stringify({ error: 'No TTS provider configured. Please assign a model for "Text-to-Speech" in Settings > Model Routing.' });
        }
        try {
          const result = await provider.generateSpeech(args.text as string, {
            voice: args.voice as string | undefined,
            speed: args.speed as number | undefined,
          });
          const filepath = saveTempAudio(result.audio, result.format);
          log.info(`Generated speech: ${result.format}, ${result.audio.length} bytes -> ${filepath}`);
          return JSON.stringify({
            success: true,
            filePath: filepath,
            format: result.format,
            sizeBytes: result.audio.length,
            durationMs: result.durationMs,
          });
        } catch (err) {
          log.error(`TTS failed: ${err}`);
          return JSON.stringify({ error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      },
    },

    {
      name: 'speech_to_text',
      description: 'Transcribe speech audio to text. Accepts a URL or local file path.',
      inputSchema: {
        type: 'object',
        properties: {
          audio_url: { type: 'string', description: 'URL or local file path of the audio to transcribe' },
          language: { type: 'string', description: 'Language code (e.g. "en", "zh", "ja") for better accuracy' },
        },
        required: ['audio_url'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = ctx.resolveProvider('audio_stt');
        if (!provider?.transcribeSpeech) {
          return JSON.stringify({ error: 'No STT provider configured. Please assign a model for "Speech-to-Text" in Settings > Model Routing.' });
        }
        try {
          const audioUrl = args.audio_url as string;
          log.info(`Transcribing audio from: ${audioUrl}`);
          const audioBuffer = await fetchAudioBuffer(audioUrl);
          const text = await provider.transcribeSpeech(audioBuffer, {
            language: args.language as string | undefined,
          });
          return JSON.stringify({ success: true, text });
        } catch (err) {
          log.error(`STT failed: ${err}`);
          return JSON.stringify({ error: `STT failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      },
    },

    {
      name: 'generate_video',
      description: 'Generate a video from a text prompt using an AI video generation model.',
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
        const provider = ctx.resolveProvider('video_generation');
        if (!provider?.generateVideo) {
          return JSON.stringify({ error: 'No video generation provider configured. Please assign a model for "Video Generation" in Settings > Model Routing.' });
        }
        try {
          const result = await provider.generateVideo(args.prompt as string, {
            duration: args.duration as number | undefined,
            size: args.size as string | undefined,
          });
          log.info(`Video generation ${result.status}`, { taskId: result.taskId });
          return JSON.stringify({
            success: true,
            status: result.status,
            taskId: result.taskId,
            url: result.url,
            durationSeconds: result.durationSeconds,
          });
        } catch (err) {
          log.error(`Video generation failed: ${err}`);
          return JSON.stringify({ error: `Video generation failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      },
    },
  ];
}
