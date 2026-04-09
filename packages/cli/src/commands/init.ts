import type { Command } from 'commander';
import { resolve } from 'node:path';
import { readFileSync, existsSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { saveConfig, getDefaultConfigPath, APP_VERSION } from '@markus/shared';
import { resolveTemplatesDir } from '../paths.js';
import { findConnector, scanInstalledPlatforms, readPlatformLLMProviders } from '../connector-service.js';

export interface InitOptions {
  force?: boolean;
  nonInteractive?: boolean;
  provider?: string;
  apiKey?: string;
  port?: string;
  importFrom?: string;
  autoConnect?: boolean;
}

export function registerInitCommand(program: Command) {
  program
    .command('init')
    .description('Setup wizard: configure LLM provider, API keys, and server settings')
    .option('--force', 'Overwrite existing configuration')
    .option('--non-interactive', 'Run without prompts (use env vars or --import-from)')
    .option('--provider <name>', 'LLM provider (anthropic/openai/google/minimax/siliconflow/ollama)')
    .option('--api-key <key>', 'LLM API key')
    .option('--port <port>', 'API server port', '8056')
    .option('--import-from <platform>', 'Import LLM config from an installed agent platform (e.g. openclaw, hermes)')
    .option('--auto-connect', 'Auto-connect detected agent platforms after init')
    .action(async (opts) => {
      await quickInit({
        force: opts.force,
        nonInteractive: opts.nonInteractive,
        provider: opts.provider,
        apiKey: opts.apiKey,
        port: opts.port,
        importFrom: opts.importFrom,
        autoConnect: opts.autoConnect,
      });
    });
}

export async function quickInit(options?: InitOptions) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join: pathJoin } = await import('node:path');
  const readline = await import('node:readline');

  const nonInteractive = options?.nonInteractive ?? false;

  let rl: ReturnType<typeof readline.createInterface> | undefined;
  if (!nonInteractive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  const ask = (q: string, def?: string): Promise<string> => {
    if (nonInteractive) return Promise.resolve(def || '');
    return new Promise(r =>
      rl!.question(`${q}${def ? ` [${def}]` : ''}: `, ans => r(ans.trim() || def || ''))
    );
  };

  console.log(`
  ┌─────────────────────────────────────┐
  │         Markus v${APP_VERSION.padEnd(22)}│
  │   AI Digital Workforce Platform     │
  └─────────────────────────────────────┘
  `);

  const configPath = getDefaultConfigPath();
  if (existsSync(configPath) && !options?.force) {
    if (nonInteractive) {
      console.log(`  Existing configuration found. Use --force to overwrite.`);
      rl?.close();
      return;
    }
    console.log(`  Existing configuration found: ${configPath}`);
    const overwrite = await ask('  Overwrite? (y/n)', 'n');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  Keeping existing config. Use --force to overwrite.');
      rl?.close();
      return;
    }
    console.log('');
  }

  const MODEL_MAP: Record<string, string> = {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.4',
    google: 'gemini-3-1-pro',
    minimax: 'MiniMax-M2.7',
    siliconflow: 'Qwen/Qwen3.5-35B-A3B',
    ollama: 'llama3',
    openrouter: 'xiaomi/mimo-v2-pro',
  };

  const ENV_KEY_MAP: Array<{ provider: string; label: string; envKey: string; baseUrl?: string }> = [
    { provider: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { provider: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY' },
    { provider: 'google', label: 'Google Gemini', envKey: 'GOOGLE_API_KEY' },
    { provider: 'siliconflow', label: 'SiliconFlow', envKey: 'SILICONFLOW_API_KEY', baseUrl: 'https://api.siliconflow.cn/v1' },
    { provider: 'minimax', label: 'MiniMax', envKey: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io/v1' },
    { provider: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  ];

  console.log('  [1/3] LLM Provider Configuration\n');

  // --- Step 1: Auto-detect available sources ---
  const envProviders: Array<{ provider: string; label: string; key: string; baseUrl?: string }> = [];
  for (const def of ENV_KEY_MAP) {
    const key = process.env[def.envKey];
    if (key) envProviders.push({ provider: def.provider, label: def.label, key, baseUrl: def.baseUrl });
  }

  // Detect installed agent platforms via connector system
  const installedPlatforms = scanInstalledPlatforms().filter(p => p.installed);

  // Legacy OpenClaw detection (for backward compat)
  let openclawPath = '';
  const openclawCandidates = [
    pathJoin(homedir(), '.openclaw', 'openclaw.json'),
    pathJoin(homedir(), '.openclaw', 'openclaw.json5'),
  ];
  for (const p of openclawCandidates) {
    if (existsSync(p)) { openclawPath = p; break; }
  }

  const sources: string[] = [];
  if (envProviders.length > 0) {
    console.log(`  Found ${envProviders.length} API key(s) in environment variables:`);
    for (const ep of envProviders) console.log(`    - ${ep.label} (${ep.provider})`);
    sources.push('env');
  }
  if (openclawPath) {
    console.log(`  Found OpenClaw config: ${openclawPath}`);
    sources.push('openclaw');
  }
  for (const ip of installedPlatforms) {
    if (ip.platform !== 'openclaw' && ip.configPath) {
      console.log(`  Found ${ip.displayName} config: ${ip.configPath}`);
      sources.push(ip.platform);
    }
  }
  if (sources.length === 0) {
    console.log('  No API keys detected in environment or external agent configs.');
  }
  console.log('');

  // Non-interactive: determine mode from flags
  let mode: string;
  if (nonInteractive) {
    if (options?.importFrom) {
      mode = options.importFrom;
    } else if (options?.provider) {
      mode = 'manual';
    } else if (envProviders.length > 0) {
      mode = 'env';
    } else if (sources.length > 0) {
      mode = sources[0];
    } else {
      mode = 'manual';
    }
  } else if (sources.length > 0) {
    const optionsList = [
      ...sources.map(s => {
        if (s === 'env') return 'env (use environment variables)';
        const p = installedPlatforms.find(ip => ip.platform === s);
        return p ? `${s} (import from ${p.displayName})` : `${s} (import)`;
      }),
      'manual (enter API key manually)',
    ];
    mode = await ask(`  Config source? ${optionsList.join(' / ')}`, sources[0]);
    if (!['env', 'manual', ...sources].includes(mode)) mode = sources[0];
  } else {
    mode = 'manual';
  }

  const providers: Record<string, { apiKey?: string; baseUrl?: string; model?: string; enabled?: boolean }> = {};
  let defaultProvider = '';

  if (mode === 'env') {
    for (const ep of envProviders) {
      const model = process.env[`${ep.provider.toUpperCase()}_MODEL`] ?? MODEL_MAP[ep.provider] ?? '';
      providers[ep.provider] = {
        apiKey: ep.key,
        model,
        ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}),
        enabled: true,
      };
    }
    defaultProvider = envProviders[0].provider;
    console.log(`\n  Importing ${envProviders.length} provider(s) from environment variables.`);
    if (envProviders.length > 1 && !nonInteractive) {
      const choices = envProviders.map(e => e.provider).join('/');
      defaultProvider = await ask(`  Default provider? (${choices})`, defaultProvider);
      if (!providers[defaultProvider]) defaultProvider = envProviders[0].provider;
    }
  } else if (mode === 'openclaw') {
    // Legacy OpenClaw import path
    try {
      const raw = readFileSync(openclawPath, 'utf-8');
      const cleaned = raw
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([\]}])/g, '$1');
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      const modelsSection = parsed.models as { providers?: Record<string, { baseUrl?: string; models?: Array<{ id: string; name: string }> }> } | undefined;
      if (modelsSection?.providers) {
        const provNames = Object.keys(modelsSection.providers);
        console.log(`\n  Found ${provNames.length} provider(s) in OpenClaw config.`);
        for (const [name, cfg] of Object.entries(modelsSection.providers)) {
          providers[name] = {
            ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
            model: cfg.models?.[0]?.id,
            enabled: true,
          };
        }
        if (provNames.length > 0) defaultProvider = provNames[0];
        if (provNames.length > 1 && !nonInteractive) {
          defaultProvider = await ask(`  Default provider? (${provNames.join('/')})`, defaultProvider);
          if (!providers[defaultProvider]) defaultProvider = provNames[0];
        }
      } else {
        console.log('\n  No model providers found in OpenClaw config, switching to manual mode.');
        mode = 'manual';
      }
    } catch (e) {
      console.log(`\n  Failed to parse OpenClaw config: ${e}\n  Switching to manual mode.`);
      mode = 'manual';
    }
  } else if (mode !== 'manual') {
    // Generic platform import via connector system
    const connector = findConnector(mode);
    if (connector) {
      const llmProviders = readPlatformLLMProviders(connector);
      if (llmProviders) {
        const provNames = Object.keys(llmProviders);
        console.log(`\n  Found ${provNames.length} provider(s) in ${connector.displayName} config.`);
        for (const [name, cfg] of Object.entries(llmProviders)) {
          const c = cfg as Record<string, unknown>;
          providers[name] = {
            ...(c.baseUrl ? { baseUrl: c.baseUrl as string } : {}),
            ...(c.model ? { model: c.model as string } : {}),
            ...(c.apiKey ? { apiKey: c.apiKey as string } : {}),
            enabled: true,
          };
        }
        if (provNames.length > 0) defaultProvider = provNames[0];
        if (provNames.length > 1 && !nonInteractive) {
          defaultProvider = await ask(`  Default provider? (${provNames.join('/')})`, defaultProvider);
          if (!providers[defaultProvider]) defaultProvider = provNames[0];
        }
      } else {
        console.log(`\n  No LLM providers found in ${connector.displayName} config, switching to manual mode.`);
        mode = 'manual';
      }
    } else {
      mode = 'manual';
    }
  }

  if (mode === 'manual') {
    if (nonInteractive) {
      const provider = options?.provider || 'anthropic';
      defaultProvider = provider;
      const apiKey = options?.apiKey || process.env['ANTHROPIC_API_KEY'] || process.env['OPENAI_API_KEY'] || '';
      if (apiKey || provider === 'ollama') {
        const baseUrlMap: Record<string, string> = {
          minimax: 'https://api.minimax.io/v1',
          siliconflow: 'https://api.siliconflow.cn/v1',
        };
        providers[provider] = {
          ...(apiKey ? { apiKey } : {}),
          model: MODEL_MAP[provider],
          ...(baseUrlMap[provider] ? { baseUrl: baseUrlMap[provider] } : {}),
          enabled: true,
        };
        console.log(`  Using provider: ${provider}`);
      } else {
        console.log('  Warning: No API key provided. Configure manually in ~/.markus/markus.json');
      }
    } else {
      const provider = await ask('  LLM provider (anthropic/openai/google/minimax/siliconflow/ollama)', 'anthropic');
      defaultProvider = provider;
      let apiKey = '';
      if (provider !== 'ollama') {
        apiKey = await ask(`  ${provider} API Key`) ?? '';
      }
      if (apiKey || provider === 'ollama') {
        const baseUrlMap: Record<string, string> = {
          minimax: 'https://api.minimax.io/v1',
          siliconflow: 'https://api.siliconflow.cn/v1',
        };
        providers[provider] = {
          ...(apiKey ? { apiKey } : {}),
          model: MODEL_MAP[provider],
          ...(baseUrlMap[provider] ? { baseUrl: baseUrlMap[provider] } : {}),
          enabled: true,
        };
      }
    }
  }

  // --- Step 4: Server settings ---
  console.log('\n  [2/3] Server Settings\n');
  const port = nonInteractive ? (options?.port || '8056') : await ask('  API Port', '8056');
  rl?.close();

  // --- Step 5: Save config ---
  console.log('\n  [3/3] Saving Configuration\n');
  const configUpdates: Record<string, unknown> = {
    llm: {
      defaultProvider,
      defaultModel: MODEL_MAP[defaultProvider] ?? MODEL_MAP.anthropic,
      providers,
    },
    server: { apiPort: parseInt(port), webPort: parseInt(port) + 1 },
  };

  try {
    saveConfig(configUpdates as any);
    console.log(`  Config saved to ${configPath}`);
    if (Object.keys(providers).length > 0) {
      console.log(`  Providers: ${Object.keys(providers).join(', ')} (default: ${defaultProvider})`);
    }
  } catch (e) {
    console.error(`\n  Failed to save config: ${e}`);
  }

  // Seed user-local templates from the built-in package templates
  const userTemplatesDir = pathJoin(homedir(), '.markus', 'templates');
  const builtinTemplatesDir = resolveTemplatesDir('roles');
  if (builtinTemplatesDir && existsSync(builtinTemplatesDir) && !existsSync(userTemplatesDir)) {
    const builtinRoot = resolve(builtinTemplatesDir, '..');
    mkdirSync(userTemplatesDir, { recursive: true });
    cpSync(builtinRoot, userTemplatesDir, { recursive: true });
    console.log(`  Copied templates to ${userTemplatesDir}`);
  }

  // Ensure a default developer role exists
  const devRoleDir = pathJoin(userTemplatesDir || pathJoin(process.cwd(), 'templates'), 'roles', 'developer');
  if (!existsSync(devRoleDir)) {
    mkdirSync(devRoleDir, { recursive: true });
    writeFileSync(
      pathJoin(devRoleDir, 'ROLE.md'),
      [
        '---',
        'name: Developer',
        'description: Full-stack software developer',
        'heartbeatInterval: 600000',
        '---',
        '',
        'You are a skilled software developer. You write clean, maintainable code and follow best practices.',
        'You can read and edit files, run shell commands, search the web, and collaborate with other agents.',
        '',
      ].join('\n')
    );
    console.log('  Created default developer role template.');
  }

  const apiPort = parseInt(port) || 8056;

  // Detect external agent platforms for hint
  const detectedPlatforms = scanInstalledPlatforms().filter(p => p.installed);

  console.log(`
  ┌─────────────────────────────────────┐
  │         Setup Complete!             │
  └─────────────────────────────────────┘

  Next steps:

    markus start          Start the server
    markus agent list     List agents
    markus --help         Show all commands
  `);

  if (detectedPlatforms.length > 0) {
    console.log(`  Detected external agent platforms:`);
    for (const p of detectedPlatforms) {
      console.log(`    - ${p.displayName} (${p.platform})`);
    }
    console.log(`\n  Connect them after starting the server:`);
    for (const p of detectedPlatforms) {
      console.log(`    markus connect add ${p.platform}`);
    }
    console.log('');
  }

  console.log(`  Config:  ${configPath}`);
  console.log(`  Data:    ${pathJoin(homedir(), '.markus')}`);
  console.log(`  Server:  http://localhost:${apiPort}`);
  console.log('');
}
