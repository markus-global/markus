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

/**
 * Adaptive heuristic token counter that adjusts chars/token ratio based on
 * CJK character density. Optionally calibrated by real API usage data.
 *
 * Accuracy hierarchy (used when available):
 * 1. API-returned actual token counts (post-request, already captured in LLMResponse.usage)
 * 2. Anthropic Token Counting API (pre-request, via countTokensViaAPI)
 * 3. This local heuristic (pre-request, synchronous fallback)
 *
 * The calibration feedback loop uses actual API values to continuously
 * improve the heuristic coefficients.
 */
export class SmartTokenCounter implements TokenCounter {
  private calibrationSamples: Array<{ estimated: number; actual: number }> = [];
  private calibrationFactor = 1.0;
  private anthropicApiKey?: string;
  private anthropicBaseUrl: string;

  constructor(opts?: { anthropicApiKey?: string; anthropicBaseUrl?: string }) {
    this.anthropicApiKey = opts?.anthropicApiKey;
    this.anthropicBaseUrl = opts?.anthropicBaseUrl ?? 'https://api.anthropic.com';
  }

  countTokens(text: string): number {
    const ratio = cjkRatio(text);
    // Pure English: ~4 chars/token; Pure CJK: ~1.5 chars/token
    const charsPerToken = 4 - ratio * 2.5;
    const raw = Math.ceil(text.length / charsPerToken);
    return Math.ceil(raw * this.calibrationFactor);
  }

  countMessageTokens(content: string, role?: string): number {
    const overhead = 20; // role/framing tokens
    let chars = content.length + overhead;
    if (role === 'assistant') chars += 5;
    const ratio = cjkRatio(content);
    const charsPerToken = 4 - ratio * 2.5;
    const raw = Math.ceil(chars / charsPerToken);
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

    this.calibrationSamples.push({ estimated, actual });
    // Keep last 50 samples
    if (this.calibrationSamples.length > 50) {
      this.calibrationSamples.shift();
    }

    // Recalculate calibration factor: actual/estimated ratio
    let sumRatio = 0;
    for (const s of this.calibrationSamples) {
      sumRatio += s.actual / s.estimated;
    }
    this.calibrationFactor = sumRatio / this.calibrationSamples.length;

    // Clamp to reasonable range
    if (this.calibrationFactor < 0.5) this.calibrationFactor = 0.5;
    if (this.calibrationFactor > 2.0) this.calibrationFactor = 2.0;

    if (this.calibrationSamples.length % 10 === 0) {
      log.debug('Token counter calibration updated', {
        factor: this.calibrationFactor.toFixed(3),
        samples: this.calibrationSamples.length,
      });
    }
  }

  getCalibrationFactor(): number {
    return this.calibrationFactor;
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
