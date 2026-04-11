import type { Command } from 'commander';
import * as readline from 'node:readline';
import { loadConfig, saveConfig } from '@markus/shared';

// ─── Color constants ──────────────────────────────────────────────────────────

const C = {
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  DIM: '\x1b[2m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
};

function ok(text: string, detail = '') {
  console.log(`  ${C.GREEN}✓${C.RESET} ${text}${detail ? ` ${C.DIM}${detail}${C.RESET}` : ''}`);
}
function fail(text: string, detail = '') {
  console.log(`  ${C.RED}✗${C.RESET} ${text}${detail ? ` ${C.DIM}${detail}${C.RESET}` : ''}`);
}
function warn(text: string, detail = '') {
  console.log(`  ${C.YELLOW}⚠${C.RESET} ${text}${detail ? ` ${C.DIM}${detail}${C.RESET}` : ''}`);
}
function info(text: string) {
  console.log(`    ${C.CYAN}→${C.RESET} ${text}`);
}
function section(label: string) {
  console.log(`\n${C.BOLD}◆ ${label}${C.RESET}`);
}

// ─── Provider definitions ─────────────────────────────────────────────────────

interface ProviderDef {
  id: string;
  label: string;
  envKey: string;
  baseUrl?: string;
  defaultModel: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-4-6' },
  { id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-5.4' },
  { id: 'google', label: 'Google Gemini', envKey: 'GOOGLE_API_KEY', defaultModel: 'gemini-3-1-pro' },
  { id: 'minimax', label: 'MiniMax', envKey: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io/v1', defaultModel: 'MiniMax-M2.7' },
  { id: 'siliconflow', label: 'SiliconFlow', envKey: 'SILICONFLOW_API_KEY', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3.5-35B-A3B' },
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'xiaomi/mimo-v2-pro:free' },
  { id: 'zai', label: 'ZAI', envKey: 'ZAI_API_KEY', baseUrl: 'https://api.z.ai/api/paas/v4', defaultModel: 'glm-5.1' },
  { id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
];

// ─── Placeholder detection ────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = ['***', 'your-', 'dummy', 'fake', 'test-key', 'replace-me'];
function isPlaceholder(key: string): boolean {
  return PLACEHOLDER_PATTERNS.some(p => key.toLowerCase().includes(p)) || key.length < 8;
}

// ─── API validation ───────────────────────────────────────────────────────────

async function validateKey(
  id: string,
  apiKey: string,
  model: string,
  baseUrl?: string,
): Promise<{ ok: boolean; error?: string }> {
  const pdef = PROVIDERS.find(p => p.id === id);
  if (!pdef) return { ok: false, error: 'Unknown provider' };
  const url = baseUrl ?? pdef.baseUrl ?? '';

  if (id === 'anthropic') {
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
        body: JSON.stringify({ model: model || pdef.defaultModel, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
      if (res.status === 429) return { ok: false, error: 'Rate limited' };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const chatUrl = `${url}/chat/completions`.replace('/v1/v1/', '/v1/');
  try {
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || pdef.defaultModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
    if (res.status === 429) return { ok: false, error: 'Rate limited / quota exceeded' };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── Readline helper ──────────────────────────────────────────────────────────

function createAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def?: string): Promise<string> =>
    new Promise(r =>
      rl.question(`${q}${def ? ` [${def}]` : ''}: `, ans => r(ans.trim() || def || '')),
    );
  return { rl, ask };
}

// ─── List command ─────────────────────────────────────────────────────────────

async function listAuth(): Promise<void> {
  const config = loadConfig(undefined);
  const providers = config.llm?.providers ?? {};
  const defaultProv = config.llm?.defaultProvider ?? '';

  console.log(`\n${C.BOLD}╔══════════════════════════════════════════════════════════════╗
║                  ${C.CYAN}Markus Auth — Credential Pool${C.RESET}${C.BOLD}           ║
╚══════════════════════════════════════════════════════════════╝${C.RESET}\n`);

  const configured = Object.entries(providers).filter(([, cfg]) => (cfg as any)?.apiKey && !isPlaceholder((cfg as any).apiKey));
  const envBacked = PROVIDERS.filter(p => !configured.some(([id]) => id === p.id) && process.env[p.envKey] && !isPlaceholder(process.env[p.envKey]!));

  if (configured.length === 0 && envBacked.length === 0) {
    warn('No credentials configured');
    info('Run: markus auth add <provider>');
    return;
  }

  // Configured providers
  for (const [id, cfg] of configured) {
    const pdef = PROVIDERS.find(p => p.id === id);
    const label = pdef?.label ?? id;
    const isDefault = id === defaultProv;
    const model = (cfg as any).model ?? '';
    const key = (cfg as any).apiKey ?? '';
    const keyLabel = (cfg as any).apiKeyLabel ?? 'primary';
    const exhausted = (cfg as any).exhausted;
    const key2 = (cfg as any).apiKey2;
    const keyLabel2 = (cfg as any).apiKeyLabel2 ?? 'secondary';
    const exhausted2 = (cfg as any).exhausted2;

    const exTag = exhausted ? ` ${C.RED}[EXHAUSTED]${C.RESET}` : '';
    const exTag2 = exhausted2 ? ` ${C.RED}[EXHAUSTED]${C.RESET}` : '';
    const defTag = isDefault ? ` ${C.CYAN}[default]${C.RESET}` : '';
    const masked1 = key.slice(0, 4) + '****' + key.slice(-3);

    console.log(`  ${C.BOLD}${label}${defTag}${C.RESET} (${id})`);
    console.log(`    ${keyLabel}: ${masked1}${model ? ` → ${model}` : ''}${exTag}`);
    if (key2) {
      const masked2 = key2.slice(0, 4) + '****' + key2.slice(-3);
      console.log(`    ${keyLabel2}: ${masked2}${exhausted2 ? ` ${C.RED}[EXHAUSTED]${C.RESET}` : ''}`);
    }
    console.log('');
  }

  // Env-backed providers
  for (const p of envBacked) {
    const key = process.env[p.envKey] ?? '';
    const masked = key.slice(0, 4) + '****' + key.slice(-3);
    console.log(`  ${C.BOLD}${p.label}${C.RESET} (${p.id})`);
    console.log(`    ${C.DIM}via environment: ${p.envKey}${C.RESET}`);
    console.log(`    key: ${masked}`);
    console.log('');
  }

  console.log(`  ${C.DIM}Commands: markus auth add <provider> | remove <provider> | reset <provider>${C.RESET}\n`);
}

// ─── Add command ───────────────────────────────────────────────────────────────

async function addAuth(
  provider: string,
  opts: { key?: string; label?: string; validate?: boolean; model?: string },
): Promise<void> {
  const pdef = PROVIDERS.find(p => p.id === provider);
  if (!pdef) {
    fail(`Unknown provider: ${provider}`);
    console.log(`  Available: ${PROVIDERS.map(p => p.id).join(', ')}`);
    return;
  }

  const { rl, ask } = createAsk();

  let apiKey = opts.key ?? '';
  let label = opts.label ?? 'primary';

  if (!apiKey) {
    // Check env
    const envKey = process.env[pdef.envKey];
    if (envKey && !isPlaceholder(envKey)) {
      ok(`${pdef.label} (${pdef.envKey})`, 'found in environment — will not overwrite');
    }
    apiKey = await ask(`API Key for ${pdef.label} (${pdef.envKey})`);
  }

  if (!apiKey || isPlaceholder(apiKey)) {
    fail('No valid API key provided');
    rl.close();
    return;
  }

  if (!label) {
    const { ask: a2 } = createAsk();
    label = await a2('Key label (e.g. primary, backup, production)', 'primary');
  }

  const model = opts.model ?? pdef.defaultModel;

  // Validate if requested
  if (opts.validate !== false) {
    console.log(`\n  ${C.DIM}Validating...${C.RESET}`);
    const result = await validateKey(provider, apiKey, model, pdef.baseUrl);
    if (result.ok) {
      ok('API key valid');
    } else {
      fail(`Validation failed: ${result.error}`);
      const { ask: retryAsk } = createAsk();
      const retry = await retryAsk('Add anyway? (y/n)', 'n');
      if (retry.toLowerCase() !== 'y') {
        console.log('  Cancelled.');
        rl.close();
        return;
      }
    }
  }

  // Save
  const config = loadConfig(undefined);
  const existing = config.llm?.providers?.[provider] ?? {};
  const isFirstKey = !existing.apiKey || isPlaceholder(existing.apiKey as string);

  const updated = {
    ...existing,
    apiKey,
    apiKeyLabel: label,
    model: model || (existing as any).model || pdef.defaultModel,
    ...(pdef.baseUrl ? { baseUrl: pdef.baseUrl } : {}),
    enabled: true,
  };

  const newConfig = {
    ...config,
    llm: {
      ...(config.llm ?? {}),
      providers: {
        ...(config.llm?.providers ?? {}),
        [provider]: updated,
      },
      defaultModel: config.llm?.defaultModel ?? model ?? pdef.defaultModel,
      defaultProvider: config.llm?.defaultProvider ?? provider,
    },
  };
  saveConfig(newConfig);

  console.log(`\n  ${C.GREEN}✓${C.RESET} ${pdef.label} credential added (${label})`);
  if (isFirstKey) console.log(`  ${C.DIM}Set as default provider${C.RESET}`);

  rl.close();
}

// ─── Remove command ────────────────────────────────────────────────────────────

async function removeAuth(
  provider: string,
  opts: { label?: string },
): Promise<void> {
  const pdef = PROVIDERS.find(p => p.id === provider);
  if (!pdef) {
    fail(`Unknown provider: ${provider}`);
    return;
  }

  const config = loadConfig(undefined);
  const existing = config.llm?.providers?.[provider];

  if (!existing) {
    warn(`No credentials found for ${pdef.label}`);
    return;
  }

  if (opts.label === 'primary' || !opts.label) {
    // Remove primary key, shift key2 to key1
    const { apiKey2, apiKeyLabel2, exhausted2, ...rest } = existing as any;
    const updated = { ...rest };
    if (apiKey2) {
      updated.apiKey = apiKey2;
      updated.apiKeyLabel = apiKeyLabel2 ?? 'primary';
      updated.exhausted = exhausted2 ?? false;
    } else {
      delete updated.apiKey;
      delete updated.apiKeyLabel;
      delete updated.exhausted;
    }

    const newConfig = {
      ...config,
      llm: {
        ...config.llm,
        providers: { ...config.llm?.providers, [provider]: updated },
      },
    };
    saveConfig(newConfig);
    console.log(`\n  ${C.GREEN}✓${C.RESET} Primary key removed for ${pdef.label}`);
    if (apiKey2) console.log(`  ${C.DIM}Secondary key promoted to primary${C.RESET}`);
  } else if (opts.label === 'secondary') {
    const { apiKey2, apiKeyLabel2, exhausted2, ...rest } = existing as any;
    const updated = { ...rest };
    const newConfig = {
      ...config,
      llm: {
        ...config.llm,
        providers: { ...config.llm?.providers, [provider]: updated },
      },
    };
    saveConfig(newConfig);
    console.log(`\n  ${C.GREEN}✓${C.RESET} Secondary key removed for ${pdef.label}`);
  } else {
    fail(`Unknown key label: ${opts.label}`);
    info(`Available labels: primary, secondary`);
  }
}

// ─── Reset command ─────────────────────────────────────────────────────────────

async function resetAuth(provider?: string): Promise<void> {
  const config = loadConfig(undefined);
  const providers = config.llm?.providers ?? {};

  if (provider) {
    const pdef = PROVIDERS.find(p => p.id === provider);
    if (!pdef) { fail(`Unknown provider: ${provider}`); return; }
    const cfg = providers[provider];
    if (!cfg) { warn(`No credentials for ${pdef.label}`); return; }
    const updated = { ...(cfg as any), exhausted: false, exhausted2: false };
    saveConfig({ ...config, llm: { ...config.llm, providers: { ...providers, [provider]: updated } } });
    ok(`Exhaustion flags reset for ${pdef.label}`);
    return;
  }

  // Reset all
  let count = 0;
  const updated: Record<string, any> = {};
  for (const [id, cfg] of Object.entries(providers)) {
    if ((cfg as any)?.exhausted || (cfg as any)?.exhausted2) {
      updated[id] = { ...(cfg as any), exhausted: false, exhausted2: false };
      count++;
    }
  }
  if (count > 0) {
    saveConfig({ ...config, llm: { ...config.llm, providers: { ...providers, ...updated } } });
    ok(`Reset exhaustion flags for ${count} provider(s)`);
  } else {
    ok('No exhausted credentials found');
  }
}

// ─── Validate command ──────────────────────────────────────────────────────────

async function validateAuth(provider?: string): Promise<void> {
  const config = loadConfig(undefined);
  const providers = config.llm?.providers ?? {};

  const toValidate: Array<{ id: string; key: string; model: string; baseUrl?: string; label: string }> = [];

  if (provider) {
    const pdef = PROVIDERS.find(p => p.id === provider);
    if (!pdef) { fail(`Unknown provider: ${provider}`); return; }
    const cfg = providers[provider] as any;
    if (cfg?.apiKey && !isPlaceholder(cfg.apiKey)) {
      toValidate.push({ id: provider, key: cfg.apiKey, model: cfg.model ?? pdef.defaultModel, baseUrl: cfg.baseUrl ?? pdef.baseUrl, label: cfg.apiKeyLabel ?? 'primary' });
    }
    if (cfg?.apiKey2 && !isPlaceholder(cfg.apiKey2)) {
      toValidate.push({ id: provider, key: cfg.apiKey2, model: cfg.model ?? pdef.defaultModel, baseUrl: cfg.baseUrl ?? pdef.baseUrl, label: cfg.apiKeyLabel2 ?? 'secondary' });
    }
    if (toValidate.length === 0) { warn(`No valid keys for ${pdef.label}`); return; }
  } else {
    for (const [id, cfg] of Object.entries(providers)) {
      const pdef = PROVIDERS.find(p => p.id === id);
      if (!pdef) continue;
      const c = cfg as any;
      if (c?.apiKey && !isPlaceholder(c.apiKey)) {
        toValidate.push({ id, key: c.apiKey, model: c.model ?? pdef.defaultModel, baseUrl: c.baseUrl ?? pdef.baseUrl, label: c.apiKeyLabel ?? 'primary' });
      }
      if (c?.apiKey2 && !isPlaceholder(c.apiKey2)) {
        toValidate.push({ id, key: c.apiKey2, model: c.model ?? pdef.defaultModel, baseUrl: c.baseUrl ?? pdef.baseUrl, label: c.apiKeyLabel2 ?? 'secondary' });
      }
    }
    // Also check env-backed keys
    for (const p of PROVIDERS) {
      if (!providers[p.id] && process.env[p.envKey] && !isPlaceholder(process.env[p.envKey]!)) {
        toValidate.push({ id: p.id, key: process.env[p.envKey]!, model: p.defaultModel, baseUrl: p.baseUrl, label: `env:${p.envKey}` });
      }
    }
  }

  if (toValidate.length === 0) { warn('No credentials to validate'); return; }

  section('API Validation');
  let allOk = true;
  await Promise.all(
    toValidate.map(async ({ id, key, model, baseUrl, label }) => {
      const pdef = PROVIDERS.find(p => p.id === id);
      const result = await validateKey(id, key, model, baseUrl);
      if (result.ok) {
        ok(`${pdef?.label ?? id} (${label})`, '✓ API call succeeded');
      } else {
        fail(`${pdef?.label ?? id} (${label})`, `✗ ${result.error}`);
        allOk = false;
      }
    }),
  );
  if (allOk) console.log(`\n  ${C.GREEN}✓ All credentials valid!${C.RESET}\n`);
}

// ─── CLI registration ─────────────────────────────────────────────────────────

export function registerAuthCommand(program: Command) {
  const auth = program.command('auth').description('Manage LLM API credentials and credential pools');

  auth
    .command('list')
    .description('List all configured API credentials')
    .action(async () => { await listAuth(); });

  auth
    .command('add <provider>')
    .description('Add or update an API credential for a provider')
    .option('--key <key>', 'API key value')
    .option('--label <label>', 'Label for this credential (e.g. primary, backup)')
    .option('--model <model>', 'Model to use with this credential')
    .option('--no-validate', 'Skip API validation before saving')
    .action(async (provider, opts) => {
      await addAuth(provider, { key: opts.key, label: opts.label, model: opts.model, validate: opts.validate !== false });
    });

  auth
    .command('remove <provider>')
    .description('Remove an API credential')
    .option('--label <label>', 'Which key to remove: primary or secondary (default: primary)')
    .action(async (provider, opts) => {
      await removeAuth(provider, { label: opts.label });
    });

  auth
    .command('reset [provider]')
    .description('Reset exhaustion flags for a provider (or all if no provider specified)')
    .action(async (provider) => {
      await resetAuth(provider);
    });

  auth
    .command('validate [provider]')
    .description('Validate API credentials (all or specific provider)')
    .action(async (provider) => {
      await validateAuth(provider);
    });
}
