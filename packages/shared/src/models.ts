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
    label: 'MiniMax',
    envKey: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M2.7',
    models: ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3-high'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
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
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-chat-v3'],
  },
];

export function isPlaceholder(key: string): boolean {
  const PLACEHOLDER_PATTERNS = ['***', 'your-', 'dummy', 'fake', 'test-key', 'replace-me'];
  return PLACEHOLDER_PATTERNS.some(p => key.toLowerCase().includes(p)) || key.length < 8;
}
