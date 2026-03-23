import { createLogger } from '@markus/shared';

const log = createLogger('token-counter');

export interface TokenCounter {
  countTokens(text: string): number;
  countMessageTokens(content: string, role?: string): number;
}

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3100-\u312f\u31a0-\u31bf\ufe30-\ufe4f]/g;

function cjkRatio(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(CJK_RANGE);
  return matches ? matches.length / text.length : 0;
}

type TiktokenEncoding = { encode: (text: string) => number[] | Uint32Array; free?: () => void };

let tiktokenCache: Map<string, TiktokenEncoding> = new Map();

async function loadTiktokenEncoding(encoding: string): Promise<TiktokenEncoding | null> {
  if (tiktokenCache.has(encoding)) return tiktokenCache.get(encoding)!;
  try {
    const { getEncoding } = await import('js-tiktoken');
    const enc = getEncoding(encoding as any);
    tiktokenCache.set(encoding, enc);
    return enc;
  } catch (err) {
    log.debug('Failed to load tiktoken encoding, using heuristic', { encoding, error: String(err) });
    return null;
  }
}

function getTiktokenEncodingName(model: string): string | null {
  if (model.startsWith('gpt-4o') || model.startsWith('gpt-4-turbo') || model.startsWith('gpt-5') || model.startsWith('o4') || model.startsWith('o3')) {
    return 'o200k_base';
  }
  if (model.startsWith('gpt-4') || model.startsWith('gpt-3.5')) {
    return 'cl100k_base';
  }
  return null;
}

/**
 * Adaptive token counter with model-specific support:
 * 1. js-tiktoken for OpenAI models (exact)
 * 2. Anthropic Token Counting API for Claude (exact, async)
 * 3. Calibrated heuristic fallback for all others
 */
export class SmartTokenCounter implements TokenCounter {
  private calibrationSamples: Array<{ estimated: number; actual: number }> = [];
  private calibrationFactor = 1.0;
  private anthropicApiKey?: string;
  private anthropicBaseUrl: string;
  private activeModel = '';
  private tiktokenEncoder: TiktokenEncoding | null = null;
  private tiktokenLoading = false;

  constructor(opts?: { anthropicApiKey?: string; anthropicBaseUrl?: string }) {
    this.anthropicApiKey = opts?.anthropicApiKey;
    this.anthropicBaseUrl = opts?.anthropicBaseUrl ?? 'https://api.anthropic.com';
  }

  private tiktokenLoadPromise: Promise<void> | null = null;

  setActiveModel(model: string): void {
    if (model === this.activeModel) return;
    this.activeModel = model;
    this.tiktokenEncoder = null;
    this.tiktokenLoadPromise = null;

    const encoding = getTiktokenEncodingName(model);
    if (encoding) {
      const cached = tiktokenCache.get(encoding);
      if (cached) {
        this.tiktokenEncoder = cached;
      } else if (!this.tiktokenLoading) {
        this.tiktokenLoadPromise = this.loadEncoderAsync(model, encoding);
      }
    }
  }

  /**
   * Wait for the tiktoken encoder to finish loading.
   * Call this at agent startup to avoid first-call heuristic fallback.
   */
  async ensureReady(): Promise<void> {
    if (this.tiktokenLoadPromise) {
      await this.tiktokenLoadPromise;
    }
  }

  private async loadEncoderAsync(model: string, encoding: string): Promise<void> {
    this.tiktokenLoading = true;
    try {
      const enc = await loadTiktokenEncoding(encoding);
      if (enc && this.activeModel === model) {
        this.tiktokenEncoder = enc;
      }
    } catch {
      // heuristic fallback
    } finally {
      this.tiktokenLoading = false;
    }
  }

  countTokens(text: string): number {
    if (this.tiktokenEncoder) {
      try {
        return this.tiktokenEncoder.encode(text).length;
      } catch {
        // fall through to heuristic
      }
    }
    return this.heuristicCount(text);
  }

  countMessageTokens(content: string, role?: string): number {
    const overhead = 20;
    if (this.tiktokenEncoder) {
      try {
        return this.tiktokenEncoder.encode(content).length + overhead;
      } catch {
        // fall through
      }
    }
    let chars = content.length + overhead;
    if (role === 'assistant') chars += 5;
    const ratio = cjkRatio(content);
    const charsPerToken = 4 - ratio * 2.5;
    const raw = Math.ceil(chars / charsPerToken);
    return Math.ceil(raw * this.calibrationFactor);
  }

  private heuristicCount(text: string): number {
    const ratio = cjkRatio(text);
    const charsPerToken = 4 - ratio * 2.5;
    const raw = Math.ceil(text.length / charsPerToken);
    return Math.ceil(raw * this.calibrationFactor);
  }

  /**
   * Use Anthropic's Token Counting API for exact pre-flight count.
   * Only available for Claude models. Returns null if unavailable.
   */
  async countTokensViaAPI(
    messages: Array<{ role: string; content: string }>,
    model: string,
  ): Promise<number | null> {
    if (!this.anthropicApiKey || !model.startsWith('claude')) return null;

    try {
      const resp = await fetch(`${this.anthropicBaseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, messages }),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { input_tokens?: number };
      return data.input_tokens ?? null;
    } catch (err) {
      log.debug('Anthropic token counting API failed, using local estimate', { error: String(err) });
      return null;
    }
  }

  /**
   * Feed actual API-returned token counts to calibrate the heuristic.
   * Call this after every LLM response with the estimated vs actual values.
   */
  calibrate(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    // Skip calibration when using tiktoken (already exact)
    if (this.tiktokenEncoder) return;

    this.calibrationSamples.push({ estimated, actual });
    if (this.calibrationSamples.length > 50) {
      this.calibrationSamples.shift();
    }

    let sumRatio = 0;
    for (const s of this.calibrationSamples) {
      sumRatio += s.actual / s.estimated;
    }
    this.calibrationFactor = sumRatio / this.calibrationSamples.length;

    if (this.calibrationFactor < 0.5) this.calibrationFactor = 0.5;
    if (this.calibrationFactor > 2.0) this.calibrationFactor = 2.0;

    if (this.calibrationSamples.length % 10 === 0) {
      log.debug('Token counter calibration updated', {
        factor: this.calibrationFactor.toFixed(3),
        samples: this.calibrationSamples.length,
        model: this.activeModel,
      });
    }
  }

  getCalibrationFactor(): number {
    return this.calibrationFactor;
  }

  getActiveModel(): string {
    return this.activeModel;
  }
}

let defaultCounter: SmartTokenCounter | null = null;

export function getDefaultTokenCounter(): SmartTokenCounter {
  if (!defaultCounter) {
    defaultCounter = new SmartTokenCounter();
  }
  return defaultCounter;
}

export function initTokenCounter(opts: { anthropicApiKey?: string; anthropicBaseUrl?: string }): SmartTokenCounter {
  defaultCounter = new SmartTokenCounter(opts);
  return defaultCounter;
}
