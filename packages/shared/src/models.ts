// Shared provider definitions for Markus LLM configuration.
//
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for provider metadata (id / label / env vars / base URL
// / bootstrap model). Every other package derives from this table:
//   • core      → `model-discovery.ts` (endpoint + auth + listing) and `router.ts`
//   • org-manager → env-based provider auto-detection + provider API responses
//   • cli       → `models` / `model` / `init` / `doctor` / `auth`
//   • web-ui    → fetched from the API (the browser bundle cannot import this)
// Do not copy base URLs or model ids into another package.
//
// IMPORTANT — this table does NOT define "which models a provider has".
// The authoritative model list always comes from the provider's own listing
// endpoint (`GET {baseUrl}/models`, or Ollama's `/api/tags`) via
// `discoverProviderModels()`. `defaultModel` below is only a *bootstrap* value
// used before the first successful listing (fresh install, offline, no API key
// yet); it must never be treated as a curated catalog, and a wrong value here
// cannot shadow the live list.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderModel {
  id: string;
  label: string;
  /** Environment variable holding the API key (or, for Ollama, the base URL). */
  envKey: string;
  /** Environment variable that may override `baseUrl`. */
  baseUrlEnv?: string;
  /** Environment variable that may override `defaultModel`. */
  modelEnv?: string;
  /** Canonical API base URL, no trailing slash. */
  baseUrl?: string;
  /** Bootstrap model only — see the note above. */
  defaultModel: string;
  isAnthropic?: boolean;
}

export const PROVIDERS: ProviderModel[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-4-6',
    isAnthropic: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    baseUrlEnv: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    modelEnv: 'GOOGLE_MODEL',
    baseUrlEnv: 'GOOGLE_BASE_URL',
    // Gemini 的对话与模型列表端点都在 v1beta 下。
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3-1-pro',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow (中国)',
    envKey: 'SILICONFLOW_API_KEY',
    modelEnv: 'SILICONFLOW_MODEL',
    baseUrlEnv: 'SILICONFLOW_BASE_URL',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen3.5-35B-A3B',
  },
  {
    id: 'siliconflow-intl',
    label: 'SiliconFlow (Global)',
    envKey: 'SILICONFLOW_INTL_API_KEY',
    modelEnv: 'SILICONFLOW_INTL_MODEL',
    baseUrlEnv: 'SILICONFLOW_INTL_BASE_URL',
    baseUrl: 'https://api.siliconflow.com/v1',
    defaultModel: 'Qwen/Qwen3.5-35B-A3B',
  },
  {
    id: 'minimax',
    label: 'MiniMax (Global)',
    envKey: 'MINIMAX_API_KEY',
    modelEnv: 'MINIMAX_MODEL',
    baseUrlEnv: 'MINIMAX_BASE_URL',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax (中国)',
    envKey: 'MINIMAX_CN_API_KEY',
    modelEnv: 'MINIMAX_CN_MODEL',
    baseUrlEnv: 'MINIMAX_CN_BASE_URL',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M3',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'xiaomi/mimo-v2-pro:free',
  },
  {
    id: 'zai',
    label: 'ZAI (GLM)',
    envKey: 'ZAI_API_KEY',
    modelEnv: 'ZAI_MODEL',
    baseUrlEnv: 'ZAI_BASE_URL',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.1',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    modelEnv: 'XAI_MODEL',
    baseUrlEnv: 'XAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.5',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    envKey: 'MISTRAL_API_KEY',
    modelEnv: 'MISTRAL_MODEL',
    baseUrlEnv: 'MISTRAL_BASE_URL',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    envKey: 'COHERE_API_KEY',
    modelEnv: 'COHERE_MODEL',
    baseUrlEnv: 'COHERE_BASE_URL',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-r-plus',
  },
  {
    id: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    baseUrlEnv: 'GROQ_BASE_URL',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'together_ai',
    label: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    modelEnv: 'TOGETHER_MODEL',
    baseUrlEnv: 'TOGETHER_BASE_URL',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'fireworks_ai',
    label: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    modelEnv: 'FIREWORKS_MODEL',
    baseUrlEnv: 'FIREWORKS_BASE_URL',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    envKey: 'PERPLEXITY_API_KEY',
    modelEnv: 'PERPLEXITY_MODEL',
    baseUrlEnv: 'PERPLEXITY_BASE_URL',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar-pro',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    envKey: 'MOONSHOT_API_KEY',
    modelEnv: 'MOONSHOT_MODEL',
    baseUrlEnv: 'MOONSHOT_BASE_URL',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-auto',
  },
  {
    id: 'volcengine',
    label: 'Volcengine (Doubao)',
    envKey: 'VOLCENGINE_API_KEY',
    modelEnv: 'VOLCENGINE_MODEL',
    baseUrlEnv: 'VOLCENGINE_BASE_URL',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-1.5-pro-32k',
  },
  {
    id: 'dashscope',
    label: 'DashScope (Qwen)',
    envKey: 'DASHSCOPE_API_KEY',
    modelEnv: 'DASHSCOPE_MODEL',
    baseUrlEnv: 'DASHSCOPE_BASE_URL',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    envKey: 'OLLAMA_BASE_URL',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    modelEnv: 'OLLAMA_MODEL',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3',
  },
  // Markus 云模型：清单来自 Hub（OpenRouter 原始 id），没有 bootstrap 默认值。
  {
    id: 'markus',
    label: 'Markus Cloud AI',
    envKey: 'MARKUS_SUBSCRIPTION_KEY',
    baseUrlEnv: 'MARKUS_BASE_URL',
    modelEnv: 'MARKUS_MODEL',
    defaultModel: '',
  },
  // 全模态聚合网关（单 key 提供 文本 + 图像 + 音频 + 视频）
  {
    id: 'atlascloud',
    label: 'Atlas Cloud (Full-Modal)',
    envKey: 'ATLASCLOUD_API_KEY',
    modelEnv: 'ATLASCLOUD_MODEL',
    baseUrlEnv: 'ATLASCLOUD_BASE_URL',
    baseUrl: 'https://api.atlascloud.ai/v1',
    defaultModel: 'claude-sonnet-4-6',
  },
  {
    id: 'strongly',
    label: 'Strongly.AI (Full-Modal)',
    envKey: 'STRONGLY_API_KEY',
    modelEnv: 'STRONGLY_MODEL',
    baseUrlEnv: 'STRONGLY_BASE_URL',
    baseUrl: 'https://api.strongly.ai/v1',
    defaultModel: 'claude-sonnet-4-6',
  },
];

/** `id → baseUrl` for providers that ship a canonical endpoint. */
export const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = Object.fromEntries(
  PROVIDERS.filter((p): p is ProviderModel & { baseUrl: string } => !!p.baseUrl)
    .map((p) => [p.id, p.baseUrl]),
);

/** Look up a provider descriptor by id (undefined for unknown / custom ids). */
export function getProvider(id: string): ProviderModel | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Bootstrap model for a provider — only used before the provider's own model
 * listing has been fetched successfully. Returns '' when unknown.
 */
export function getProviderBootstrapModel(id: string): string {
  return getProvider(id)?.defaultModel ?? '';
}

/** Resolve a provider's base URL, honouring its `baseUrlEnv` override. */
export function resolveProviderBaseUrl(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const p = getProvider(id);
  if (!p) return undefined;
  if (p.baseUrlEnv && env[p.baseUrlEnv]) return String(env[p.baseUrlEnv]).replace(/\/+$/, '');
  return p.baseUrl;
}

export function isPlaceholder(key: string): boolean {
  const PLACEHOLDER_PATTERNS = ['***', 'your-', 'dummy', 'fake', 'test-key', 'replace-me'];
  return PLACEHOLDER_PATTERNS.some(p => key.toLowerCase().includes(p)) || key.length < 8;
}
