#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, createLogger } from '@markus/shared';
import { AgentManager, LLMRouter, RoleLoader } from '@markus/core';
import { OrganizationService, TaskService, APIServer, initStorage } from '@markus/org-manager';
import { MessageRouter, FeishuAdapter, WebUIAdapter } from '@markus/comms';

// Load .env file from project root
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

const log = createLogger('cli');

const HELP = `
markus - AI Digital Employee Platform CLI

Usage:
  markus <command> [options]

Commands:
  start           Start the Markus server (API + Web UI + Comms)
  agent:list      List all agents
  agent:create    Create a new agent
  agent:chat      Chat with an agent interactively
  agent:status    Show detailed agent status
  role:list       List available role templates
  db:init         Initialize database (run migrations)
  version         Show version
  help            Show this help message

Options:
  --config, -c    Path to markus.json config file
  --port, -p      API server port (default: 3001)

Examples:
  markus start
  markus agent:create --name Alice --role developer
  markus agent:chat --id agt_xxx
  markus role:list
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return;
  }

  if (command === 'version' || command === '--version') {
    console.log('markus v0.1.0');
    return;
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      config: { type: 'string', short: 'c' },
      port: { type: 'string', short: 'p' },
      name: { type: 'string', short: 'n' },
      role: { type: 'string', short: 'r' },
      id: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const config = loadConfig(values['config'] as string | undefined);

  switch (command) {
    case 'start':
      await startServer(config, values);
      break;
    case 'agent:list':
      await listAgents(config);
      break;
    case 'agent:create':
      await createAgent(config, values);
      break;
    case 'agent:chat':
      await chatWithAgent(config, values);
      break;
    case 'agent:status':
      await agentStatus(config, values);
      break;
    case 'role:list':
      await listRoles(config);
      break;
    case 'db:init':
      await dbInit(config);
      break;
    default:
      console.error(`Unknown command: ${command}\nRun 'markus help' for usage.`);
      process.exit(1);
  }
}

async function createServices(config: ReturnType<typeof loadConfig>) {
  const templateDirs = [resolve(process.cwd(), 'templates', 'roles')];
  const roleLoader = new RoleLoader(templateDirs);

  const providerConfigs: Record<string, import('@markus/shared').LLMProviderConfig> = {};
  let defaultProvider = config.llm.defaultProvider;

  const anthropicKey = config.llm.providers['anthropic']?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    providerConfigs['anthropic'] = {
      provider: 'anthropic',
      model: config.llm.defaultModel,
      apiKey: anthropicKey,
    };
  }

  const openaiKey = config.llm.providers['openai']?.apiKey ?? process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    providerConfigs['openai'] = {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: openaiKey,
    };
  }

  const deepseekKey = config.llm.providers['deepseek']?.apiKey ?? process.env['DEEPSEEK_API_KEY'];
  if (deepseekKey) {
    providerConfigs['deepseek'] = {
      provider: 'openai',
      model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
      apiKey: deepseekKey,
      baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? config.llm.providers['deepseek']?.baseUrl ?? 'https://api.deepseek.com',
    };
    if (!anthropicKey || config.llm.defaultProvider === 'deepseek') {
      defaultProvider = 'deepseek';
    }
  }

  const llmRouter = LLMRouter.createDefault(providerConfigs, defaultProvider);

  const agentManager = new AgentManager({
    llmRouter,
    roleLoader,
    dataDir: resolve(process.cwd(), '.markus', 'agents'),
  });

  const storage = await initStorage(config.database?.url);
  const orgService = new OrganizationService(agentManager, roleLoader, storage ?? undefined);
  const taskService = new TaskService();
  taskService.setAgentManager(agentManager);

  await orgService.createOrganization(config.org.name, 'default', 'default');

  return { agentManager, orgService, taskService, roleLoader, llmRouter };
}

async function startServer(
  config: ReturnType<typeof loadConfig>,
  values: Record<string, unknown>,
) {
  console.log('Starting Markus server...');

  const { orgService, taskService, agentManager } = await createServices(config);

  const apiPort = Number(values['port']) || config.server.apiPort;
  const apiServer = new APIServer(orgService, taskService, apiPort);
  apiServer.start();
  taskService.setWSBroadcaster(apiServer.getWSBroadcaster());

  const messageRouter = new MessageRouter();
  const webUIAdapter = new WebUIAdapter();
  messageRouter.registerAdapter(webUIAdapter);

  messageRouter.setAgentHandler(async (agentId, message) => {
    try {
      const agent = agentManager.getAgent(agentId);
      return await agent.handleMessage(message.content.text ?? '', message.senderId);
    } catch (error) {
      log.error('Agent message handler error', { error: String(error) });
      return undefined;
    }
  });

  await messageRouter.connectAll([{ platform: 'webui', port: 3002 }]);

  // Check for Feishu config
  const feishuAppId = process.env['FEISHU_APP_ID'];
  const feishuAppSecret = process.env['FEISHU_APP_SECRET'];
  if (feishuAppId && feishuAppSecret) {
    const feishuAdapter = new FeishuAdapter();
    messageRouter.registerAdapter(feishuAdapter);
    await messageRouter.connectAll([{
      platform: 'feishu',
      appId: feishuAppId,
      appSecret: feishuAppSecret,
    }]);
    console.log('  Feishu integration enabled');
  }

  console.log(`
  Markus is running!

  API Server:  http://localhost:${apiPort}
  Web UI:      Open packages/web-ui/index.html in a browser
  WebUI Comm:  http://localhost:3002

  Press Ctrl+C to stop.
  `);

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    apiServer.stop();
    messageRouter.disconnectAll().then(() => process.exit(0));
  });

  // Keep alive
  await new Promise(() => {});
}

async function listAgents(config: ReturnType<typeof loadConfig>) {
  const { agentManager } = await createServices(config);
  const agents = agentManager.listAgents();

  if (agents.length === 0) {
    console.log('No agents found. Create one with: markus agent:create --name <name> --role <role>');
    return;
  }

  console.log('\nDigital Employees:');
  console.log('─'.repeat(60));
  for (const a of agents) {
    console.log(`  ${a.name.padEnd(20)} ${a.role.padEnd(20)} ${a.status}`);
  }
}

async function createAgent(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  const name = values['name'] as string;
  const roleName = values['role'] as string;

  if (!name || !roleName) {
    console.error('Usage: markus agent:create --name <name> --role <role>');
    console.error('Available roles:');
    const { roleLoader } = await createServices(config);
    for (const r of roleLoader.listAvailableRoles()) {
      console.error(`  - ${r}`);
    }
    process.exit(1);
  }

  const { agentManager } = await createServices(config);
  const agent = await agentManager.createAgent({ name, roleName });

  console.log(`\nAgent created successfully!`);
  console.log(`  ID:   ${agent.id}`);
  console.log(`  Name: ${agent.config.name}`);
  console.log(`  Role: ${agent.role.name}`);
}

async function chatWithAgent(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  const agentId = values['id'] as string;

  const { agentManager } = await createServices(config);

  let agent;
  if (agentId) {
    agent = agentManager.getAgent(agentId);
  } else {
    const agents = agentManager.listAgents();
    if (agents.length === 0) {
      console.error('No agents found. Create one first with: markus agent:create');
      process.exit(1);
    }
    agent = agentManager.getAgent(agents[0]!.id);
  }

  console.log(`\nChatting with ${agent.config.name} (${agent.role.name})`);
  console.log('Type "quit" to exit.\n');

  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () => {
    rl.question('You: ', async (input: string) => {
      const text = input.trim();
      if (text === 'quit' || text === 'exit') {
        rl.close();
        return;
      }

      if (!text) {
        ask();
        return;
      }

      try {
        const reply = await agent.handleMessage(text);
        console.log(`\n${agent.config.name}: ${reply}\n`);
      } catch (error) {
        console.error(`Error: ${String(error)}`);
      }

      ask();
    });
  };

  await agent.start();
  ask();
}

async function listRoles(config: ReturnType<typeof loadConfig>) {
  const { roleLoader } = await createServices(config);
  const roles = roleLoader.listAvailableRoles();

  if (roles.length === 0) {
    console.log('No role templates found in templates/roles/');
    return;
  }

  console.log('\nAvailable Role Templates:');
  console.log('─'.repeat(40));
  for (const r of roles) {
    console.log(`  ${r}`);
  }
}

async function agentStatus(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  const agentId = values['id'] as string;
  if (!agentId) {
    console.error('Usage: markus agent:status --id <agent_id>');
    process.exit(1);
  }

  const { agentManager } = await createServices(config);
  const agent = agentManager.getAgent(agentId);
  const state = agent.getState();

  console.log(`\nAgent Status: ${agent.config.name}`);
  console.log('─'.repeat(50));
  console.log(`  ID:            ${agentId}`);
  console.log(`  Role:          ${agent.role.name}`);
  console.log(`  Status:        ${state.status}`);
  console.log(`  Tokens Today:  ${state.tokensUsedToday}`);
  console.log(`  Current Task:  ${state.currentTaskId ?? 'none'}`);
  console.log(`  Container ID:  ${state.containerId ?? 'none'}`);
  console.log(`  Heartbeat:     ${state.lastHeartbeat ?? 'none'}`);
  console.log(`  Skills:        ${agent.config.skills?.join(', ') ?? 'none'}`);
}

async function dbInit(config: ReturnType<typeof loadConfig>) {
  const dbUrl = config.database?.url ?? process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('No DATABASE_URL configured. Set it in .env or markus.json');
    process.exit(1);
  }

  console.log('Initializing database...');
  console.log(`  URL: ${dbUrl.replace(/:[^@]*@/, ':***@')}`);

  try {
    const { execSync } = await import('node:child_process');
    const cwd = resolve(process.cwd(), 'packages', 'storage');
    execSync('npx drizzle-kit push', { cwd, stdio: 'inherit', env: { ...process.env, DATABASE_URL: dbUrl } });
    console.log('\nDatabase initialized successfully!');
  } catch (error) {
    console.error(`\nDatabase initialization failed: ${String(error)}`);
    console.error('\nMake sure PostgreSQL is running and the DATABASE_URL is correct.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
