/**
 * Provider model discovery — the single source of truth for
 * "which models does this provider actually serve right now".
 *
 * Why this file exists: the model-list URL, the auth headers and the payload
 * parsing used to be re-implemented in several places
 * (`LLMRouter.refreshProviderLiveModels`, org-manager `validateProviderKey`,
 * the web-ui quick-setup). The copies drifted, and two of them hard-coded
 * `` `${base}/v1/models` `` — which produces `/v1/v1/models` for every base URL
 * that already ends in a version segment (`https://api.example.com/v1`,
 * Groq's `/openai/v1`, ZAI's `/api/paas/v4`, DashScope's
 * `/compatible-mode/v1`, Google's `/v1beta`). Those requests 404 and the model
 * picker ends up empty, which in turn pushed people back onto hard-coded model
 * ids.
 *
 * The rule we follow instead: ask the provider. Every OpenAI-compatible
 * provider exposes a model-list endpoint reachable from its base URL; native
 * providers (Anthropic, Google, Ollama) have their own. We never guess ids.
 */

/** Anthropic requires an explicit API version header on every request. */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Default base URLs per provider. This mirrors the official documentation of
 * each provider and is the fallback used when the user did not configure an
 * explicit `baseUrl`. Kept here (not in the UI) so every consumer agrees.
 */
export const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  siliconflow: 'https://api.siliconflow.cn/v1',
  'siliconflow-intl': 'https://api.siliconflow.com/v1',
  minimax: 'https://api.minimax.io/v1',
  'minimax-cn': 'https://api.minimaxi.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  zai: 'https://api.z.ai/api/paas/v4',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  perplexity: 'https://api.perplexity.ai',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  together_ai: 'https://api.together.xyz/v1',
  'together-ai': 'https://api.together.xyz/v1',
  fireworks_ai: 'https://api.fireworks.ai/inference/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  ollama: 'http://localhost:11434',
};

/** One model as reported by the provider's own model-list endpoint. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Provider advertises image input. */
  vision?: boolean;
  /** Provider advertises reasoning/thinking output. */
  reasoning?: boolean;
  created?: number;
  ownedBy?: string;
}

export interface DiscoverProviderModelsOptions {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Trailing slashes are irrelevant and break naive concatenation. */
export function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * Last path segment looks like an API version (`/v1`, `/v1beta`, `/v4`,
 * `/v3`). Those bases already contain the version, so `/models` is appended
 * directly; anything else gets `/v1` first (OpenAI-compatible convention).
 */
const VERSION_SEGMENT_RE = /\/v\d+[a-z]*$/i;

/** Ollama's OpenAI shim lives under `/v1` but its model list is `/api/tags`. */
const OLLAMA_TAGS_PATH = '/api/tags';

/**
 * Resolve the model-list endpoint for a provider.
 *
 * @throws when no base URL is known — callers should skip discovery instead of
 *         inventing a host.
 */
export function buildModelsEndpoint(baseUrl: string, provider?: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('buildModelsEndpoint: baseUrl is required');
  const p = (provider ?? '').toLowerCase();

  if (p === 'ollama') {
    // Ollama exposes models at /api/tags (there is no /v1/models endpoint).
    return `${base.replace(VERSION_SEGMENT_RE, '')}${OLLAMA_TAGS_PATH}`;
  }
  // Already a full models URL.
  if (/\/models$/i.test(base)) return base;
  return VERSION_SEGMENT_RE.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Build the auth headers for a provider's model-list endpoint.
 *
 * Anthropic uses `x-api-key` (never `Bearer`); Google prefers `x-goog-api-key`
 * over `?key=` so the key never lands in a URL, access log or referrer;
 * Azure-style gateways use `api-key`. Everything else is Bearer.
 */
export function buildModelsAuthHeaders(
  provider: string | undefined,
  apiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = (apiKey ?? '').trim();
  if (!key) return headers;
  const p = (provider ?? '').toLowerCase();
  if (p === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    return headers;
  }
  if (p === 'google' || p === 'gemini' || p === 'vertex_ai' || p === 'vertex-ai') {
    headers['x-goog-api-key'] = key;
    return headers;
  }
  if (p === 'azure' || p === 'azure_openai' || p === 'azure-openai') {
    headers['api-key'] = key;
    return headers;
  }
  headers['Authorization'] = `Bearer ${key}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/** Gemini prefixes ids with `models/`; the wire name is what callers must use. */
function stripModelsPrefix(id: string): string {
  return id.replace(/^models\//, '');
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string') {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

/**
 * True when a model id is a *conversational* model worth showing/using.
 *
 * Only clearly non-conversational utility endpoints are dropped
 * (moderation, embeddings, rerank/similarity). Image / TTS / STT / video ids
 * are deliberately KEPT — multimodal routing needs them, and they are
 * discoverable from the very same list.
 *
 * Implemented with plain substring matching on purpose: the previous
 * `\b(embed|rerank)\b` style regex silently failed to match the real ids
 * (`text-embedding-3-small`, `bge-reranker-v2`), so utility models leaked into
 * the chat picker.
 */
const NON_CONVERSATIONAL_MODEL_RE = /moderat|embed|rerank|reranker|text-similarity|text-search/i;

export function isUsableProviderModelId(id: string): boolean {
  const v = (id ?? '').trim().toLowerCase();
  if (!v) return false;
  return !NON_CONVERSATIONAL_MODEL_RE.test(v);
}

/** Normalize one raw list entry into a DiscoveredModel (or drop it). */
function normalizeModelEntry(raw: unknown): DiscoveredModel | null {
  if (typeof raw === 'string') {
    const id = stripModelsPrefix(raw.trim());
    return id ? { id } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const rawId = firstString(o['id'], o['name'], o['model'], o['model_id'], o['modelId']);
  if (!rawId) return null;
  const id = stripModelsPrefix(rawId);
  if (!id) return null;

  const arch = (o['architecture'] ?? {}) as Record<string, unknown>;
  const modalities = [
    ...toArray(arch['input_modalities']),
    ...toArray(o['input_modalities']),
    ...toArray(arch['modality']),
  ].map(String);
  const capsArr = toArray(o['capabilities']).map(String);
  const capsObj = (o['capabilities'] ?? {}) as Record<string, unknown>;
  const supportedParams = toArray(o['supported_parameters']).map(String);
  const flagged = (key: string): boolean =>
    capsObj[key] === true || capsArr.includes(key) || o[key] === true;

  const vision =
    modalities.includes('image') ||
    modalities.includes('vision') ||
    flagged('vision');
  const reasoning =
    flagged('reasoning') || flagged('thinking') || supportedParams.includes('reasoning');

  return {
    id,
    name: firstString(o['display_name'], o['displayName'], o['displayName' as never], o['title']),
    // OpenRouter: context_length; Gemini: inputTokenLimit; vLLM: max_model_len;
    // generic OpenAI-compatible gateways: context_window / max_context_length.
    contextWindow: firstPositiveNumber(
      o['context_window'],
      o['context_length'],
      o['max_model_len'],
      o['max_context_length'],
      o['inputTokenLimit'],
      o['context'],
    ),
    maxOutputTokens: firstPositiveNumber(
      o['max_output_tokens'],
      o['max_tokens'],
      o['max_tokens_out'],
      o['outputTokenLimit'],
    ),
    vision: vision || undefined,
    reasoning: reasoning || undefined,
    created: typeof o['created'] === 'number' ? (o['created'] as number) : undefined,
    ownedBy: firstString(o['owned_by']) ?? undefined,
  };
}

/** Pull the model array out of the several wrapper shapes in the wild. */
function extractModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  // OpenAI / OpenRouter: { data: [...] }
  // Ollama (/api/tags) and Gemini (/v1beta/models): { models: [...] }
  // Some gateways: { result: [...] } or { items: [...] }
  for (const key of ['data', 'models', 'result', 'items']) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Parse a model-list payload into usable models, deduplicated and with
 * non-conversational utility models removed.
 */
export function parseModelListPayload(payload: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const raw of extractModelEntries(payload)) {
    const model = normalizeModelEntry(raw);
    if (!model) continue;
    if (!isUsableProviderModelId(model.id)) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/**
 * Ask a provider for its own model list.
 *
 * Throws on transport / HTTP errors — callers keep their last-known-good list
 * instead of silently wiping the picker.
 */
export async function discoverProviderModels(
  opts: DiscoverProviderModelsOptions,
): Promise<DiscoveredModel[]> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[opts.provider] ?? '');
  const url = buildModelsEndpoint(baseUrl, opts.provider);
  const headers = buildModelsAuthHeaders(opts.provider, opts.apiKey);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`model list HTTP ${res.status} from ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return parseModelListPayload(await res.json());
}
