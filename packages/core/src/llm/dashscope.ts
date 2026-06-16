import type { ProviderCapabilities } from '@markus/shared';
import type { ImageGenOptions, ImageResult, TTSOptions, AudioResult } from './provider.js';
import { OpenAIProvider } from './openai.js';

/**
 * DashScope (Alibaba/Qwen) provider – extends OpenAIProvider for chat
 * (compatible-mode is OpenAI-compatible) but overrides multimodal methods
 * that use DashScope-specific endpoints and request formats:
 *
 *   Image:  POST /api/v1/services/aigc/multimodal-generation/generation
 *           Request: { model, input: { messages: [{ role: "user", content: [{ text }] }] }, parameters: { size, n, ... } }
 *           Response: { output: { choices: [{ message: { content: [{ image: url }] } }] } }
 *
 *   TTS:    POST /api/v1/services/aigc/multimodal-generation/generation  (Qwen-TTS models)
 *           Request: { model, input: { text, voice, format, ... } }
 *           Response: { output: { audio: { url } } }
 *
 * Note: DashScope's compatible-mode baseUrl is /compatible-mode/v1 for chat;
 * multimodal uses /api/v1 on the same host.
 */
export class DashScopeProvider extends OpenAIProvider {

  override getCapabilities(): ProviderCapabilities {
    return {
      chat: true,
      vision: true,
      imageGeneration: true,
      tts: true,
      stt: false,
      videoGeneration: false,
      embedding: true,
      reasoning: true,
      promptCaching: true,
    };
  }

  /**
   * Derive the DashScope native API base from the compatible-mode baseUrl.
   * e.g. https://dashscope.aliyuncs.com/compatible-mode/v1  →  https://dashscope.aliyuncs.com/api/v1
   *      https://dashscope-intl.aliyuncs.com/compatible-mode/v1  →  https://dashscope-intl.aliyuncs.com/api/v1
   */
  private get nativeApiBase(): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    return base.replace('/compatible-mode/v1', '/api/v1');
  }

  // ---------------------------------------------------------------------------
  // Image generation – /api/v1/services/aigc/multimodal-generation/generation
  // ---------------------------------------------------------------------------

  override async generateImage(prompt: string, options?: ImageGenOptions): Promise<ImageResult[]> {
    const endpoint = `${this.nativeApiBase}/services/aigc/multimodal-generation/generation`;
    const authorization = await this.resolveAuthHeader();

    const parameters: Record<string, unknown> = {
      prompt_extend: true,
      watermark: false,
    };
    if (options?.size) {
      parameters['size'] = options.size.replace('x', '*');
    }
    if (options?.n) parameters['n'] = options.n;
    if (options?.negative_prompt) parameters['negative_prompt'] = options.negative_prompt;
    if (options?.seed !== undefined) parameters['seed'] = options.seed;

    const body = {
      model: options?.model ?? 'qwen-image-2.0-pro',
      input: {
        messages: [{ role: 'user', content: [{ text: prompt }] }],
      },
      parameters,
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DashScope image generation API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      output?: {
        choices?: Array<{
          message?: { content?: Array<{ image?: string }> };
        }>;
      };
      code?: string;
      message?: string;
    };

    if (data.code) {
      throw new Error(`DashScope image generation error: ${data.code} - ${data.message}`);
    }

    const choices = data.output?.choices ?? [];
    const results: ImageResult[] = [];
    for (const choice of choices) {
      for (const part of choice.message?.content ?? []) {
        if (part.image) {
          results.push({ url: part.image });
        }
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // TTS – /api/v1/services/aigc/multimodal-generation/generation (Qwen-TTS)
  //       Non-streaming: returns { output: { audio: { url } } }
  // ---------------------------------------------------------------------------

  override async generateSpeech(text: string, options?: TTSOptions): Promise<AudioResult> {
    const endpoint = `${this.nativeApiBase}/services/aigc/multimodal-generation/generation`;
    const authorization = await this.resolveAuthHeader();

    const format = options?.responseFormat ?? 'mp3';
    const body = {
      model: options?.model ?? 'qwen3-tts-flash',
      input: {
        text,
        voice: options?.voice ?? 'Cherry',
        format,
      },
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DashScope TTS API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      output?: { audio?: { url?: string } };
      code?: string;
      message?: string;
    };

    if (data.code) {
      throw new Error(`DashScope TTS error: ${data.code} - ${data.message}`);
    }

    const audioUrl = data.output?.audio?.url;
    if (!audioUrl) {
      throw new Error('DashScope TTS returned no audio URL');
    }

    const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
    if (!audioRes.ok) {
      throw new Error(`Failed to download DashScope TTS audio: ${audioRes.status}`);
    }

    const arrayBuf = await audioRes.arrayBuffer();
    return { audio: Buffer.from(arrayBuf), format };
  }
}
