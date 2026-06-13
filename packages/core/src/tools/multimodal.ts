import type { AgentToolHandler } from '../agent.js';
import type { MultiModalProviderInterface } from '../llm/provider.js';
import { createLogger } from '@markus/shared';

const log = createLogger('multimodal-tools');

export interface MultiModalToolsContext {
  /**
   * Resolve a provider that supports the requested modality.
   * Returns undefined if no provider is configured for that modality.
   */
  resolveProvider: (modality: 'image_gen' | 'tts' | 'stt' | 'video_gen') => MultiModalProviderInterface | undefined;
}

export function createMultiModalTools(ctx: MultiModalToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'generate_image',
      description: 'Generate an image from a text prompt using an AI image generation model (e.g. DALL-E, Flux, Stable Diffusion).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed description of the image to generate',
          },
          size: {
            type: 'string',
            description: 'Image size (e.g. "1024x1024", "1792x1024")',
            default: '1024x1024',
          },
          quality: {
            type: 'string',
            description: 'Image quality ("standard" or "hd")',
            default: 'standard',
          },
          n: {
            type: 'number',
            description: 'Number of images to generate (1-4)',
            default: 1,
          },
        },
        required: ['prompt'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = ctx.resolveProvider('image_gen');
        if (!provider?.generateImage) {
          return JSON.stringify({ error: 'No image generation provider configured. Please add a provider with image generation capability in Settings.' });
        }
        try {
          const results = await provider.generateImage(
            args.prompt as string,
            {
              size: args.size as string | undefined,
              quality: args.quality as string | undefined,
              n: args.n as number | undefined,
            },
          );
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
      description: 'Convert text to speech audio using a TTS model (e.g. OpenAI TTS, ElevenLabs).',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to convert to speech',
          },
          voice: {
            type: 'string',
            description: 'Voice to use (provider-specific, e.g. "alloy", "echo", "nova")',
          },
          speed: {
            type: 'number',
            description: 'Speech speed multiplier (0.25-4.0)',
            default: 1.0,
          },
        },
        required: ['text'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = ctx.resolveProvider('tts');
        if (!provider?.generateSpeech) {
          return JSON.stringify({ error: 'No TTS provider configured. Please add a provider with text-to-speech capability in Settings.' });
        }
        try {
          const result = await provider.generateSpeech(
            args.text as string,
            {
              voice: args.voice as string | undefined,
              speed: args.speed as number | undefined,
            },
          );
          log.info(`Generated speech audio: ${result.format}, ${result.durationMs ?? '?'}ms`);
          return JSON.stringify({
            success: true,
            format: result.format,
            durationMs: result.durationMs,
            sizeBytes: result.audio.length,
          });
        } catch (err) {
          log.error(`TTS failed: ${err}`);
          return JSON.stringify({ error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      },
    },

    {
      name: 'speech_to_text',
      description: 'Transcribe speech audio to text using an STT model (e.g. Whisper).',
      inputSchema: {
        type: 'object',
        properties: {
          audio_url: {
            type: 'string',
            description: 'URL or file path of the audio to transcribe',
          },
          language: {
            type: 'string',
            description: 'Language code (e.g. "en", "zh", "ja") for better accuracy',
          },
        },
        required: ['audio_url'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = ctx.resolveProvider('stt');
        if (!provider?.transcribeSpeech) {
          return JSON.stringify({ error: 'No STT provider configured. Please add a provider with speech-to-text capability in Settings.' });
        }
        try {
          // TODO: fetch audio from URL/path and convert to Buffer
          const audioUrl = args.audio_url as string;
          log.info(`Transcribing audio from: ${audioUrl}`);
          return JSON.stringify({
            error: 'Audio fetching not yet implemented. This tool will be fully functional when audio input pipeline is ready.',
            audio_url: audioUrl,
          });
        } catch (err) {
          log.error(`STT failed: ${err}`);
          return JSON.stringify({ error: `STT failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      },
    },

    {
      name: 'generate_video',
      description: 'Generate a video from a text prompt using an AI video generation model (e.g. Kling, Runway).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed description of the video to generate',
          },
          duration: {
            type: 'number',
            description: 'Desired video duration in seconds',
            default: 5,
          },
          size: {
            type: 'string',
            description: 'Video resolution (e.g. "1280x720", "1920x1080")',
          },
        },
        required: ['prompt'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = ctx.resolveProvider('video_gen');
        if (!provider?.generateVideo) {
          return JSON.stringify({ error: 'No video generation provider configured. Please add a provider with video generation capability in Settings.' });
        }
        try {
          const result = await provider.generateVideo(
            args.prompt as string,
            {
              duration: args.duration as number | undefined,
              size: args.size as string | undefined,
            },
          );
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
