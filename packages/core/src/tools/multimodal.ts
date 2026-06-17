import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolHandler } from '../agent.js';
import type { MultiModalProviderInterface, MultiModalToolSchemas } from '../llm/provider.js';
import { createLogger, type ModelCapabilityType } from '@markus/shared';

const log = createLogger('multimodal-tools');

export interface ModalityCandidate {
  provider: MultiModalProviderInterface;
  model?: string;
  name: string;
}

export interface MultiModalToolsContext {
  resolveCandidates: (capabilityType: ModelCapabilityType) => ModalityCandidate[];
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

function getProviderSchema(ctx: MultiModalToolsContext, capabilityType: ModelCapabilityType, toolName: keyof MultiModalToolSchemas): { description: string; inputSchema: Record<string, unknown> } | undefined {
  const candidates = ctx.resolveCandidates(capabilityType);
  for (const { provider } of candidates) {
    const schemas = (provider as MultiModalProviderInterface).getToolSchemas?.();
    if (schemas?.[toolName]) {
      const schema = schemas[toolName]!;
      const props = (schema.inputSchema.properties ?? {}) as Record<string, unknown>;
      if (!props.provider || !props.model) {
        return {
          description: schema.description,
          inputSchema: {
            ...schema.inputSchema,
            properties: {
              ...props,
              provider: { type: 'string', description: 'Override which provider to use (e.g. "openai", "minimax"). If omitted, uses the configured routing default.' },
              ...(!props.model ? { model: { type: 'string', description: 'Override which model to use. If omitted, uses the configured routing default.' } } : {}),
            },
          },
        };
      }
      return schema;
    }
  }
  return undefined;
}

/**
 * Resolve effective candidates list based on agent-specified provider/model overrides.
 * If agent specifies a provider, only that provider is used (with agent model if given).
 * Otherwise, all routing candidates are used with agent model override applied.
 */
function resolveEffectiveCandidates(
  candidates: ModalityCandidate[],
  agentProvider?: string,
  agentModel?: string,
): Array<{ provider: MultiModalProviderInterface; model?: string; name: string }> {
  if (agentProvider) {
    const match = candidates.find(c => c.name === agentProvider);
    if (match) {
      return [{ provider: match.provider, model: agentModel ?? match.model, name: match.name }];
    }
    return [];
  }
  if (agentModel) {
    return candidates.map(c => ({ ...c, model: agentModel }));
  }
  return candidates;
}

const PROVIDER_PARAM = { type: 'string', description: 'Override which provider to use (e.g. "openai", "minimax"). If omitted, uses the configured routing default.' } as const;
const MODEL_PARAM = { type: 'string', description: 'Override which model to use. If omitted, uses the configured routing default.' } as const;

export function createMultiModalTools(ctx: MultiModalToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'generate_image',
      description:
        'Generate images from a text prompt. Use llm_get_capability_routing to check current configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed text description of the image to generate' },
          provider: PROVIDER_PARAM,
          model: MODEL_PARAM,
        },
        required: ['prompt'],
      },
      getDescription() {
        return getProviderSchema(ctx, 'image_generation', 'generate_image')?.description ?? this.description;
      },
      getInputSchema() {
        return getProviderSchema(ctx, 'image_generation', 'generate_image')?.inputSchema ?? this.inputSchema;
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const allCandidates = ctx.resolveCandidates('image_generation').filter(c => c.provider.generateImage);
        const candidates = resolveEffectiveCandidates(allCandidates, args.provider as string | undefined, args.model as string | undefined);
        if (candidates.length === 0) {
          if (args.provider) {
            return JSON.stringify({ error: `Provider "${args.provider}" is not available for image generation. Use llm_get_capability_routing to see available providers.` });
          }
          return JSON.stringify({
            error: 'No image generation provider configured. Use llm_set_capability_routing to assign a provider+model for capability_type "image_generation" (e.g. provider: "openai", model: "gpt-image-1").',
          });
        }
        const opts = {
          size: (args.size ?? args.aspect_ratio) as string | undefined,
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
        'Convert text to speech audio. Returns a file path to the generated audio.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to convert to speech' },
          provider: PROVIDER_PARAM,
          model: MODEL_PARAM,
        },
        required: ['text'],
      },
      getDescription() {
        return getProviderSchema(ctx, 'audio_tts', 'text_to_speech')?.description ?? this.description;
      },
      getInputSchema() {
        return getProviderSchema(ctx, 'audio_tts', 'text_to_speech')?.inputSchema ?? this.inputSchema;
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const allCandidates = ctx.resolveCandidates('audio_tts').filter(c => c.provider.generateSpeech);
        const candidates = resolveEffectiveCandidates(allCandidates, args.provider as string | undefined, args.model as string | undefined);
        if (candidates.length === 0) {
          if (args.provider) {
            return JSON.stringify({ error: `Provider "${args.provider}" is not available for TTS. Use llm_get_capability_routing to see available providers.` });
          }
          return JSON.stringify({ error: 'No TTS provider configured. Use llm_set_capability_routing to assign a provider+model for capability_type "audio_tts" (e.g. provider: "openai", model: "tts-1").' });
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
        'Transcribe speech audio to text. Accepts a URL or local file path.',
      inputSchema: {
        type: 'object',
        properties: {
          audio_url: { type: 'string', description: 'URL or local file path of the audio to transcribe' },
          provider: PROVIDER_PARAM,
          model: MODEL_PARAM,
        },
        required: ['audio_url'],
      },
      getDescription() {
        return getProviderSchema(ctx, 'audio_stt', 'speech_to_text')?.description ?? this.description;
      },
      getInputSchema() {
        return getProviderSchema(ctx, 'audio_stt', 'speech_to_text')?.inputSchema ?? this.inputSchema;
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const allCandidates = ctx.resolveCandidates('audio_stt').filter(c => c.provider.transcribeSpeech);
        const candidates = resolveEffectiveCandidates(allCandidates, args.provider as string | undefined, args.model as string | undefined);
        if (candidates.length === 0) {
          if (args.provider) {
            return JSON.stringify({ error: `Provider "${args.provider}" is not available for STT. Use llm_get_capability_routing to see available providers.` });
          }
          return JSON.stringify({ error: 'No STT provider configured. Use llm_set_capability_routing to assign a provider+model for capability_type "audio_stt" (e.g. provider: "openai", model: "whisper-1").' });
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
        'Generate a video from a text prompt using an AI video generation model.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the video to generate' },
          provider: PROVIDER_PARAM,
          model: MODEL_PARAM,
        },
        required: ['prompt'],
      },
      getDescription() {
        return getProviderSchema(ctx, 'video_generation', 'generate_video')?.description ?? this.description;
      },
      getInputSchema() {
        return getProviderSchema(ctx, 'video_generation', 'generate_video')?.inputSchema ?? this.inputSchema;
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const allCandidates = ctx.resolveCandidates('video_generation').filter(c => c.provider.generateVideo);
        const candidates = resolveEffectiveCandidates(allCandidates, args.provider as string | undefined, args.model as string | undefined);
        if (candidates.length === 0) {
          if (args.provider) {
            return JSON.stringify({ error: `Provider "${args.provider}" is not available for video generation. Use llm_get_capability_routing to see available providers.` });
          }
          return JSON.stringify({ error: 'No video generation provider configured. Use llm_set_capability_routing to assign a provider+model for capability_type "video_generation".' });
        }
        const opts = {
          duration: args.duration as number | undefined,
          size: (args.size ?? args.resolution) as string | undefined,
        };
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
