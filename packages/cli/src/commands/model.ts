import type { Command } from 'commander';
import * as readline from 'node:readline';
import { loadConfig, saveConfig, APP_VERSION } from '@markus/shared';

// ─── Provider definitions ────────────────────────────────────────────────────

interface ProviderDef {
  id: string;
  label: string;
  envKey: string;
  baseUrl?: string;
  defaultModel: string;
  models: string[];
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-3-6'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    models: ['gpt-5.4', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini'],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
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
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-chat-v3'],
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModelOptions {
  provider?: string;
  apiKey?: string;
  model?: string;
  default?: boolean;
  nonInteractive?: boolean;
  poolLabel?: string;
}

// ─── API validation ──────────────────────────────────────────────────────────

interface ValidationResult {
  ok: boolean;
  error?: string;
  model?: string;
}

async function validateApiKey(
  providerId: string,
  apiKey: string,
  model: string,
  baseUrl?: string,
): Promise<ValidationResult> {
  const pdef = PROVIDERS.find(p => p.id === providerId);
  if (!pdef) return { ok: false, error: 'Unknown provider' };

  const url = baseUrl ?? pdef.baseUrl ?? '';
  const testModel = model || pdef.defaultModel;

  if (providerId === 'anthropic') {
    const msgUrl = `${url}/v1/messages`.replace('/v1/v1/', '/v1/');
    try {
      const res = await fetch(msgUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: testModel,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (res.ok) return { ok: true, model: testModel };
      const body = await res.text();
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
      if (res.status === 429) return { ok: false, error: 'Rate limited — try again later' };
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 100)}` };
    } catch (e) {
      return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // OpenAI-compatible /chat/completions
  const chatUrl = `${url}/chat/completions`.replace('/v1/v1/', '/v1/');
  try {
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: testModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
    });
    if (res.ok) return { ok: true, model: testModel };
    const body = await res.text();
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
    if (res.status === 429) return { ok: false, error: 'Rate limited — quota exceeded' };
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 100)}` };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── Readline helper ─────────────────────────────────────────────────────────

function createAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def?: string): Promise<string> =>
    new Promise(r =>
      rl.question(`${q}${def ? ` [${def}]` : ''}: `, ans => r(ans.trim() || def || '')),
    );
  return { rl, ask };
}

// ─── Color helpers ─────────────────────────────────────────────────────────────

const C = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[36m',
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
};

const check = (sym: string, label: string, sub?: string) =>
  console.log(`  ${sym}  ${label}${sub ? ` ${C.DIM}${sub}${C.RESET}` : ''}`);

const banner = () =>
  console.log(`
${C.BOLD}╔══════════════════════════════════════════════════════╗
║           ${C.BLUE}Markus Model Configuration${C.RESET}${C.BOLD}           ║
╚══════════════════════════════════════════════════════╝${C.RESET}
`);

// ─── Main wizard ──────────────────────────────────────────────────────────────

async function interactiveWizard(): Promise<void> {
  const { rl, ask } = createAsk();
  banner();

  const config = loadConfig(undefined);
  const currentProviders = config.llm?.providers ?? {};
  const currentDefault = config.llm?.defaultProvider ?? '';

  // Show provider status
  console.log(`  ${C.DIM}Configured Providers:${C.RESET}\n`);
  const configured = PROVIDERS.filter(p => {
    const cfg = currentProviders[p.id];
    return cfg?.apiKey && !isPlaceholder(cfg.apiKey);
  });
  const unconfigured = PROVIDERS.filter(p => !configured.some(c => c.id === p.id));

  if (configured.length > 0) {
    for (const p of configured) {
      const isDefault = p.id === currentDefault;
      const model = currentProviders[p.id]?.model ?? p.defaultModel;
      check(
        `${C.GREEN}✓${C.RESET}`,
        p.label.padEnd(14),
        `${model}${isDefault ? ' [default]' : ''}`,
      );
    }
    console.log('');
  }

  if (unconfigured.length > 0) {
    for (const p of unconfigured) {
      check(`${C.RED}✗${C.RESET}`, p.label.padEnd(14), 'not configured');
    }
    console.log('');
  }

  console.log(`  ${C.BOLD}[1]${C.RESET} Configure a new provider`);
  if (configured.length > 0) {
    console.log(`  ${C.BOLD}[2]${C.RESET} Manage credential pool`);
    console.log(`  ${C.BOLD}[3]${C.RESET} Set default provider`);
  }
  console.log(`  ${C.BOLD}[Q]${C.RESET} Quit\n`);

  const choice = await ask('Select option', configured.length > 0 ? '1' : '1');

  if (choice.toLowerCase() === 'q') {
    rl.close();
    return;
  }

  if (choice === '1') {
    await configureNewProvider(ask);
  } else if (choice === '2' && configured.length > 0) {
    await manageCredentialPool(ask, currentProviders, currentDefault);
  } else if (choice === '3' && configured.length > 0) {
    await setDefaultProvider(ask, configured.map(p => p.id), currentDefault);
  } else {
    await configureNewProvider(ask);
  }

  rl.close();
}

async function configureNewProvider(ask: (q: string, def?: string) => Promise<string>): Promise<void> {
  console.log(`\n  ${C.BOLD}Available Providers:${C.RESET}\n`);
  PROVIDERS.forEach((p, i) => {
    const env = `(env: ${p.envKey})`;
    console.log(`  ${C.BOLD}[${i + 1}]${C.RESET} ${p.label.padEnd(14)} ${C.DIM}${env}${C.RESET}`);
  });
  console.log('');

  const numStr = await ask('Select provider number');
  const idx = parseInt(numStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= PROVIDERS.length) {
    console.log('  Invalid selection.');
    return;
  }

  const pdef = PROVIDERS[idx];
  console.log(`\n  Selected: ${pdef.label} (${pdef.defaultModel})`);

  // Model selection
  console.log(`\n  ${C.DIM}Available models:${C.RESET}`);
  pdef.models.forEach((m, i) => {
    const recommended = m === pdef.defaultModel ? ` ${C.GREEN}(recommended)${C.RESET}` : '';
    console.log(`    ${i + 1}. ${m}${recommended}`);
  });
  console.log('');
  const modelNum = await ask('Select model number', '1');
  const modelIdx = parseInt(modelNum, 10) - 1;
  const selectedModel = !isNaN(modelIdx) && modelIdx >= 0 && modelIdx < pdef.models.length
    ? pdef.models[modelIdx]
    : pdef.defaultModel;

  // Base URL
  let baseUrl = pdef.baseUrl ?? '';
  if (pdef.id === 'ollama') {
    baseUrl = await ask('Ollama base URL', baseUrl);
  }

  // API Key
  const envKey = process.env[pdef.envKey];
  let apiKey = envKey ?? '';
  const keyAnswer = await ask(
    `API Key (${pdef.envKey})${envKey ? ' [found in env]' : ''}`,
    '',
  );
  if (keyAnswer) apiKey = keyAnswer;

  if (!apiKey) {
    console.log(`\n  ${C.YELLOW}Skipped — you can configure later with ${C.BOLD}markus model${C.RESET}`);
    return;
  }

  // Optional label
  const label = await ask('Label for this key', 'primary');

  // Validate
  console.log(`\n  ${C.DIM}Validating API key...${C.RESET}`);
  const result = await validateApiKey(pdef.id, apiKey, selectedModel, baseUrl);
  if (result.ok) {
    console.log(`  ${C.GREEN}✓${C.RESET}  API key is valid! Model: ${result.model}\n`);
  } else {
    console.log(`  ${C.RED}✗${C.RESET}  Validation failed: ${result.error}`);
    const retry = await ask('Try anyway? (y/n)', 'n');
    if (retry.toLowerCase() !== 'y') {
      console.log('  Cancelled.');
      return;
    }
  }

  // Save
  const config = loadConfig(undefined);
  const providers = { ...(config.llm?.providers ?? {}), [pdef.id]: {} };
  providers[pdef.id] = {
    apiKey,
    apiKeyLabel: label,
    model: selectedModel,
    ...(baseUrl ? { baseUrl } : {}),
    enabled: true,
  };

  const newConfig = {
    ...config,
    llm: {
      ...(config.llm ?? {}),
      providers,
      defaultModel: config.llm?.defaultModel ?? pdef.defaultModel,
      defaultProvider: config.llm?.defaultProvider ?? pdef.id,
    },
  };
  saveConfig(newConfig);

  console.log(`  ${C.GREEN}✓${C.RESET}  ${pdef.label} saved!`);
  console.log(`  ${C.DIM}Default provider: ${newConfig.llm!.defaultProvider}${C.RESET}\n`);
}

async function manageCredentialPool(
  ask: (q: string, def?: string) => Promise<string>,
  currentProviders: Record<string, any>,
  currentDefault: string,
): Promise<void> {
  console.log(`\n  ${C.BOLD}Credential Pool Management${C.RESET}\n`);

  const configured = Object.keys(currentProviders).filter(id => {
    const cfg = currentProviders[id];
    return cfg?.apiKey && !isPlaceholder(cfg.apiKey);
  });

  if (configured.length === 0) {
    console.log('  No providers configured yet.');
    return;
  }

  console.log('  Select provider to manage:\n');
  configured.forEach((id, i) => {
    const cfg = currentProviders[id];
    const label = cfg?.apiKeyLabel ?? 'primary';
    const ex1 = cfg?.exhausted ? ` ${C.RED}[exhausted]${C.RESET}` : '';
    console.log(`  ${C.BOLD}[${i + 1}]${C.RESET} ${id.padEnd(14)} ${C.DIM}${label}${ex1}${C.RESET}`);
  });
  console.log('');

  const sel = await ask('Provider number', '1');
  const selIdx = parseInt(sel, 10) - 1;
  if (isNaN(selIdx) || selIdx < 0 || selIdx >= configured.length) return;
  const provId = configured[selIdx];
  const cfg = currentProviders[provId];

  console.log(`\n  ${C.BOLD}Provider: ${provId}${C.RESET}`);
  console.log(`  ${C.BOLD}[1]${C.RESET} Add another API key (pooled backup)`);
  if (cfg?.apiKey2) console.log(`  ${C.BOLD}[2]${C.RESET} Remove secondary key`);
  console.log(`  ${C.BOLD}[3]${C.RESET} Reset exhaustion flags`);
  console.log(`  ${C.BOLD}[Q]${C.RESET} Back\n`);

  const act = await ask('Action', '1');

  if (act === '1') {
    const newKey = await ask('New API key');
    if (!newKey || isPlaceholder(newKey)) {
      console.log('  Cancelled — no key added.');
      return;
    }
    const newLabel = await ask('Label for this key', 'backup');
    const pdef = PROVIDERS.find(p => p.id === provId);
    const model = cfg?.model ?? pdef?.defaultModel ?? '';

    console.log(`\n  ${C.DIM}Validating...${C.RESET}`);
    const result = await validateApiKey(provId, newKey, model, cfg?.baseUrl);
    if (!result.ok) {
      console.log(`  ${C.RED}✗${C.RESET}  ${result.error}`);
      const retry = await ask('Add anyway? (y/n)', 'n');
      if (retry.toLowerCase() !== 'y') return;
    } else {
      console.log(`  ${C.GREEN}✓${C.RESET}  Valid!\n`);
    }

    // Save key as apiKey2
    const updated = { ...cfg, apiKey2: newKey, apiKeyLabel2: newLabel, exhausted2: false };
    const config = loadConfig(undefined);
    saveConfig({
      ...config,
      llm: {
        ...config.llm,
        providers: { ...config.llm?.providers, [provId]: updated },
      },
    });
    console.log(`  ${C.GREEN}✓${C.RESET}  Added ${newLabel} key for ${provId}`);
  } else if (act === '2' && cfg?.apiKey2) {
    const config = loadConfig(undefined);
    const { apiKey2, apiKeyLabel2, exhausted2, ...rest } = cfg;
    saveConfig({
      ...config,
      llm: {
        ...config.llm,
        providers: { ...config.llm?.providers, [provId]: rest },
      },
    });
    console.log(`  ${C.GREEN}✓${C.RESET}  Removed secondary key`);
  } else if (act === '3') {
    const config = loadConfig(undefined);
    saveConfig({
      ...config,
      llm: {
        ...config.llm,
        providers: {
          ...config.llm?.providers,
          [provId]: { ...cfg, exhausted: false, exhausted2: false },
        },
      },
    });
    console.log(`  ${C.GREEN}✓${C.RESET}  Exhaustion flags cleared`);
  }
}

async function setDefaultProvider(
  ask: (q: string, def?: string) => Promise<string>,
  availableIds: string[],
  currentDefault: string,
): Promise<void> {
  console.log(`\n  ${C.BOLD}Set Default Provider${C.RESET}\n`);
  availableIds.forEach((id, i) => {
    const marker = id === currentDefault ? ` ${C.GREEN}[current default]${C.RESET}` : '';
    console.log(`  ${C.BOLD}[${i + 1}]${C.RESET} ${id}${marker}`);
  });
  console.log('');
  const sel = await ask('Select number', String(availableIds.indexOf(currentDefault) + 1));
  const selIdx = parseInt(sel, 10) - 1;
  if (isNaN(selIdx) || selIdx < 0 || selIdx >= availableIds.length) {
    console.log('  Invalid selection.');
    return;
  }
  const newDefault = availableIds[selIdx];
  const config = loadConfig(undefined);
  saveConfig({ ...config, llm: { ...config.llm, defaultProvider: newDefault } });
  console.log(`\n  ${C.GREEN}✓${C.RESET}  Default provider set to: ${newDefault}\n`);
}

// ─── Placeholder detection ────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = ['***', 'your-', 'dummy', 'fake', 'test-key', 'replace-me'];
function isPlaceholder(key: string): boolean {
  return PLACEHOLDER_PATTERNS.some(p => key.toLowerCase().includes(p)) || key.length < 8;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

export function registerModelCommand(program: Command) {
  program
    .command('model')
    .description('Configure LLM providers, API keys, model selection, and credential pooling')
    .option('--provider <name>', 'Provider id (anthropic/openai/google/minimax/siliconflow/openrouter/zai/ollama/deepseek)')
    .option('--api-key <key>', 'API key for the provider')
    .option('--model <model>', 'Model name to use')
    .option('--default', 'Set this provider as the default')
    .option('--non-interactive', 'Run in non-interactive mode (use with --provider and --api-key)')
    .option('--pool-label <label>', 'Label for the API key in credential pool')
    .action(async opts => {
      const options: ModelOptions = {
        provider: opts.provider,
        apiKey: opts.apiKey,
        model: opts.model,
        default: opts.default,
        nonInteractive: opts.nonInteractive,
        poolLabel: opts.poolLabel,
      };

      if (options.nonInteractive && options.provider) {
        // Non-interactive mode
        const pdef = PROVIDERS.find(p => p.id === options.provider);
        if (!pdef) {
          console.log(`Unknown provider: ${options.provider}`);
          console.log(`Available: ${PROVIDERS.map(p => p.id).join(', ')}`);
          return;
        }
        const apiKey = options.apiKey ?? process.env[pdef.envKey] ?? '';
        if (!apiKey) {
          console.log(`No API key for ${options.provider} — set ${pdef.envKey} or pass --api-key`);
          return;
        }
        const model = options.model ?? pdef.defaultModel;
        console.log(`Validating ${options.provider}/${model}...`);
        const result = await validateApiKey(options.provider, apiKey, model, pdef.baseUrl);
        if (result.ok) {
          console.log(`OK — ${result.model}`);
          const config = loadConfig(undefined);
          const providers = { ...(config.llm?.providers ?? {}), [options.provider!]: {} };
          providers[options.provider!] = {
            apiKey,
            model,
            ...(pdef.baseUrl ? { baseUrl: pdef.baseUrl } : {}),
            enabled: true,
          };
          const newConfig = {
            ...config,
            llm: {
              ...(config.llm ?? {}),
              providers,
              defaultModel: config.llm?.defaultModel ?? model,
              defaultProvider: options.default
                ? options.provider!
                : config.llm?.defaultProvider ?? options.provider!,
            },
          };
          saveConfig(newConfig);
          console.log(`Saved. Default: ${newConfig.llm!.defaultProvider}`);
        } else {
          console.log(`FAIL — ${result.error}`);
        }
        return;
      }

      // Interactive mode
      await interactiveWizard();
    });
}
