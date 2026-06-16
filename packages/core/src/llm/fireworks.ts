import type { ImageGenOptions, ImageResult } from './provider.js';
import { OpenAIProvider } from './openai.js';

/**
 * Fireworks AI provider – extends OpenAIProvider for chat (OpenAI-compatible)
 * but overrides image generation because Fireworks returns a non-standard format:
 *
 *   Response: { id, base64: ["data:image/png;base64,..."], finishReason, seed }
 *
 * instead of the OpenAI-standard { data: [{ url, b64_json }] }.
 */
export class FireworksProvider extends OpenAIProvider {

  override async generateImage(prompt: string, options?: ImageGenOptions): Promise<ImageResult[]> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const authorization = await this.resolveAuthHeader();
    const endpoint = /\/v\d+$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;

    const body: Record<string, unknown> = {
      model: options?.model ?? 'accounts/fireworks/models/stable-diffusion-xl-1024-v1-0',
      prompt,
      n: options?.n ?? 1,
      cfg_scale: 7,
      height: 1024,
      width: 1024,
      steps: 30,
      safety_check: false,
    };

    if (options?.size) {
      const m = options.size.match(/^(\d+)x(\d+)$/);
      if (m) {
        body['width'] = parseInt(m[1], 10);
        body['height'] = parseInt(m[2], 10);
      }
    }
    if (options?.seed !== undefined) body['seed'] = options.seed;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Fireworks image generation API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      data?: Array<{ url?: string; b64_json?: string }>;
      base64?: string[];
      finishReason?: string;
    };

    if (data.data && data.data.length > 0) {
      return data.data.map(d => ({ url: d.url, base64: d.b64_json }));
    }

    if (data.base64 && data.base64.length > 0) {
      return data.base64.map(dataUri => {
        const m = dataUri.match(/^data:[^;]+;base64,(.+)$/);
        return { base64: m ? m[1] : dataUri };
      });
    }

    return [];
  }
}
