import type { Command } from 'commander';
import * as readline from 'node:readline';
import { loadConfig, saveConfig } from '@markus/shared';

const C = { GREEN: '\x1b[32m', RED: '\x1b[31m', YELLOW: '\x1b[33m', CYAN: '\x1b[36m', DIM: '\x1b[2m', RESET: '\x1b[0m', BOLD: '\x1b[1m' };
const ok = (t: string, d = '') => console.log(`  ${C.GREEN}✓${C.RESET} ${t}${d ? ` ${C.DIM}${d}${C.RESET}` : ''}`);
const fail = (t: string, d = '') => console.log(`  ${C.RED}✗${C.RESET} ${t}${d ? ` ${C.DIM}${d}${C.RESET}` : ''}`);
const warn = (t: string, d = '') => console.log(`  ${C.YELLOW}⚠${C.RESET} ${t}${d ? ` ${C.DIM}${d}${C.RESET}` : ''}`);
const info = (t: string) => console.log(`    ${C.CYAN}→${C.RESET} ${t}`);
const section = (t: string) => console.log(`\n${C.BOLD}◆ ${t}${C.RESET}`);

function createAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def?: string): Promise<string> =>
    new Promise(r =>
      rl.question(`${q}${def ? ` [${def}]` : ''}: `, ans => r(ans.trim() || def || '')),
    );
  return { rl, ask };
}

// ─── Channel definitions ───────────────────────────────────────────────────────

interface ChannelDef {
  id: string;
  label: string;
  description: string;
  webhookPort?: number;
  fields: ChannelField[];
  // Check if configured
  isConfigured(cfg: any): boolean;
}

interface ChannelField {
  key: string;
  label: string;
  envKey?: string;
  secret?: boolean;
  placeholder?: string;
  validate?: (v: string) => string | null; // null = ok, string = error
}

const CHANNELS: ChannelDef[] = [
  {
    id: 'feishu',
    label: '飞书 (Feishu)',
    description: 'Lark/Feishu open platform integration',
    webhookPort: 9000,
    fields: [
      { key: 'appId', label: 'App ID', envKey: 'FEISHU_APP_ID', placeholder: 'cli_xxxxxxxxxxxx' },
      { key: 'appSecret', label: 'App Secret', envKey: 'FEISHU_APP_SECRET', secret: true, placeholder: 'xxxxxxxxxxxxxxxx' },
      { key: 'encryptKey', label: 'Encrypt Key', envKey: 'FEISHU_ENCRYPT_KEY', secret: true, placeholder: 'Optional — for encrypted mode' },
      { key: 'verificationToken', label: 'Verification Token', envKey: 'FEISHU_VERIFICATION_TOKEN', secret: true },
    ],
    isConfigured: cfg => !!(cfg?.appId && cfg?.appSecret),
  },
  {
    id: 'telegram',
    label: 'Telegram',
    description: 'Telegram Bot API integration',
    webhookPort: 8443,
    fields: [
      { key: 'botToken', label: 'Bot Token', envKey: 'TELEGRAM_BOT_TOKEN', secret: true, placeholder: '123456:ABC-DefGhIJKlmno...' },
    ],
    isConfigured: cfg => !!(cfg?.botToken),
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    description: 'WhatsApp Business API (Meta Graph API)',
    webhookPort: 3001,
    fields: [
      { key: 'phoneNumberId', label: 'Phone Number ID', envKey: 'WHATSAPP_PHONE_NUMBER_ID', placeholder: '1234567890' },
      { key: 'accessToken', label: 'Access Token', envKey: 'WHATSAPP_ACCESS_TOKEN', secret: true, placeholder: 'EAAAG...xxxx' },
      { key: 'businessAccountId', label: 'Business Account ID', envKey: 'WHATSAPP_BUSINESS_ACCOUNT_ID', placeholder: '123456789' },
      { key: 'appSecret', label: 'App Secret', envKey: 'WHATSAPP_APP_SECRET', secret: true, placeholder: 'xxxxxxxxxxxxxxxx' },
    ],
    isConfigured: cfg => !!(cfg?.phoneNumberId && cfg?.accessToken),
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Slack Bot with Events API webhook',
    webhookPort: 3000,
    fields: [
      { key: 'botToken', label: 'Bot Token (xoxb-)', envKey: 'SLACK_BOT_TOKEN', secret: true, placeholder: 'xoxb-...' },
      { key: 'signingSecret', label: 'Signing Secret', envKey: 'SLACK_SIGNING_SECRET', secret: true, placeholder: 'xxxxxxxxxxxxxxxx' },
    ],
    isConfigured: cfg => !!(cfg?.botToken && cfg?.signingSecret),
  },
  {
    id: 'dingtalk',
    label: '钉钉 (DingTalk)',
    description: 'DingTalk enterprise messaging',
    fields: [
      { key: 'clientId', label: 'Client ID', envKey: 'DINGTALK_CLIENT_ID' },
      { key: 'clientSecret', label: 'Client Secret', envKey: 'DINGTALK_CLIENT_SECRET', secret: true },
    ],
    isConfigured: cfg => !!(cfg?.clientId && cfg?.clientSecret),
  },
  {
    id: 'wecom',
    label: '企业微信 (WeCom)',
    description: 'WeCom (WeChat Work) enterprise messaging',
    fields: [
      { key: 'corpId', label: 'Corp ID', envKey: 'WECOM_CORP_ID' },
      { key: 'agentId', label: 'Agent ID', envKey: 'WECOM_AGENT_ID' },
      { key: 'corpSecret', label: 'Corp Secret', envKey: 'WECOM_CORP_SECRET', secret: true },
    ],
    isConfigured: cfg => !!(cfg?.corpId && cfg?.agentId && cfg?.corpSecret),
  },
];

// ─── Interactive channel setup ────────────────────────────────────────────────

async function interactiveSetup(channelId?: string): Promise<void> {
  const { rl, ask } = createAsk();
  const config = loadConfig(undefined);
  const integrations = config.integrations as Record<string, any> ?? {};

  if (channelId) {
    const ch = CHANNELS.find(c => c.id === channelId);
    if (!ch) {
      console.log(`Unknown channel: ${channelId}`);
      console.log(`Available: ${CHANNELS.map(c => c.id).join(', ')}`);
      rl.close();
      return;
    }
    await setupChannel(ch, ask, config, integrations);
    rl.close();
    return;
  }

  // Show channel status
  console.log(`\n${C.BOLD}╔══════════════════════════════════════════════════════════════╗
║              ${C.CYAN}Markus Channel Setup${C.RESET}${C.BOLD}                      ║
╚══════════════════════════════════════════════════════════════╝${C.RESET}\n`);

  section('Communication Channels');
  for (const ch of CHANNELS) {
    const chConfig = integrations[ch.id] ?? {};
    const configured = ch.isConfigured(chConfig);
    const port = ch.webhookPort ? ` port ${ch.webhookPort}` : '';
    if (configured) {
      ok(ch.label, `${C.DIM}${ch.description}${C.RESET}`);
      if (ch.webhookPort) info(`Webhook: http://localhost:${ch.webhookPort}/webhook/${ch.id}`);
    } else {
      fail(ch.label, `${C.DIM}${ch.description}${C.RESET}`);
    }
  }

  console.log(`\n  ${C.BOLD}[1-${CHANNELS.length}]${C.RESET} Configure a channel`);
  console.log(`  ${C.BOLD}[A]${C.RESET} Configure all channels`);
  console.log(`  ${C.BOLD}[Q]${C.RESET} Quit\n`);

  const choice = await ask('Select option', '1');

  if (choice.toLowerCase() === 'q') {
    rl.close();
    return;
  }

  if (choice.toLowerCase() === 'a') {
    for (const ch of CHANNELS) {
      await setupChannel(ch, ask, config, integrations);
    }
  } else {
    const idx = parseInt(choice, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < CHANNELS.length) {
      await setupChannel(CHANNELS[idx], ask, config, integrations);
    }
  }

  rl.close();
}

async function setupChannel(
  ch: ChannelDef,
  ask: (q: string, def?: string) => Promise<string>,
  config: any,
  integrations: Record<string, any>,
): Promise<void> {
  console.log(`\n${C.BOLD}── ${ch.label} Setup${C.RESET}\n`);
  if (ch.webhookPort) {
    console.log(`  ${C.DIM}Webhook URL: http://localhost:${ch.webhookPort}/webhook/${ch.id}${C.RESET}`);
    console.log(`  ${C.DIM}Configure this URL in your ${ch.label} developer portal → Webhooks${C.RESET}\n`);
  }

  const chConfig = integrations[ch.id] ?? {};
  const fieldValues: Record<string, string> = { ...chConfig };

  for (const field of ch.fields) {
    // Check env first
    if (field.envKey && process.env[field.envKey] && !chConfig[field.key]) {
      info(`${field.label}: found in ${field.envKey} — using environment`);
      fieldValues[field.key] = process.env[field.envKey]!;
      continue;
    }

    const current = chConfig[field.key] ?? '';
    const envNote = field.envKey ? ` (env: ${field.envKey})` : '';
    const input = await ask(`${field.label}${envNote}`, current || field.placeholder);
    if (input) fieldValues[field.key] = input;
  }

  const newIntegrations = {
    ...integrations,
    [ch.id]: fieldValues,
  };

  saveConfig({ ...config, integrations: newIntegrations });
  console.log(`\n  ${C.GREEN}✓${C.RESET} ${ch.label} saved!`);
  if (ch.webhookPort) {
    console.log(`  ${C.DIM}Restart markus server for changes to take effect${C.RESET}\n`);
  }
}

// ─── List status ───────────────────────────────────────────────────────────────

async function listStatus(): Promise<void> {
  const config = loadConfig(undefined);
  const integrations = config.integrations as Record<string, any> ?? {};

  console.log(`\n${C.BOLD}╔══════════════════════════════════════════════════════════════╗
║              ${C.CYAN}Markus Channel Status${C.RESET}${C.BOLD}                        ║
╚══════════════════════════════════════════════════════════════╝${C.RESET}\n`);

  for (const ch of CHANNELS) {
    const chConfig = integrations[ch.id] ?? {};
    const configured = ch.isConfigured(chConfig);
    const port = ch.webhookPort ? ` port ${ch.webhookPort}` : '';
    const webhooks = ch.webhookPort ? ` → http://localhost:${ch.webhookPort}/webhook/${ch.id}` : '';

    if (configured) {
      ok(`${ch.label}${C.DIM}${port}${webhooks}${C.RESET}`);
      // Show which fields are set
      const fieldLabels = ch.fields.filter(f => chConfig[f.key]).map(f => f.label.toLowerCase());
      info(`${fieldLabels.join(', ')} configured`);
    } else {
      fail(`${ch.label}`, `${C.DIM}not configured — run: markus channel setup ${ch.id}${C.RESET}`);
    }
  }
  console.log('');
}

// ─── Test webhook ─────────────────────────────────────────────────────────────

async function testWebhook(channelId: string): Promise<void> {
  const config = loadConfig(undefined);
  const chConfig = (config.integrations as Record<string, any>)?.[channelId];
  if (!chConfig) {
    fail(`Channel ${channelId} not configured`);
    return;
  }

  const ch = CHANNELS.find(c => c.id === channelId);
  if (!ch?.webhookPort) {
    warn(`No webhook for ${ch?.label ?? channelId}`);
    return;
  }

  const port = ch.webhookPort;
  const path = `/webhook/${channelId}`;

  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    ok(`${ch.label} webhook reachable`, `HTTP ${res.status}`);
  } catch (e) {
    fail(`${ch.label} webhook not reachable`, `http://localhost:${port}${path}`);
    info('Start server with markus start or check if channel is enabled');
  }
}

// ─── CLI registration ─────────────────────────────────────────────────────────

export function registerChannelCommand(program: Command) {
  const channel = program
    .command('channel')
    .description('Configure and manage communication channels (飞书/Telegram/WhatsApp/Slack/钉钉/企业微信)');

  channel
    .command('setup [channel]')
    .description('Interactive channel setup (or specify channel id)')
    .option('--non-interactive', 'Use environment variables only')
    .action(async (channelId, opts) => {
      if (opts.nonInteractive) {
        const config = loadConfig(undefined);
        console.log(JSON.stringify(config.integrations ?? {}, null, 2));
        return;
      }
      await interactiveSetup(channelId);
    });

  channel
    .command('status')
    .description('Show channel configuration status')
    .action(async () => { await listStatus(); });

  channel
    .command('test <channel>')
    .description('Test webhook connectivity for a channel')
    .action(async (channelId) => { await testWebhook(channelId); });

  channel
    .command('list')
    .description('List all supported channels')
    .action(() => {
      console.log(`\n${C.BOLD}Supported Channels:${C.RESET}\n`);
      for (const ch of CHANNELS) {
        const webhooks = ch.webhookPort ? ` ${C.CYAN}webhook:${ch.webhookPort}${C.RESET}` : '';
        console.log(`  ${C.BOLD}${ch.label.padEnd(14)}${C.RESET} ${ch.id.padEnd(12)} ${C.DIM}${ch.description}${webhooks}${C.RESET}`);
      }
      console.log(`\n  ${C.DIM}Run: markus channel setup [channel-id]${C.RESET}\n`);
    });
}