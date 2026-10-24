import { createLogger } from '@markus/shared';

const log = createLogger('token-counter');

export interface TokenCounter {
  countTokens(text: string): number;
  countMessageTokens(content: string, role?: string): number;
  /**
   * Which path produced the most recent number.
   *
   * Diagnostic, not behaviour: the budget math is only as good as the counter,
   * and "the estimate moved between restarts" is otherwise indistinguishable
   * from "the content changed". Recording the path turns a guess into a fact.
   */
  mode?(): 'tiktoken' | 'heuristic';
}

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3100-\u312f\u31a0-\u31bf\ufe30-\ufe4f]/g;

function cjkRatio(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(CJK_RANGE);
  return matches ? matches.length / text.length : 0;
}

type TiktokenEncoding = { encode: (text: string) => number[] | Uint32Array; free?: () => void };

const tiktokenCache: Map<string, TiktokenEncoding> = new Map();

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

  /** Path used by the most recent count (see `mode()`). */
  private lastMode: 'tiktoken' | 'heuristic' = 'heuristic';

  mode(): 'tiktoken' | 'heuristic' {
    return this.lastMode;
  }
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

  /**
   * P1-9：按当前生效模型惰性解析编码器。
   *
   * 以前只在 `setActiveModel()` 里预加载到单一 `tiktokenEncoder` 槽；流式路径
   * 从未调 `setActiveModel`，于是沿用上一个模型/编码器（跨 agent 串扰）。这里在
   * 计数时刻按 `activeModel` 回查模块级 `tiktokenCache`（按 encoding 名缓存，安全），
   * 保证即使未预加载也不会用错编码器。
   */
  private resolveEncoder(): TiktokenEncoding | null {
    if (this.tiktokenEncoder) return this.tiktokenEncoder;
    const encoding = getTiktokenEncodingName(this.activeModel);
    if (!encoding) return null;
    const cached = tiktokenCache.get(encoding);
    if (cached) {
      this.tiktokenEncoder = cached;
      return cached;
    }
    return null;
  }

  countTokens(text: string): number {
    const enc = this.resolveEncoder();
    if (enc) {
      try {
        const n = enc.encode(text).length;
        this.lastMode = 'tiktoken';
        return n;
      } catch {
        // fall through to heuristic
      }
    }
    return this.heuristicCount(text);
  }

  countMessageTokens(content: string, role?: string): number {
    const overhead = 20;
    const enc = this.resolveEncoder();
    if (enc) {
      try {
        const n = enc.encode(content).length + overhead;
        this.lastMode = 'tiktoken';
        return n;
      } catch {
        // fall through
      }
    }
    this.lastMode = 'heuristic';
    let chars = content.length + overhead;
    if (role === 'assistant') chars += 5;
    const ratio = cjkRatio(content);
    const charsPerToken = 4 - ratio * 2.5;
    const raw = Math.ceil(chars / charsPerToken);
    return raw;
  }

  private heuristicCount(text: string): number {
    this.lastMode = 'heuristic';
    const ratio = cjkRatio(text);
    const charsPerToken = 4 - ratio * 2.5;
    const raw = Math.ceil(text.length / charsPerToken);
    return raw;
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


  getActiveModel(): string {
    return this.activeModel;
  }
}

let defaultCounter: SmartTokenCounter | null = null;
/**
 * P1-9 / P1-10：最近一次 `initTokenCounter` 的配置。
 * 作为「建造新计数器实例」的默认值，让每个 agent 拥有**独立**计数器（不共享
 * `activeModel` / 编码器），同时保留锚定 Anthropic 精确计数所需的凭据。
 */
let counterDefaults: { anthropicApiKey?: string; anthropicBaseUrl?: string } = {};

export function getDefaultTokenCounter(): SmartTokenCounter {
  if (!defaultCounter) {
    defaultCounter = new SmartTokenCounter(counterDefaults);
  }
  return defaultCounter;
}

export function initTokenCounter(opts: { anthropicApiKey?: string; anthropicBaseUrl?: string }): SmartTokenCounter {
  counterDefaults = { ...opts };
  defaultCounter = new SmartTokenCounter(opts);
  return defaultCounter;
}

/**
 * P1-9：为单个 agent / 请求创建一个**独立**的计数器实例，避免进程级单例的
 * `activeModel` + 编码器槽被并发 agent 相互覆盖（跨 agent 串扰）。新实例继承
 * 最近一次 `initTokenCounter` 写入的配置（如 Anthropic key，用于精确计数）。
 */
export function createTokenCounter(opts?: { anthropicApiKey?: string; anthropicBaseUrl?: string }): SmartTokenCounter {
  return new SmartTokenCounter({ ...counterDefaults, ...opts });
}

/** P1-10：当前是否已启用 Anthropic 精确计数（供启动期自检/健康检查）。 */
export function isAnthropicTokenCounterEnabled(): boolean {
  return Boolean(counterDefaults.anthropicApiKey);
}
