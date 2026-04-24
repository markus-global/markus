import type { Command } from 'commander';
import { loadConfig } from '@markus/shared';

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

function checkOk(text: string, detail = '') {
  console.log(`  ${C.GREEN}✓${C.RESET} ${text}${detail ? ` ${C.DIM}${detail}${C.RESET}` : ''}`);
}
function checkFail(text: string, detail = '') {
  console.log(`  ${C.RED}✗${C.RESET} ${text}${detail ? ` ${C.DIM}${detail}${C.RESET}` : ''}`);
}
function checkWarn(text: string, detail = '') {
  console.log(`  ${C.YELLOW}⚠${C.RESET} ${text}${detail ? ` ${C.DIM}${detail}${C.RESET}` : ''}`);
}
function checkInfo(text: string) {
  console.log(`    ${C.CYAN}→${C.RESET} ${text}`);
}
function section(label: string) {
  console.log(`\n${C.BOLD}◆ ${label}${C.RESET}`);
}

// ─── API validation helper ─────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = ['***', 'your-', 'dummy', 'fake', 'test-key', 'replace-me'];
function isPlaceholder(key: string): boolean {
  return PLACEHOLDER_PATTERNS.some(p => key.toLowerCase().includes(p)) || key.length < 8;
}

interface ProviderDef {
  id: string;
  label: string;
  envKey: string;
  baseUrl?: string;
  defaultModel: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-opus-4-6' },
  { id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.4' },
  { id: 'google', label: 'Google Gemini', envKey: 'GOOGLE_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-3-1-pro' },
  { id: 'minimax', label: 'MiniMax', envKey: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io/v1', defaultModel: 'MiniMax-M2.7' },
  { id: 'siliconflow', label: 'SiliconFlow', envKey: 'SILICONFLOW_API_KEY', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3.5-35B-A3B' },
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'xiaomi/mimo-v2-pro:free' },
  { id: 'zai', label: 'ZAI', envKey: 'ZAI_API_KEY', baseUrl: 'https://api.z.ai/api/paas/v4', defaultModel: 'glm-5.1' },
  { id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
];

async function validateProviderKey(
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
        body: JSON.stringify({
          model: model || pdef.defaultModel,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }],
        }),
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
      body: JSON.stringify({
        model: model || pdef.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
    if (res.status === 429) return { ok: false, error: 'Rate limited / quota exceeded' };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── Doctor run ───────────────────────────────────────────────────────────────

interface DoctorOptions {
  fix?: boolean;
  verbose?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const { fix = false } = options;
  const issues: string[] = [];
  const manualIssues: string[] = [];
  let fixedCount = 0;

  console.log(`\n${C.BOLD}${C.CYAN}╔══════════════════════════════════════════════════════╗
║              🩺 Markus Doctor                       ║
╚══════════════════════════════════════════════════════╝${C.RESET}\n`);

  // ── 1. Node.js version ──────────────────────────────────────────────────
  section('Runtime');
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 20) {
    checkOk(`Node.js ${process.versions.node}`);
  } else if (nodeMajor >= 18) {
    checkOk(`Node.js ${process.versions.node}`);
    checkWarn('Node.js 20+ recommended for better performance');
  } else {
    checkFail(`Node.js ${process.versions.node}`, '(18+ required, 20+ recommended)');
    manualIssues.push('Upgrade Node.js to 18 or higher');
  }

  // ── 2. Config file ──────────────────────────────────────────────────────
  section('Configuration');
  const configPath = await getDefaultConfigPath();
  const fs = await import('node:fs');
  if (fs.existsSync(configPath)) {
    checkOk(`Config file: ${configPath}`);
  } else {
    checkFail(`Config file not found: ${configPath}`);
    issues.push('Run markus model or markus init to create config');
  }

  // ── 3. LLM Provider keys ────────────────────────────────────────────────
  section('LLM Providers');
  const config = loadConfig(undefined);
  const providers = config.llm?.providers ?? {};
  const envProviders: Array<{ id: string; label: string; envKey: string; key: string }> = [];

  for (const p of PROVIDERS) {
    const envKey = process.env[p.envKey];
    if (envKey) envProviders.push({ id: p.id, label: p.label, envKey: p.envKey, key: envKey });
  }

  const configuredProviders = Object.entries(providers).filter(([, cfg]) => {
    const key = (cfg as any)?.apiKey ?? '';
    return key && !isPlaceholder(key);
  });

  if (envProviders.length === 0 && configuredProviders.length === 0) {
    checkFail('No LLM API keys configured');
    manualIssues.push('Run: markus model');
  } else {
    // Env-based keys
    for (const ep of envProviders) {
      const pdef = PROVIDERS.find(p => p.id === ep.id)!;
      if (isPlaceholder(ep.key)) {
        checkFail(`${ep.label} (${ep.envKey})`, 'placeholder — not a real key');
      } else {
        checkOk(`${ep.label} (${ep.envKey})`, 'found in environment');
      }
    }
    // Config-based keys
    for (const [id, cfg] of configuredProviders) {
      const key = (cfg as any).apiKey ?? '';
      const pdef = PROVIDERS.find(p => p.id === id);
      if (pdef && !isPlaceholder(key)) {
        checkOk(`${pdef.label}`, `configured${(cfg as any).model ? ` — ${(cfg as any).model}` : ''}`);
      }
    }
  }

  // ── 4. API key validation ───────────────────────────────────────────────
  section('LLM API Validation');
  const keysToValidate: Array<{ id: string; key: string; model: string; baseUrl?: string }> = [];

  for (const ep of envProviders) {
    if (!isPlaceholder(ep.key)) {
      const pdef = PROVIDERS.find(p => p.id === ep.id);
      keysToValidate.push({ id: ep.id, key: ep.key, model: pdef?.defaultModel ?? '', baseUrl: pdef?.baseUrl });
    }
  }
  for (const [id, cfg] of configuredProviders) {
    const key = (cfg as any).apiKey ?? '';
    if (!isPlaceholder(key)) {
      const pdef = PROVIDERS.find(p => p.id === id);
      keysToValidate.push({
        id,
        key,
        model: (cfg as any).model ?? pdef?.defaultModel ?? '',
        baseUrl: (cfg as any).baseUrl ?? pdef?.baseUrl,
      });
    }
  }

  if (keysToValidate.length === 0) {
    checkWarn('No valid API keys to validate');
    manualIssues.push('Configure API keys with: markus model');
  } else {
    let allOk = true;
    await Promise.all(
      keysToValidate.map(async ({ id, key, model, baseUrl }) => {
        const result = await validateProviderKey(id, key, model, baseUrl);
        const pdef = PROVIDERS.find(p => p.id === id);
        const label = pdef?.label ?? id;
        if (result.ok) {
          checkOk(`${label} API key`, '✓ API call succeeded');
        } else {
          checkFail(`${label} API key`, `✗ ${result.error}`);
          issues.push(`Fix ${label} API key: ${result.error}`);
          allOk = false;
        }
      }),
    );
    if (allOk) {
      checkOk('All providers validated');
    }
  }

  // ── 5. Storage ────────────────────────────────────────────────────────────
  section('Storage');
  const { homedir } = await import('node:os');
  const storageDir = `${homedir()}/.markus`;
  const dataFile = `${storageDir}/data.db`;
  try {
    if (!fs.existsSync(storageDir)) {
      if (fix) {
        fs.mkdirSync(storageDir, { recursive: true });
        checkOk(`Created storage directory: ${storageDir}`);
        fixedCount++;
      } else {
        checkWarn(`Storage directory not found: ${storageDir}`);
        issues.push(`Create ${storageDir}`);
      }
    } else if (!fs.existsSync(dataFile)) {
      checkWarn('Storage directory exists but database not initialized');
      checkInfo('Database will be created on first run');
    } else {
      checkOk(`Storage: ${storageDir}`);
      const stat = fs.statSync(dataFile);
      checkOk(`Database: ${dataFile}`, `${(stat.size / 1024).toFixed(1)} KB`);
    }
  } catch (e) {
    checkFail(`Storage check failed: ${e}`);
  }

  // ── 6. Skills directory ─────────────────────────────────────────────────
  section('Skills');
  const skillsDir = `${homedir()}/.markus/skills`;
  if (fs.existsSync(skillsDir)) {
    try {
      const entries = fs.readdirSync(skillsDir);
      const skills = entries.filter(e => !e.startsWith('.'));
      checkOk(`Skills directory: ${skillsDir}`, `${skills.length} skill(s) installed`);
    } catch {
      checkFail('Skills directory not readable');
    }
  } else {
    checkWarn('Skills directory not found', `${skillsDir} — run: markus skill install <name>`);
  }

  // ── 7. Network connectivity ─────────────────────────────────────────────
  section('Network');
  const proxyUrl = process.env['HTTPS_PROXY'] || process.env['HTTP_PROXY']
    || process.env['https_proxy'] || process.env['http_proxy'];
  if (proxyUrl) {
    checkOk('HTTP proxy configured', proxyUrl);
  } else {
    checkWarn('HTTP proxy', 'not configured — if behind firewall, set HTTPS_PROXY env var');
  }
  try {
    const res = await fetch('https://api.anthropic.com/.well-known/ready', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    checkOk('Network connectivity', 'outbound HTTPS works');
  } catch {
    checkWarn('Network connectivity', 'could not reach external APIs — check firewall/proxy');
    issues.push('Verify network connectivity');
  }

  // ── 8. Config schema validation ─────────────────────────────────────────
  section('Config Schema');
  let schemaIssues = 0;
  if (config.llm?.providers) {
    for (const [id, cfg] of Object.entries(config.llm.providers)) {
      if ((cfg as any).apiKey && isPlaceholder((cfg as any).apiKey)) {
        checkWarn(`${id} API key is a placeholder`, '"***" will not work — replace with real key');
        schemaIssues++;
      }
      if ((cfg as any).apiKey2 && isPlaceholder((cfg as any).apiKey2)) {
        checkWarn(`${id} pool key (apiKey2) is a placeholder`);
        schemaIssues++;
      }
    }
  }
  if (schemaIssues === 0) {
    checkOk('Config schema valid');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${C.BOLD}◆ Summary${C.RESET}\n`);
  const totalIssues = issues.length + manualIssues.length;
  if (totalIssues === 0) {
    console.log(`  ${C.GREEN}✓${C.RESET} ${C.BOLD}All checks passed!${C.RESET} Markus is ready to run.\n`);
    console.log(`  ${C.DIM}Start with:${C.RESET} ${C.CYAN}markus start${C.RESET}\n`);
  } else {
    if (issues.length > 0) {
      console.log(`  ${C.RED}Issues (auto-fixable with --fix):${C.RESET}`);
      for (const issue of issues) {
        checkInfo(issue);
      }
      console.log('');
    }
    if (manualIssues.length > 0) {
      console.log(`  ${C.YELLOW}Manual action required:${C.RESET}`);
      for (const issue of manualIssues) {
        checkInfo(issue);
      }
      console.log('');
    }
    console.log(`  ${C.DIM}${totalIssues} issue(s) found. Run ${C.CYAN}markus doctor --fix${C.DIM} to auto-fix what can be fixed.${C.RESET}\n`);
  }

  if (fix && fixedCount > 0) {
    console.log(`  ${C.GREEN}✓${C.RESET} Fixed ${fixedCount} issue(s).\n`);
  }
}

async function getDefaultConfigPath(): Promise<string> {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  return join(homedir(), '.markus', 'markus.json');
}

// ─── CLI registration ────────────────────────────────────────────────────────

export function registerDoctorCommand(program: Command) {
  program
    .command('doctor')
    .description('Diagnose Markus configuration issues and environment health')
    .option('--fix', 'Attempt to automatically fix issues')
    .option('--verbose', 'Show detailed output')
    .action(async opts => {
      await runDoctor({ fix: opts.fix, verbose: opts.verbose });
    });
}
