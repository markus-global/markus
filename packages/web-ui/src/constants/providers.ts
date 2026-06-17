export interface ProviderOption {
  id: string;
  label: string;
  envKey: string;
  baseUrl?: string;
  defaultModel: string;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-4-6' },
  { id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-5.4' },
  { id: 'google', label: 'Google Gemini', envKey: 'GOOGLE_API_KEY', defaultModel: 'gemini-3-1-pro' },
  { id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash' },
  { id: 'siliconflow', label: 'SiliconFlow (中国)', envKey: 'SILICONFLOW_API_KEY', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3.5-35B-A3B' },
  { id: 'siliconflow-intl', label: 'SiliconFlow (Global)', envKey: 'SILICONFLOW_INTL_API_KEY', baseUrl: 'https://api-st.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3.5-35B-A3B' },
  { id: 'minimax', label: 'MiniMax (Global)', envKey: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io/v1', defaultModel: 'MiniMax-M3' },
  { id: 'minimax-cn', label: 'MiniMax (中国)', envKey: 'MINIMAX_CN_API_KEY', baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M3' },
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'xiaomi/mimo-v2-pro:free' },
  { id: 'zai', label: 'ZAI (GLM)', envKey: 'ZAI_API_KEY', baseUrl: 'https://api.z.ai/api/paas/v4', defaultModel: 'glm-5.1' },
  { id: 'xai', label: 'xAI (Grok)', envKey: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-3' },
  { id: 'mistral', label: 'Mistral AI', envKey: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest' },
  { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  { id: 'perplexity', label: 'Perplexity', envKey: 'PERPLEXITY_API_KEY', baseUrl: 'https://api.perplexity.ai', defaultModel: 'sonar-pro' },
  { id: 'cohere', label: 'Cohere', envKey: 'COHERE_API_KEY', baseUrl: 'https://api.cohere.ai/compatibility/v1', defaultModel: 'command-r-plus' },
  { id: 'together_ai', label: 'Together AI', envKey: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'fireworks_ai', label: 'Fireworks AI', envKey: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1', defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', envKey: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-auto' },
  { id: 'volcengine', label: 'Volcengine (Doubao)', envKey: 'VOLCENGINE_API_KEY', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-1.5-pro-32k' },
  { id: 'dashscope', label: 'DashScope (Qwen)', envKey: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-max' },
  { id: 'ollama', label: 'Ollama (Local)', envKey: 'OLLAMA_BASE_URL', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3' },
  // Full-modal aggregators
  { id: 'atlascloud', label: 'Atlas Cloud (Full-Modal)', envKey: 'ATLASCLOUD_API_KEY', baseUrl: 'https://api.atlascloud.ai/v1', defaultModel: 'claude-sonnet-4-6' },
  { id: 'strongly', label: 'Strongly.AI (Full-Modal)', envKey: 'STRONGLY_API_KEY', baseUrl: 'https://api.strongly.ai/v1', defaultModel: 'claude-sonnet-4-6' },
];
