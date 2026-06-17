import type { ProviderCapabilities } from '@markus/shared';
import type { ImageGenOptions, ImageResult, TTSOptions, AudioResult, VideoGenOptions, VideoResult, MultiModalToolSchemas } from './provider.js';
import { OpenAIProvider } from './openai.js';

/**
 * MiniMax provider – extends OpenAIProvider for chat/streaming (OpenAI-compatible)
 * but overrides multimodal methods that use MiniMax-specific endpoints and formats:
 *
 *   Image:  POST /v1/image_generation
 *   TTS:    POST /v1/t2a_v2
 *   Video:  POST /v1/video_generation  (async, poll /v1/query/video_generation)
 *
 * MiniMax does NOT expose a public STT (ASR) API.
 */
export class MiniMaxProvider extends OpenAIProvider {

  override getCapabilities(): ProviderCapabilities {
    return {
      chat: true,
      vision: true,
      imageGeneration: true,
      tts: true,
      stt: false,
      videoGeneration: true,
      embedding: false,
      reasoning: true,
      promptCaching: true,
    };
  }

  override getToolSchemas(): MultiModalToolSchemas {
    return {
      generate_image: {
        description: 'Generate images using MiniMax. Provide a detailed text prompt and choose an aspect ratio.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed text description of the image to generate' },
            model: { type: 'string', description: 'Model to use (default from routing config). e.g. "image-01"' },
            aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'], description: 'Image aspect ratio (default: 1:1)' },
            n: { type: 'number', description: 'Number of images to generate (default: 1)' },
            output_dir: { type: 'string', description: 'Directory to save images' },
          },
          required: ['prompt'],
        },
      },
      text_to_speech: {
        description: 'Convert text to speech using MiniMax. Supports Chinese and English voices.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to convert to speech' },
            model: { type: 'string', description: 'Model to use (default from routing config). e.g. "speech-02-hd"' },
            voice: { type: 'string', description: 'Voice ID. Chinese: "Chinese (Mandarin)_Gentle_Youth", "Chinese (Mandarin)_Sweet_Lady", "Chinese (Mandarin)_Gentleman", "Chinese (Mandarin)_Warm_Bestie". English: "English_CalmWoman", "English_Trustworth_Man", "English_Gentle-voiced_man"' },
            speed: { type: 'number', description: 'Speech speed (0.5-2.0, default: 1.0)' },
          },
          required: ['text'],
        },
      },
      generate_video: {
        description: 'Generate video using MiniMax Hailuo. IMPORTANT: For text-to-video, you MUST set model to "MiniMax-Hailuo-2.3". The model "MiniMax-Hailuo-2.3-Fast" only supports image-to-video and will fail for text prompts.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed description of the video to generate' },
            model: { type: 'string', enum: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast'], description: 'Model to use. "MiniMax-Hailuo-2.3" for text-to-video, "MiniMax-Hailuo-2.3-Fast" for image-to-video only. Default from routing config if not specified.' },
            duration: { type: 'number', enum: [6, 10], description: 'Video duration in seconds (default: 6)' },
            resolution: { type: 'string', enum: ['768P', '1080P'], description: 'Video resolution (default: 768P)' },
          },
          required: ['prompt'],
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Image generation – /v1/image_generation
  // ---------------------------------------------------------------------------

  override async generateImage(prompt: string, options?: ImageGenOptions): Promise<ImageResult[]> {
    const endpoint = this.buildEndpoint('/image_generation');
    const authorization = await this.resolveAuthHeader();

    const body: Record<string, unknown> = {
      model: options?.model ?? 'image-01',
      prompt,
      n: options?.n ?? 1,
      response_format: 'url',
    };

    if (options?.size) {
      body['aspect_ratio'] = sizeToAspectRatio(options.size);
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`MiniMax image generation API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      data?: { image_urls?: string[]; image_base64?: string[] };
      metadata?: { success_count?: number; failed_count?: number };
      base_resp?: { status_code: number; status_msg: string };
    };
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax image generation error: ${data.base_resp.status_msg}`);
    }

    const urls = data.data?.image_urls ?? [];
    const b64s = data.data?.image_base64 ?? [];
    const count = Math.max(urls.length, b64s.length);
    const results: ImageResult[] = [];
    for (let i = 0; i < count; i++) {
      results.push({ url: urls[i], base64: b64s[i] });
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // TTS – /v1/t2a_v2 (non-streaming, hex-encoded audio)
  // ---------------------------------------------------------------------------

  override async generateSpeech(text: string, options?: TTSOptions): Promise<AudioResult> {
    const endpoint = this.buildEndpoint('/t2a_v2');
    const authorization = await this.resolveAuthHeader();

    const format = options?.responseFormat ?? 'mp3';
    const body: Record<string, unknown> = {
      model: options?.model ?? 'speech-02-hd',
      text,
      stream: false,
      voice_setting: {
        voice_id: options?.voice ?? 'Chinese (Mandarin)_Gentle_Youth',
        speed: options?.speed ?? 1.0,
      },
      audio_setting: { format },
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`MiniMax TTS API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      data?: { audio?: string; status?: number };
      extra_info?: { audio_format?: string };
      base_resp?: { status_code: number; status_msg: string };
    };
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax TTS error: ${data.base_resp.status_msg}`);
    }

    const hexAudio = data.data?.audio;
    if (!hexAudio) {
      throw new Error('MiniMax TTS returned no audio data');
    }

    return {
      audio: Buffer.from(hexAudio, 'hex'),
      format: data.extra_info?.audio_format ?? format,
    };
  }

  // ---------------------------------------------------------------------------
  // Video generation – /v1/video_generation (async with polling)
  // ---------------------------------------------------------------------------

  async generateVideo(prompt: string, options?: VideoGenOptions): Promise<VideoResult> {
    const authorization = await this.resolveAuthHeader();

    const body: Record<string, unknown> = {
      model: options?.model ?? 'MiniMax-Hailuo-2.3',
      prompt,
    };
    if (options?.duration) body['duration'] = options.duration;
    if (options?.size) body['resolution'] = sizeToResolution(options.size);

    const createEndpoint = this.buildEndpoint('/video_generation');
    const createRes = await fetch(createEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`MiniMax video generation API error ${createRes.status}: ${errText}`);
    }

    const createData = await createRes.json() as {
      task_id?: string;
      base_resp?: { status_code: number; status_msg: string };
    };
    if (createData.base_resp && createData.base_resp.status_code !== 0) {
      throw new Error(`MiniMax video generation error: ${createData.base_resp.status_msg}`);
    }
    const taskId = createData.task_id;
    if (!taskId) {
      throw new Error('MiniMax video generation returned no task_id');
    }

    const queryBase = this.buildEndpoint('/query/video_generation');
    const maxAttempts = 120;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(5_000);

      const queryRes = await fetch(`${queryBase}?task_id=${taskId}`, {
        method: 'GET',
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(15_000),
      });

      if (!queryRes.ok) continue;

      const queryData = await queryRes.json() as {
        status?: string;
        file_id?: string;
        base_resp?: { status_code: number; status_msg: string };
      };

      if (queryData.status === 'Success' && queryData.file_id) {
        const fileEndpoint = this.buildEndpoint('/files/retrieve');
        const fileRes = await fetch(`${fileEndpoint}?file_id=${queryData.file_id}`, {
          method: 'GET',
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(15_000),
        });

        if (fileRes.ok) {
          const fileData = await fileRes.json() as {
            file?: { download_url?: string };
          };
          return {
            url: fileData.file?.download_url,
            taskId,
            status: 'completed',
          };
        }
        return { taskId, status: 'completed' };
      }

      if (queryData.status === 'Fail') {
        throw new Error(`MiniMax video generation failed: ${queryData.base_resp?.status_msg ?? 'unknown error'}`);
      }
    }

    return { taskId, status: 'processing' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sizeToResolution(size: string): string {
  const s = size.trim().toLowerCase();
  if (s === '768p' || s === '1080p') return size.toUpperCase();
  const m = s.match(/^(\d+)x(\d+)$/);
  if (m) {
    const h = parseInt(m[2], 10);
    return h >= 1080 ? '1080P' : '768P';
  }
  return '768P';
}

const VALID_ASPECT_RATIOS = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'] as const;

function sizeToAspectRatio(size: string): string {
  // If already a valid ratio string, use it directly
  if (VALID_ASPECT_RATIOS.includes(size as typeof VALID_ASPECT_RATIOS[number])) {
    return size;
  }
  // Parse WxH pixel dimensions and find the closest valid aspect ratio
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return '1:1';
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  const target = w / h;
  let best: string = VALID_ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const ratio of VALID_ASPECT_RATIOS) {
    const [rw, rh] = ratio.split(':').map(Number);
    const diff = Math.abs(rw / rh - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ratio;
    }
  }
  return best;
}
