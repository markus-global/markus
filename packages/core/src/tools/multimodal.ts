import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { AgentToolHandler } from '../agent.js';
import type { ImageResult, MultiModalProviderInterface, MultiModalToolSchemas, VideoResult } from '../llm/provider.js';
import { createLogger, type ModelCapabilityType } from '@markus/shared';
import { toolErr, toolOk } from './result.js';

const log = createLogger('multimodal-tools');

export interface ModalityCandidate {
  provider: MultiModalProviderInterface;
  model?: string;
  name: string;
}

export interface MultiModalToolsContext {
  resolveCandidates: (capabilityType: ModelCapabilityType) => ModalityCandidate[];
  /**
   * Look up any configured provider by name for explicit `provider=` overrides.
   * Must NOT be limited to current capability-routing candidates.
   * Only returns providers whose Settings switch is ON (enabled).
   */
  resolveProvider?: (name: string) => ModalityCandidate | undefined;
  /** For error hints when an unknown provider is requested (enabled providers only). */
  listProviderNames?: () => string[];
  /** True when the provider exists but its Settings switch is OFF. */
  isProviderDisabled?: (name: string) => boolean;
}

async function fetchBinary(source: string, label: string): Promise<Buffer> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Failed to fetch ${label}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFileSync(source);
}

async function fetchAudioBuffer(source: string): Promise<Buffer> {
  return fetchBinary(source, 'audio');
}

function mediaDir(kind: 'audio' | 'images' | 'videos'): string {
  // Prefer ~/.markus/generated so /api/files/image can serve them; fall back to tmp.
  try {
    const dir = join(homedir(), '.markus', 'generated', kind);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const dir = join(tmpdir(), `markus-${kind}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

function saveTempAudio(audio: Buffer, format: string): string {
  const filename = `tts-${Date.now()}.${format}`;
  const filepath = join(mediaDir('audio'), filename);
  writeFileSync(filepath, audio);
  return filepath;
}

function guessImageExt(url?: string, base64?: string): string {
  if (url) {
    const m = url.match(/\.(png|jpe?g|gif|webp|svg|bmp)(?:\?|#|$)/i);
    if (m) return m[1]!.toLowerCase().replace('jpeg', 'jpg');
  }
  if (base64?.startsWith('/9j/')) return 'jpg';
  if (base64?.startsWith('iVBOR')) return 'png';
  if (base64?.startsWith('R0lGOD')) return 'gif';
  if (base64?.startsWith('UklGR')) return 'webp';
  return 'png';
}

/**
 * Persist an image result to disk and return a short path suitable for chat
 * context + markdown (`![alt](filePath)` → UI serves via /api/files/image).
 * Never return raw base64 in the tool result — it blows the agent context.
 */
async function persistImageResult(img: ImageResult, index: number): Promise<{
  filePath: string;
  revisedPrompt?: string;
  markdown: string;
}> {
  // Markus (and any provider that already persisted) returns path — reuse it.
  if (img.path && !img.path.startsWith('data:')) {
    return {
      filePath: img.path,
      revisedPrompt: img.revisedPrompt,
      markdown: `![generated image](${img.path})`,
    };
  }

  let bytes: Buffer | undefined;
  if (img.base64) {
    const raw = img.base64.includes(',') ? img.base64.split(',').pop()! : img.base64;
    bytes = Buffer.from(raw, 'base64');
  } else if (img.url?.startsWith('data:')) {
    const raw = img.url.split(',').pop() ?? '';
    bytes = Buffer.from(raw, 'base64');
  } else if (img.url) {
    bytes = await fetchBinary(img.url, 'image');
  }
  if (!bytes?.length) {
    throw new Error('Image result had no downloadable url/base64/path');
  }

  const ext = guessImageExt(img.url, img.base64);
  const filepath = join(mediaDir('images'), `img-${Date.now()}-${index}.${ext}`);
  writeFileSync(filepath, bytes);
  return {
    filePath: filepath,
    revisedPrompt: img.revisedPrompt,
    markdown: `![generated image](${filepath})`,
  };
}

function formatVideoToolResult(result: VideoResult): {
  generationStatus: VideoResult['status'];
  taskId?: string;
  filePath?: string;
  url?: string;
  durationSeconds?: number;
  note?: string;
} {
  const filePath = result.path;
  return {
    generationStatus: result.status,
    taskId: result.taskId,
    filePath,
    // Prefer local path in the tool payload; keep remote url only as fallback.
    url: filePath ? undefined : result.url,
    durationSeconds: result.durationSeconds,
    note: filePath
      ? `Video saved to ${filePath}. Tell the user the local path; do not embed base64.`
      : result.status === 'processing'
        ? 'Video job still processing — poll again or retry generate_video later with the same prompt.'
        : undefined,
  };
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

type ModalityMethod = 'generateImage' | 'generateSpeech' | 'transcribeSpeech' | 'generateVideo';

/**
 * Resolve effective candidates list based on agent-specified provider/model overrides.
 * Explicit provider= may target ANY configured provider (via resolveProvider), not only
 * the current capability-routing candidate list.
 */
function resolveEffectiveCandidates(
  candidates: ModalityCandidate[],
  agentProvider: string | undefined,
  agentModel: string | undefined,
  ctx: MultiModalToolsContext,
  method: ModalityMethod,
): { candidates: ModalityCandidate[]; error?: string } {
  if (agentProvider) {
    if (ctx.isProviderDisabled?.(agentProvider)) {
      const known = ctx.listProviderNames?.() ?? candidates.map(c => c.name);
      return {
        candidates: [],
        error:
          `Provider "${agentProvider}" is disabled. Turn it on in Settings, or pick an enabled provider. ` +
          `Available providers: ${known.length ? known.join(', ') : '(none)'}.`,
      };
    }
    const fromRouting = candidates.find(c => c.name === agentProvider);
    const fromRegistry = ctx.resolveProvider?.(agentProvider);
    const match = fromRouting ?? fromRegistry;
    if (!match) {
      const known = ctx.listProviderNames?.() ?? candidates.map(c => c.name);
      return {
        candidates: [],
        error:
          `Provider "${agentProvider}" is not configured or is unavailable. ` +
          `Available providers: ${known.length ? known.join(', ') : '(none)'}. ` +
          `Example: provider: "markus", model: "deepgram/aura-2".`,
      };
    }
    if (typeof match.provider[method] !== 'function') {
      return {
        candidates: [],
        error:
          `Provider "${agentProvider}" does not support this modality (${method}). ` +
          `Pick another provider+model, e.g. provider: "markus" with a suitable model.`,
      };
    }
    return {
      candidates: [{ provider: match.provider, model: agentModel ?? match.model, name: match.name }],
    };
  }
  if (agentModel) {
    return { candidates: candidates.map(c => ({ ...c, model: agentModel })) };
  }
  return { candidates };
}

const PROVIDER_PARAM = {
  type: 'string',
  description:
    'Provider for THIS call (e.g. "markus", "openai", "minimax-cn", "google"). ' +
    'Combine with model= to hit that provider\'s models directly — no need to reconfigure capability routing. ' +
    'Omit to use the capability-routing default provider.',
} as const;
const MODEL_PARAM = {
  type: 'string',
  description:
    'Model id for THIS call on the chosen provider (e.g. "openai/gpt-image-1", "deepgram/aura-2", "tts-1", "whisper-1"). ' +
    'Pass provider+model together for one-shot use. If omitted, uses the capability-routing default model.',
} as const;

const ROUTING_HINT =
  'Retry with provider=... and model=... on this tool call (no need to reconfigure routing). ' +
  'Or call llm_get_capability_routing / llm_list_providers to see options.';

/** Strip legacy `markus/` prefix from agent-supplied model ids. */
function normalizeModelArg(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const id = raw.trim().replace(/^markus\//i, '');
  return id || undefined;
}

function normalizeProviderArg(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const id = raw.trim();
  return id || undefined;
}

function pickCandidates(
  ctx: MultiModalToolsContext,
  capabilityType: ModelCapabilityType,
  method: ModalityMethod,
  args: Record<string, unknown>,
): { candidates: ModalityCandidate[]; error?: string } {
  const all = ctx.resolveCandidates(capabilityType).filter(c => typeof c.provider[method] === 'function');
  return resolveEffectiveCandidates(
    all,
    normalizeProviderArg(args.provider),
    normalizeModelArg(args.model),
    ctx,
    method,
  );
}

/** Read a required non-empty string, accepting a few common aliases. */
function readRequiredString(
  args: Record<string, unknown>,
  field: string,
  aliases: string[] = [],
): string | null {
  for (const key of [field, ...aliases]) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Model-facing error when a required string arg is missing.
 * Upstream Zod ("path: prompt / received undefined") is routinely misread as
 * "wrong parameter name" — spell out that the name is correct and the value was empty.
 */
function missingRequiredStringError(
  toolName: string,
  field: string,
  args: Record<string, unknown>,
  example: Record<string, unknown>,
): string {
  const keys = Object.keys(args).filter(k => args[k] !== undefined && args[k] !== null && args[k] !== '');
  const received = keys.length === 0
    ? 'empty arguments {}'
    : `arguments with keys [${keys.join(', ')}] but no usable "${field}"`;
  return toolErr(
    `Missing required argument "${field}". You called ${toolName} with ${received}. ` +
      `The parameter name "${field}" is correct — do NOT rename it. The value was undefined/empty. ` +
      `Retry with e.g. ${JSON.stringify(example)}.`,
    { received_args: args, required: [field] },
  );
}

export function createMultiModalTools(ctx: MultiModalToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'generate_image',
      description:
        'Generate images. Required: prompt. Recommended: pass provider+model for this call ' +
        '(e.g. provider: "markus", model: "openai/gpt-image-1" or provider: "openai", model: "gpt-image-1") — ' +
        'no need to call llm_set_capability_routing first.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed text description of the image to generate (REQUIRED)' },
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
        const prompt = readRequiredString(args, 'prompt', ['description', 'text', 'image_prompt']);
        if (!prompt) {
          return missingRequiredStringError(
            'generate_image',
            'prompt',
            args,
            { prompt: 'A serious orange cat CEO wearing glasses at a MacBook', provider: 'markus', model: 'openai/gpt-image-1' },
          );
        }

        const { candidates, error: pickErr } = pickCandidates(ctx, 'image_generation', 'generateImage', args);
        if (pickErr) return toolErr(pickErr, { hint: ROUTING_HINT });
        if (candidates.length === 0) {
          return toolErr(
            `No image generation provider configured. Pass provider+model on this call ` +
              `(e.g. provider: "markus", model: "openai/gpt-image-1"), or set capability routing. ${ROUTING_HINT}`,
          );
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
            const results = await provider.generateImage!(prompt, { ...opts, model });
            const images = await Promise.all(results.map((img, idx) => persistImageResult(img, idx)));
            log.info(`Generated ${images.length} image(s) via ${name}/${model ?? provider.model}`, {
              paths: images.map(img => img.filePath),
            });
            return toolOk({
              provider: name,
              model: model ?? provider.model,
              images,
              renderHint: 'Show each image in your reply with its images[].markdown (local path). Do not invent data-URI/base64.',
            });
          } catch (err) {
            lastError = err;
            log.warn(`Image generation via ${name} failed${i < candidates.length - 1 ? ', trying next provider' : ''}: ${err}`);
          }
        }
        const tried = candidates.map(c => c.model ?? c.name).join(', ');
        log.error(`Image generation failed on all ${candidates.length} provider(s)`);
        return toolErr(
          `Image generation failed (tried: ${tried}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          { hint: ROUTING_HINT, tried_models: candidates.map(c => c.model).filter(Boolean) },
        );
      },
    },

    {
      name: 'text_to_speech',
      description:
        'Convert text to speech (synchronous). One HTTP call blocks until the full audio bytes return — ' +
        'there is no async job/poll API. Longer text takes longer (often tens of seconds; client timeout ~3 min). ' +
        'For paragraphs or long narration, split into short sentences/clauses and call this tool multiple times, ' +
        'then use the returned file paths in order. Required: text. Recommended: pass provider+model for this call ' +
        '(e.g. provider: "markus", model: "deepgram/aura-2" or "minimax/speech-2.8-hd") — no routing reconfigure needed. ' +
        'Prefer passing voice for the chosen model; if a voice fails, retry with one listed in the error. ' +
        'LANGUAGE: match the model/voice to the text language. Chinese/Japanese → prefer minimax/speech-2.8-hd, ' +
        'qwen3-tts-flash, or MiniMax Chinese voices. English-only models (e.g. groq orpheus-v1-english) will ' +
        'mispronounce other languages — do not use them for Chinese/Japanese/etc.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'Text to synthesize (REQUIRED). Keep each call short (one sentence or a short clause). ' +
              'Do NOT send long paragraphs in one call — split and call again. Sync: waits until audio is fully generated.',
          },
          provider: PROVIDER_PARAM,
          model: MODEL_PARAM,
          voice: {
            type: 'string',
            description:
              'Voice id for the chosen model (strongly recommended; some upstream APIs require it). ' +
              'Model-specific and language-specific: Deepgram aura-2-thalia-en (English), OpenAI alloy/nova, ' +
              'MiniMax e.g. "Chinese (Mandarin)_Gentle_Youth" for Chinese. Pick a voice that matches the text language. ' +
              'If omitted, a family default may be used when known.',
          },
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
        const text = readRequiredString(args, 'text', ['prompt', 'content', 'input']);
        if (!text) {
          return missingRequiredStringError(
            'text_to_speech',
            'text',
            args,
            { text: 'Hello, this is a speech test.', provider: 'markus', model: 'deepgram/aura-2' },
          );
        }

        const { candidates, error: pickErr } = pickCandidates(ctx, 'audio_tts', 'generateSpeech', args);
        if (pickErr) return toolErr(pickErr, { hint: ROUTING_HINT });
        if (candidates.length === 0) {
          return toolErr(
            `No TTS provider configured. Pass provider+model on this call ` +
              `(e.g. provider: "markus", model: "deepgram/aura-2"), or set capability routing. ${ROUTING_HINT}`,
          );
        }
        const opts = { voice: args.voice as string | undefined, speed: args.speed as number | undefined };
        let lastError: unknown;
        let lastModel: string | undefined;
        for (const { provider, model, name } of candidates) {
          try {
            const result = await provider.generateSpeech!(text, { ...opts, model });
            const filepath = saveTempAudio(result.audio, result.format);
            log.info(`Generated speech via ${name}: ${result.format}, ${result.audio.length} bytes -> ${filepath}`);
            return toolOk({ filePath: filepath, format: result.format, sizeBytes: result.audio.length, durationMs: result.durationMs, provider: name, model: model ?? provider.model });
          } catch (err) {
            lastError = err;
            lastModel = model;
            log.warn(`TTS via ${name}/${model ?? '?'} failed: ${err}`);
          }
        }
        log.error(`TTS failed on all ${candidates.length} provider(s)`);
        const tried = candidates.map(c => c.model ?? c.name).join(', ');
        const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
        const timedOut = /timeout|aborted/i.test(errMsg);
        return toolErr(
          `TTS failed with model "${lastModel ?? tried}": ${errMsg}. ` +
            `Retry text_to_speech with a different model arg (e.g. model: "deepgram/aura-2" or "minimax/speech-2.8-hd") — no routing reconfigure needed.` +
            (timedOut
              ? ' This call is synchronous and timed out waiting for remote synthesis — split the text into shorter chunks and retry.'
              : ''),
          {
            hint: timedOut
              ? 'TTS is sync (blocks until audio returns). Split long text into short segments and call text_to_speech per segment. If the error lists Supported voices, also retry with one of them.'
              : 'If the error lists Supported voices, retry with one of them. Prefer passing an explicit voice for the model.',
            tried_models: candidates.map(c => c.model).filter(Boolean),
          },
        );
      },
    },

    {
      name: 'speech_to_text',
      description:
        'Transcribe speech to text. Required: audio_url. Recommended: pass provider+model for this call ' +
        '(e.g. provider: "markus", model: "deepgram/nova-3" or provider: "openai", model: "whisper-1") — ' +
        'no need to call llm_set_capability_routing first. ' +
        'LANGUAGE: when the audio is not English, pass language as an ISO-639-1 code (e.g. "zh", "ja", "en") ' +
        'so the STT model can decode correctly. Whisper can auto-detect if omitted, but an explicit language is more reliable.',
      inputSchema: {
        type: 'object',
        properties: {
          audio_url: { type: 'string', description: 'URL or local file path of the audio to transcribe (REQUIRED)' },
          provider: PROVIDER_PARAM,
          model: MODEL_PARAM,
          language: {
            type: 'string',
            description:
              'Optional ISO-639-1 language hint for the audio (e.g. "en", "zh", "ja", "ko"). ' +
              'Strongly recommended when the speech is not English.',
          },
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
        const audioUrl = readRequiredString(args, 'audio_url', ['url', 'file_path', 'path', 'file']);
        if (!audioUrl) {
          return missingRequiredStringError(
            'speech_to_text',
            'audio_url',
            args,
            { audio_url: '/path/to/audio.mp3', provider: 'markus', model: 'deepgram/nova-3' },
          );
        }

        const { candidates, error: pickErr } = pickCandidates(ctx, 'audio_stt', 'transcribeSpeech', args);
        if (pickErr) return toolErr(pickErr, { hint: ROUTING_HINT });
        if (candidates.length === 0) {
          return toolErr(
            `No STT provider configured. Pass provider+model on this call ` +
              `(e.g. provider: "markus", model: "deepgram/nova-3"), or set capability routing. ${ROUTING_HINT}`,
          );
        }
        log.info(`Transcribing audio from: ${audioUrl}`);
        let audioBuffer: Buffer;
        try {
          audioBuffer = await fetchAudioBuffer(audioUrl);
        } catch (err) {
          return toolErr(err instanceof Error ? err.message : String(err));
        }
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const { provider, model, name } = candidates[i];
          try {
            const text = await provider.transcribeSpeech!(audioBuffer, { model, language: args.language as string | undefined });
            log.info(`Transcribed audio via ${name}`);
            return toolOk({ text, provider: name, model: model ?? provider.model });
          } catch (err) {
            lastError = err;
            log.warn(`STT via ${name} failed${i < candidates.length - 1 ? ', trying next provider' : ''}: ${err}`);
          }
        }
        const tried = candidates.map(c => c.model ?? c.name).join(', ');
        log.error(`STT failed on all ${candidates.length} provider(s)`);
        return toolErr(
          `STT failed (tried: ${tried}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          { hint: ROUTING_HINT, tried_models: candidates.map(c => c.model).filter(Boolean) },
        );
      },
    },

    {
      name: 'generate_video',
      description:
        'Generate a video. Required: prompt. Recommended: pass provider+model for this call ' +
        '(e.g. provider: "markus", model: "x-ai/grok-imagine-video-1.5") — no need to call llm_set_capability_routing first.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the video to generate (REQUIRED)' },
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
        const prompt = readRequiredString(args, 'prompt', ['description', 'text']);
        if (!prompt) {
          return missingRequiredStringError(
            'generate_video',
            'prompt',
            args,
            { prompt: 'A cat walking through a sunny garden, cinematic', provider: 'markus', model: 'x-ai/grok-imagine-video-1.5' },
          );
        }

        const { candidates, error: pickErr } = pickCandidates(ctx, 'video_generation', 'generateVideo', args);
        if (pickErr) return toolErr(pickErr, { hint: ROUTING_HINT });
        if (candidates.length === 0) {
          return toolErr(
            `No video generation provider configured. Pass provider+model on this call ` +
              `(e.g. provider: "markus", model: "x-ai/grok-imagine-video-1.5"), or set capability routing. ${ROUTING_HINT}`,
          );
        }
        const opts = {
          duration: args.duration as number | undefined,
          size: (args.size ?? args.resolution) as string | undefined,
        };
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const { provider, model, name } = candidates[i];
          try {
            const result = await provider.generateVideo!(prompt, { ...opts, model });
            const persisted = formatVideoToolResult(result);
            log.info(`Video generation via ${name} ${result.status}`, { taskId: result.taskId, filePath: persisted.filePath });
            return toolOk({ ...persisted, provider: name, model: model ?? provider.model });
          } catch (err) {
            lastError = err;
            log.warn(`Video generation via ${name} failed${i < candidates.length - 1 ? ', trying next provider' : ''}: ${err}`);
          }
        }
        const tried = candidates.map(c => c.model ?? c.name).join(', ');
        log.error(`Video generation failed on all ${candidates.length} provider(s)`);
        const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
        const tosBlocked = /403|Terms Of Service|TOS/i.test(errMsg);
        return toolErr(
          `Video generation failed (tried: ${tried}): ${errMsg}` +
            (tosBlocked
              ? ' This is often an OpenRouter provider/privacy policy block or content TOS denial — retry with a different model (e.g. x-ai/grok-imagine-video-1.5 or openai/sora-*), or check https://openrouter.ai/settings/privacy.'
              : ''),
          {
            hint: tosBlocked
              ? 'HTTP 403 TOS: try another video model, soften the prompt, or enable the provider in OpenRouter privacy settings. Do not stop the whole task — continue other pending steps.'
              : ROUTING_HINT,
            tried_models: candidates.map(c => c.model).filter(Boolean),
          },
        );
      },
    },
  ];
}
