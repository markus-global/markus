// Shared provider and model definitions for Markus LLM configuration

export interface ProviderModel {
  id: string;
  label: string;
  models: string[];
  envKey: string;
  baseUrl?: string;
  defaultModel: string;
  isAnthropic?: boolean;
}

export const PROVIDERS: ProviderModel[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-6',
    isAnthropic: true,
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-3-6'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4',
    models: ['gpt-5.4', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini'],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    defaultModel: 'gemini-3-1-pro',
    models: ['gemini-3-1-pro', 'gemini-3-1-flash', 'gemini-3-0-flash', 'gemini-2-5-pro'],
  },
  {
    id: 'minimax',
    label: 'MiniMax (Global)',
    envKey: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
    models: ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3-high'],
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax (中国)',
    envKey: 'MINIMAX_CN_API_KEY',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M3',
    models: ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3-high'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow (中国)',
    envKey: 'SILICONFLOW_API_KEY',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen3.5-35B-A3B',
    models: [
      'Qwen/Qwen3.5-35B-A3B',
      'Qwen/Qwen3.5-32B-A3B',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-Coder-V2',
      'moonshotai/Kimi-K2.5',
    ],
  },
  {
    id: 'siliconflow-intl',
    label: 'SiliconFlow (Global)',
    envKey: 'SILICONFLOW_INTL_API_KEY',
    baseUrl: 'https://api-st.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen3.5-35B-A3B',
    models: [
      'Qwen/Qwen3.5-35B-A3B',
      'Qwen/Qwen3.5-32B-A3B',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-Coder-V2',
      'moonshotai/Kimi-K2.5',
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'xiaomi/mimo-v2-pro:free',
    models: [
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.6',
      'qwen/qwen3.6-plus',
      'google/gemini-3-1-pro',
      'xiaomi/mimo-v2-pro:free',
      'deepseek-ai/DeepSeek-V3',
    ],
  },
  {
    id: 'zai',
    label: 'ZAI',
    envKey: 'ZAI_API_KEY',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.1',
    models: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.9', 'glm-4-turbo'],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    envKey: 'OLLAMA_BASE_URL',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    models: ['llama3', 'llama3.1', 'llama3.2', 'mistral', 'qwen2.5', 'codellama'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'pixtral-large-latest'],
  },
  {
    id: 'cohere',
    label: 'Cohere',
    envKey: 'COHERE_API_KEY',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    defaultModel: 'command-r-plus',
    models: ['command-r-plus', 'command-r', 'command-light'],
  },
  {
    id: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
  },
  {
    id: 'together_ai',
    label: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'],
  },
  {
    id: 'fireworks_ai',
    label: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen2p5-72b-instruct'],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    envKey: 'PERPLEXITY_API_KEY',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar-pro',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning'],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
    models: ['grok-3', 'grok-3-mini', 'grok-2'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-auto',
    models: ['moonshot-v1-auto', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    id: 'volcengine',
    label: 'Volcengine (Doubao)',
    envKey: 'VOLCENGINE_API_KEY',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-1.5-pro-32k',
    models: ['doubao-1.5-pro-32k', 'doubao-1.5-lite-32k', 'doubao-pro-256k'],
  },
  {
    id: 'dashscope',
    label: 'DashScope (Qwen)',
    envKey: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
  },
  // Full-modal aggregator providers (text + image + audio + video via single API key)
  {
    id: 'atlascloud',
    label: 'Atlas Cloud (Full-Modal)',
    envKey: 'ATLASCLOUD_API_KEY',
    baseUrl: 'https://api.atlascloud.ai/v1',
    defaultModel: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6', 'gpt-4.1', 'gemini-2.5-pro', 'deepseek-v3', 'flux-1-schnell'],
  },
  {
    id: 'strongly',
    label: 'Strongly.AI (Full-Modal)',
    envKey: 'STRONGLY_API_KEY',
    baseUrl: 'https://api.strongly.ai/v1',
    defaultModel: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6', 'gpt-4.1', 'gemini-2.5-pro'],
  },
];

export function isPlaceholder(key: string): boolean {
  const PLACEHOLDER_PATTERNS = ['***', 'your-', 'dummy', 'fake', 'test-key', 'replace-me'];
  return PLACEHOLDER_PATTERNS.some(p => key.toLowerCase().includes(p)) || key.length < 8;
}
