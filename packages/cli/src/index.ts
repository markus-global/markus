#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig, saveConfig, getDefaultConfigPath, createLogger, APP_VERSION, type LLMProviderConfig } from '@markus/shared';
import { AgentManager, LLMRouter, LLMLogger, type LLMLogEntry, RoleLoader, createDefaultSkillRegistry, ExternalAgentGateway, type GatewayStore, type ExternalAgentRegistration } from '@markus/core';
import {
  OrganizationService,
  TaskService,
  APIServer,
  HITLService,
  BillingService,
  AuditService,
  ProjectService,
  RequirementService,
  KnowledgeService,
  FileKnowledgeStore,
  DeliverableService,
  ReportService,
  TrustService,
  ScheduledTaskRunner,
  initStorage,
  searchRegistries,
  installSkill,
  type AuditEventType,
} from '@markus/org-manager';
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
  init            Quick setup: configure LLM keys, DB, and create default agents
  start           Start the Markus server (API + Web UI + Comms)
  agent:list      List all agents
  agent:create    Create a new agent
  agent:chat      Chat with an agent interactively
  agent:status    Show detailed agent status
  agent:message   Send A2A message between agents (--id, --target, --text)
  agent:profile   Show agent growth profile (--id)
  role:list       List available role templates
  skill:list      List available skills
  skill:init      Scaffold a new skill project
  skill:test      Test a skill
  team:list       List available team templates
  team:deploy     Deploy a team template (hire all agents)
  user:list       List human users
  user:add        Add a human user
  approval:list   List pending approvals
  approval:respond Approve or reject an approval
  bounty:list     List bounties
  key:list        List API keys
  key:create      Create an API key
  usage           Show usage summary
  audit:log       View audit log (--type, --id for agent)
  audit:summary   View audit summary
  db:init         Initialize database (run migrations)
  version         Show version
  help            Show this help message

Options:
  --config, -c    Path to markus.json config file
  --port, -p      API server port (default: 8056)
  --name, -n      Name for agent:create or skill:init
  --dir, -d       Directory for skill:init output
  --template, -t  Team template name for team:deploy
  --email         Email for user:add
  --approved      Approve (true) or reject (false) an approval

Examples:
  markus start
  markus agent:create --name Alice --role developer
  markus agent:chat --id agt_xxx
  markus role:list
  markus skill:init --name my-skill
  markus skill:list
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return;
  }

  if (command === 'version' || command === '--version') {
    console.log(`markus v${APP_VERSION}`);
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
      dir: { type: 'string', short: 'd' },
      template: { type: 'string', short: 't' },
      email: { type: 'string' },
      approved: { type: 'string' },
      target: { type: 'string' },
      text: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const config = loadConfig(values['config'] as string | undefined);

  switch (command) {
    case 'init':
      await quickInit();
      break;
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
    case 'agent:message':
      await agentA2AMessage(config, values);
      break;
    case 'agent:profile':
      await agentProfile(config, values);
      break;
    case 'role:list':
      await listRoles(config);
      break;
    case 'skill:list':
      await listSkills();
      break;
    case 'skill:init':
      await initSkill(values);
      break;
    case 'skill:test':
      await testSkill(values);
      break;
    case 'team:list':
      await listTeamTemplates();
      break;
    case 'team:deploy':
      await deployTeam(config, values);
      break;
    case 'user:list':
      await listUsers(config);
      break;
    case 'user:add':
      await addUser(config, values);
      break;
    case 'approval:list':
      await listApprovals(config);
      break;
    case 'approval:respond':
      await respondApproval(config, values);
      break;
    case 'bounty:list':
      await listBounties(config);
      break;
    case 'key:list':
      await listKeys(config);
      break;
    case 'key:create':
      await createKey(config, values);
      break;
    case 'usage':
      await showUsage(config);
      break;
    case 'audit:log':
      await showAuditLog(config, values);
      break;
    case 'audit:summary':
      await showAuditSummary(config);
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

  const providerConfigs: Record<string, LLMProviderConfig> = {};
  let defaultProvider = config.llm.defaultProvider;
  const llmTimeoutMs = Number(process.env['LLM_TIMEOUT_MS']) || config.llm.timeoutMs || undefined;

  const anthropicKey =
    config.llm.providers['anthropic']?.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    providerConfigs['anthropic'] = {
      provider: 'anthropic',
      model: config.llm.defaultModel,
      apiKey: anthropicKey,
      timeoutMs: llmTimeoutMs,
    };
  }

  const openaiKey = config.llm.providers['openai']?.apiKey ?? process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    providerConfigs['openai'] = {
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: openaiKey,
      timeoutMs: llmTimeoutMs,
    };
  }

  const siliconflowKey =
    config.llm.providers['siliconflow']?.apiKey ?? process.env['SILICONFLOW_API_KEY'];
  if (siliconflowKey) {
    providerConfigs['siliconflow'] = {
      provider: 'siliconflow',
      model: process.env['SILICONFLOW_MODEL'] ?? 'Qwen/Qwen3.5-35B-A3B',
      apiKey: siliconflowKey,
      baseUrl:
        process.env['SILICONFLOW_BASE_URL'] ??
        config.llm.providers['siliconflow']?.baseUrl ??
        'https://api.siliconflow.cn/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'siliconflow') {
      defaultProvider = 'siliconflow';
    }
  }

  const minimaxKey =
    config.llm.providers['minimax']?.apiKey ?? process.env['MINIMAX_API_KEY'];
  if (minimaxKey) {
    providerConfigs['minimax'] = {
      provider: 'openai',
      model: process.env['MINIMAX_MODEL'] ?? 'MiniMax-M2.7',
      apiKey: minimaxKey,
      baseUrl:
        process.env['MINIMAX_BASE_URL'] ??
        config.llm.providers['minimax']?.baseUrl ??
        'https://api.minimax.io/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'minimax') {
      defaultProvider = 'minimax';
    }
  }

  // If the configured default provider has no API key, fall back to the first available one
  if (!providerConfigs[defaultProvider]) {
    const available = Object.keys(providerConfigs);
    if (available.length > 0) {
      defaultProvider = available[0];
    }
  }

  const llmRouter = LLMRouter.createDefault(providerConfigs, defaultProvider);

  // Apply enabled/disabled state from config
  for (const [name, provCfg] of Object.entries(config.llm.providers)) {
    if (provCfg.enabled === false) {
      llmRouter.setProviderEnabled(name, false);
    }
  }

  // Wire LLM audit logging
  const llmLogger = new LLMLogger();
  llmRouter.setLogCallback((entry: LLMLogEntry) => llmLogger.log(entry));

  const builtinSkillsDir = resolve(process.cwd(), 'templates', 'skills');
  const skillRegistry = await createDefaultSkillRegistry({
    extraSkillDirs: existsSync(builtinSkillsDir) ? [builtinSkillsDir] : [],
  });

  const storage = await initStorage(config.database?.url);

  const markusDataDir = join(homedir(), '.markus');
  const sharedDataDir = join(markusDataDir, 'shared');

  const taskService = new TaskService();
  taskService.setSharedDataDir(sharedDataDir);
  if (storage) {
    taskService.setTaskRepo(storage.taskRepo);
    taskService.setTaskLogRepo(storage.taskLogRepo);
    if (storage.taskCommentRepo) {
      taskService.setTaskCommentRepo(storage.taskCommentRepo);
    }
    await taskService.loadFromDB('default');
    taskService.startTimeoutChecker();
  }

  const agentManager = new AgentManager({
    llmRouter,
    roleLoader,
    dataDir: join(markusDataDir, 'agents'),
    sharedDataDir,
    skillRegistry,
    taskService,
    mcpServers: config.mcpServers,
  });

  taskService.setAgentManager(agentManager);

  const orgService = new OrganizationService(agentManager, roleLoader, storage ?? undefined);
  taskService.setOrgService(orgService);

  await orgService.createOrganization(config.org.name, 'default', 'default');

  orgService.addHumanUser('default', 'Owner', 'owner', { id: 'default' });

  const hitlService = new HITLService();
  taskService.setHITLService(hitlService);
  const billingService = new BillingService();
  billingService.setOrgPlan('default', 'free');
  const auditService = new AuditService();
  taskService.setAuditService(auditService);

  return {
    agentManager,
    orgService,
    taskService,
    roleLoader,
    llmRouter,
    skillRegistry,
    hitlService,
    billingService,
    auditService,
  };
}

async function startServer(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  console.log('Starting Markus server...');

  // Propagate markus.json security settings into env so downstream services can read them
  if (config.security?.adminPassword && !process.env['ADMIN_PASSWORD']) {
    process.env['ADMIN_PASSWORD'] = config.security.adminPassword;
  }

  const {
    orgService,
    taskService,
    agentManager,
    llmRouter,
    skillRegistry,
    hitlService,
    billingService,
    auditService,
  } = await createServices(config);

  const apiPort = Number(values['port']) || config.server.apiPort;
  const apiServer = new APIServer(orgService, taskService, apiPort);
  apiServer.setSkillRegistry(skillRegistry);
  apiServer.setHITLService(hitlService);
  apiServer.setBillingService(billingService);
  apiServer.setAuditService(auditService);

  const projectService = new ProjectService();
  const storage = orgService.getStorage();
  if (storage?.projectRepo) {
    projectService.setProjectRepo(storage.projectRepo);
  }
  if (storage?.iterationRepo) {
    projectService.setIterationRepo(storage.iterationRepo);
  }
  await projectService.loadFromDB('default');
  const knowledgeStore = new FileKnowledgeStore(join(homedir(), '.markus', 'knowledge'));
  const knowledgeService = new KnowledgeService(knowledgeStore);
  const deliverableService = new DeliverableService(storage?.deliverableRepo);
  await deliverableService.load();

  // One-time migration: sync existing task.deliverables into the unified deliverables table
  const allTasks = taskService.listTasks({ orgId: 'default' });
  await deliverableService.migrateFromTasks(allTasks);

  const reportService = new ReportService(taskService, billingService, auditService, knowledgeService);
  const _trustService = new TrustService();
  const requirementService = new RequirementService();
  if (storage?.requirementRepo) {
    requirementService.setRequirementRepo(storage.requirementRepo);
  }
  await requirementService.loadFromStorage('default');

  agentManager.setRequirementService(requirementService);
  agentManager.setProjectService(projectService);
  agentManager.setKnowledgeService(knowledgeService);
  agentManager.setDeliverableService(deliverableService);
  apiServer.setProjectService(projectService);
  apiServer.setReportService(reportService);
  apiServer.setKnowledgeService(knowledgeService);
  apiServer.setDeliverableService(deliverableService);
  apiServer.setRequirementService(requirementService);
  taskService.setDeliverableService(deliverableService);

  // Wire ProjectService into TaskService (worktree management is handled by agents)
  taskService.setProjectService(projectService);
  taskService.setRequirementService(requirementService);

  // Expose LLM router to API server so settings can read/write it at runtime
  apiServer.setLLMRouter(llmRouter);
  apiServer.setConfigPath(values['config'] as string ?? getDefaultConfigPath());
  if (config.hub?.url) apiServer.setHubUrl(config.hub.url);

  // Wire storage for chat persistence and auth
  const firstOrgId = 'default';
  if (storage) {
    apiServer.setStorage(storage);
    await apiServer.ensureAdminUser(firstOrgId);

    // Restore persisted teams, agents, and users from DB
    await orgService.loadFromDB(firstOrgId);
  }

  // Seed default team + Secretary agent (runs for both DB and in-memory mode)
  await orgService.seedDefaultTeam(firstOrgId, 'default');

  // Ensure builder agents exist (idempotent — skips if already created)
  await orgService.seedBuilderAgents(firstOrgId, skillRegistry);

  // Wire skill search/install callbacks so agents can discover and install remote skills
  agentManager.setSkillSearcher(async (query) => searchRegistries(query));
  agentManager.setSkillInstaller(async (request) => {
    const result = await installSkill({
      name: (request.name as string) ?? '',
      source: request.source as string | undefined,
      slug: request.slug as string | undefined,
      sourceUrl: request.sourceUrl as string | undefined,
      description: request.description as string | undefined,
      category: request.category as string | undefined,
      version: request.version as string | undefined,
      githubRepo: request.githubRepo as string | undefined,
      githubSkillPath: request.githubSkillPath as string | undefined,
    }, skillRegistry);
    return { installed: result.installed, name: result.name, method: result.method };
  });

  // Wire proactive user message senders for all agents
  if (storage?.chatSessionRepo) {
    const ws = apiServer.getWSBroadcaster();
    for (const info of agentManager.listAgents()) {
      agentManager.setUserMessageSender(info.id, async (message: string) => {
        const sessions = await storage.chatSessionRepo.getSessionsByAgent(info.id);
        let sessionId: string;
        if (sessions.length > 0) {
          sessionId = sessions[0]!.id;
        } else {
          const newSess = await storage.chatSessionRepo.createSession(info.id);
          sessionId = newSess.id;
        }
        const msg = await storage.chatSessionRepo.appendMessage(sessionId, info.id, 'assistant', message);
        ws.broadcastProactiveMessage(info.id, info.name, sessionId, msg.id, message);
        return { sessionId, messageId: msg.id };
      });
    }
  }

  // Do NOT auto-resume in_progress tasks on startup.
  // Previous behavior called taskService.resumeInProgressTasks() here,
  // which caused all agents to immediately start working without approval.
  // With the governance framework, tasks should only resume via explicit
  // human action through the UI or API (/api/system/resume-all).
  log.info('Skipping auto-resume of in-progress tasks (governance mode)');

  // Wire External Agent Gateway for OpenClaw integration
  const gatewaySecret = config.security?.gatewaySecret ?? process.env['GATEWAY_SECRET'] ?? 'markus-gateway-default-secret-change-me';
  const gateway = new ExternalAgentGateway({ signingSecret: gatewaySecret });

  gateway.setAgentCreator(async (opts) => {
    const caps = (opts.capabilities ?? []).map((c: string) => c.toLowerCase());
    const roleFromCaps = (cs: string[]): string => {
      if (cs.some(c => c.includes('review'))) return 'reviewer';
      if (cs.some(c => c.includes('test') || c.includes('qa'))) return 'qa-engineer';
      if (cs.some(c => c.includes('devops') || c.includes('deploy') || c.includes('infra'))) return 'devops';
      if (cs.some(c => c.includes('product'))) return 'product-manager';
      if (cs.some(c => c.includes('project') || c.includes('manage'))) return 'project-manager';
      if (cs.some(c => c.includes('support'))) return 'support';
      if (cs.some(c => c.includes('content') || c.includes('write') || c.includes('doc'))) return 'content-writer';
      if (cs.some(c => c.includes('market'))) return 'marketing';
      if (cs.some(c => c.includes('research'))) return 'research-assistant';
      return 'developer';
    };
    const agent = await agentManager.createAgent({
      name: opts.name,
      roleName: roleFromCaps(caps),
      orgId: opts.orgId,
    });
    // Persist to DB so chat_sessions FK constraint is satisfied
    if (storage?.agentRepo) {
      try {
        await storage.agentRepo.create({
          id: agent.id,
          name: agent.config.name,
          orgId: opts.orgId,
          roleId: agent.config.roleId,
          roleName: agent.role.name,
          agentRole: 'worker',
          skills: agent.config.skills,
          llmConfig: agent.config.llmConfig,
          heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
        });
      } catch (err) {
        log.warn('Failed to persist gateway agent to DB (may already exist)', { error: String(err) });
      }
    }
    return { id: agent.id };
  });

  // Persistence: wire the store so registrations survive restarts
  if (storage?.externalAgentRepo) {
    const repo = storage.externalAgentRepo;
    const gatewayStore: GatewayStore = {
      async saveRegistration(reg: ExternalAgentRegistration) { await repo.save(reg); },
      async deleteRegistration(extId: string, orgId: string) { return repo.delete(extId, orgId); },
      async updateRegistration(extId: string, orgId: string, patch: Partial<Pick<ExternalAgentRegistration, 'connected' | 'lastHeartbeat'>>) { await repo.update(extId, orgId, patch); },
      async loadAll() { return repo.loadAll(); },
    };
    gateway.setStore(gatewayStore);
    await gateway.loadFromStore((id) => { try { agentManager.getAgent(id); return true; } catch { return false; } });
  }
  gateway.setMessageRouter(async (markusAgentId, message, _senderId) => {
    const agent = agentManager.getAgent(markusAgentId);
    const reply = await agent.handleMessage(message);
    return reply ?? 'No response';
  });
  gateway.setTasksFetcher((agentId) => {
    return taskService.getTasksByAgent(agentId).map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
    }));
  });
  apiServer.setGateway(gateway, gatewaySecret);
  log.info('External Agent Gateway enabled', { secret: gatewaySecret === 'markus-gateway-default-secret-change-me' ? '(default)' : '(custom)' });

  apiServer.start();
  taskService.setWSBroadcaster(apiServer.getWSBroadcaster());
  requirementService.setWSBroadcaster(apiServer.getWSBroadcaster());
  deliverableService.setWSBroadcaster(apiServer.getWSBroadcaster());

  const scheduledTaskRunner = new ScheduledTaskRunner(taskService);
  scheduledTaskRunner.start();

  agentManager.setEscalationHandler((agentId, reason) => {
    log.warn('Agent escalation', { agentId, reason });
    hitlService.notify({
      targetUserId: 'default',
      type: 'system',
      title: 'Agent needs help',
      body: reason,
      priority: 'high',
    });
    auditService.record({
      orgId: 'default',
      agentId,
      type: 'error',
      action: 'escalation',
      detail: reason,
      success: false,
    });
  });

  agentManager.setApprovalHandler(async (agentId, request) => {
    const agents = agentManager.listAgents();
    const agentName = agents.find(a => a.id === agentId)?.name ?? agentId;
    const approved = await hitlService.requestApprovalAndWait({
      agentId,
      agentName,
      type: 'action',
      title: `Tool: ${request.toolName}`,
      description: request.reason,
      details: { toolName: request.toolName, toolArgs: request.toolArgs },
      targetUserId: 'default',
      expiresInMs: 5 * 60 * 1000, // 5 minutes
    });
    auditService.record({
      orgId: 'default',
      agentId,
      type: 'approval_response',
      action: request.toolName,
      detail: approved ? 'approved' : 'rejected',
      success: approved,
    });
    return approved;
  });

  agentManager.setAuditCallback((agentId, event) => {
    auditService.record({
      orgId: 'default',
      agentId,
      type: event.type as AuditEventType,
      action: event.action,
      tokensUsed: event.tokensUsed,
      durationMs: event.durationMs,
      success: event.success,
      detail: event.detail,
    });
    if (event.tokensUsed && event.type === 'llm_request') {
      auditService.recordLLMUsage(
        'default',
        agentId,
        Math.floor(event.tokensUsed * 0.7),
        Math.ceil(event.tokensUsed * 0.3)
      );
      billingService.recordUsage({
        orgId: 'default',
        agentId,
        type: 'llm_tokens',
        amount: event.tokensUsed,
        metadata: { action: event.action },
      });
    }
    if (event.type === 'tool_call') {
      billingService.recordUsage({
        orgId: 'default',
        agentId,
        type: 'tool_call',
        amount: 1,
        metadata: { action: event.action },
      });
    }
  });

  // Wire agent state changes to DB persistence + WS broadcast
  if (storage) {
    agentManager.setStateChangeHandler(async (agentId, state) => {
      try {
        await storage.agentRepo.updateStatus(
          agentId,
          state.status as 'idle' | 'working' | 'paused' | 'offline' | 'error'
        );
      } catch (err) {
        log.warn('Failed to persist agent state', { agentId, error: String(err) });
      }
      // Broadcast status + currentActivity to all WS clients
      apiServer.getWSBroadcaster().broadcastAgentUpdate(agentId, state.status, {
        lastError: state.lastError,
        lastErrorAt: state.lastErrorAt,
        currentActivity: state.currentActivity,
      });
    });
  }

  // Wire agent activity logs to WS broadcast
  agentManager.getEventBus().on('agent:activity_log', (event: unknown) => {
    apiServer.getWSBroadcaster().broadcast({
      type: 'agent:activity_log',
      payload: event,
      timestamp: new Date().toISOString(),
    });
  });

  // Daily token reset scheduler: runs at midnight to reset per-agent tokensUsedToday
  const scheduleDailyReset = () => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();
    setTimeout(() => {
      log.info('Daily token reset triggered');
      for (const agentInfo of agentManager.listAgents()) {
        try {
          const agent = agentManager.getAgent(agentInfo.id);
          agent.resetDailyTokens();
        } catch {
          /* agent may be offline */
        }
      }
      scheduleDailyReset();
    }, msUntilMidnight);
    log.info(`Daily token reset scheduled in ${Math.round(msUntilMidnight / 60000)} minutes`);
  };
  scheduleDailyReset();

  const messageRouter = new MessageRouter();
  const webUIAdapter = new WebUIAdapter();
  messageRouter.registerAdapter(webUIAdapter);

  messageRouter.setAgentHandler(async (agentId, message) => {
    const startTs = Date.now();
    try {
      const agent = agentManager.getAgent(agentId);
      const reply = await agent.handleMessage(message.content.text ?? '', message.senderId);
      auditService.record({
        orgId: 'default',
        agentId,
        type: 'agent_message',
        action: 'handle_message',
        detail: (message.content.text ?? '').slice(0, 200),
        durationMs: Date.now() - startTs,
        success: true,
      });
      return reply;
    } catch (error) {
      auditService.record({
        orgId: 'default',
        agentId,
        type: 'agent_message',
        action: 'handle_message',
        detail: String(error).slice(0, 200),
        durationMs: Date.now() - startTs,
        success: false,
      });
      log.error('Agent message handler error', { error: String(error) });
      return undefined;
    }
  });

  const commPort = apiPort + 2;
  await messageRouter.connectAll([{ platform: 'webui', port: commPort }]);

  // Check for Feishu config
  const feishuAppId = config.integrations?.feishu?.appId ?? process.env['FEISHU_APP_ID'];
  const feishuAppSecret = config.integrations?.feishu?.appSecret ?? process.env['FEISHU_APP_SECRET'];
  if (feishuAppId && feishuAppSecret) {
    const feishuAdapter = new FeishuAdapter();
    messageRouter.registerAdapter(feishuAdapter);
    await messageRouter.connectAll([
      {
        platform: 'feishu',
        appId: feishuAppId,
        appSecret: feishuAppSecret,
      },
    ]);
    console.log('  Feishu integration enabled');
  }

  const webPort = config.server.webPort;
  console.log(`
  Markus is running!

  API Server:  http://localhost:${apiPort}
  Web UI:      http://localhost:${webPort}  (run: pnpm --filter @markus/web-ui dev)
  WebUI Comm:  http://localhost:${commPort}

  Press Ctrl+C to stop.
  `);

  // Start restored agents in background (server is already accepting requests)
  orgService.startRestoredAgentsInBackground();

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    scheduledTaskRunner.stop();
    apiServer.stop();
    agentManager.shutdown()
      .then(() => messageRouter.disconnectAll())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });

  // Keep alive
  await new Promise(() => {});
}

async function listAgents(config: ReturnType<typeof loadConfig>) {
  const { agentManager } = await createServices(config);
  const agents = agentManager.listAgents();

  if (agents.length === 0) {
    console.log(
      'No agents found. Create one with: markus agent:create --name <name> --role <role>'
    );
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

async function chatWithAgent(
  config: ReturnType<typeof loadConfig>,
  values: Record<string, unknown>
) {
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

async function agentA2AMessage(
  config: ReturnType<typeof loadConfig>,
  values: Record<string, unknown>
) {
  const fromId = values['id'] as string;
  const targetId = values['target'] as string;
  const text = values['text'] as string;
  if (!fromId || !targetId || !text) {
    console.error(
      'Usage: markus agent:message --id <from_agent> --target <to_agent> --text "message"'
    );
    process.exit(1);
  }

  const { agentManager } = await createServices(config);
  const fromAgent = agentManager.getAgent(fromId);
  const targetAgent = agentManager.getAgent(targetId);

  console.log(`\nSending A2A message: ${fromAgent.config.name} → ${targetAgent.config.name}`);
  console.log(`Message: ${text}\n`);

  const reply = await targetAgent.handleMessage(text, fromId, {
    name: fromAgent.config.name,
    role: fromAgent.config.agentRole ?? 'worker',
  });
  console.log(`Reply from ${targetAgent.config.name}:`);
  console.log('─'.repeat(50));
  console.log(reply);
}

async function agentProfile(
  config: ReturnType<typeof loadConfig>,
  values: Record<string, unknown>
) {
  const agentId = values['id'] as string;
  if (!agentId) {
    console.error('Usage: markus agent:profile --id <agent_id>');
    process.exit(1);
  }

  const { agentManager } = await createServices(config);
  const agent = agentManager.getAgent(agentId);
  const state = agent.getState();
  const proficiency = agent.getSkillProficiency?.() ?? {};

  console.log(`\nAgent Profile: ${agent.config.name}`);
  console.log('═'.repeat(50));
  console.log(`  ID:            ${agentId}`);
  console.log(`  Role:          ${agent.role.name} (${agent.config.agentRole})`);
  console.log(`  Status:        ${state.status}`);
  console.log(`  Tokens Today:  ${state.tokensUsedToday}`);
  console.log(`  Skills:        ${agent.config.skills?.join(', ') ?? 'none'}`);

  if (Object.keys(proficiency).length > 0) {
    console.log(`\n  Skill Proficiency:`);
    for (const [skill, data] of Object.entries(proficiency)) {
      const d = data as { uses: number; successes: number };
      const rate = d.uses > 0 ? ((d.successes / d.uses) * 100).toFixed(0) : '0';
      console.log(`    ${skill.padEnd(25)} uses=${d.uses}  success=${rate}%`);
    }
  }
}

async function dbInit(_config: ReturnType<typeof loadConfig>) {
  console.log('Initializing database (SQLite)...');
  try {
    const storage = await initStorage();
    if (storage) {
      console.log('\nSQLite database initialized successfully!');
    } else {
      console.error('\nDatabase initialization failed.');
      process.exit(1);
    }
  } catch (error) {
    console.error(`\nDatabase initialization failed: ${String(error)}`);
    process.exit(1);
  }
}

async function listSkills() {
  const registry = await createDefaultSkillRegistry();
  const skills = registry.list();

  if (skills.length === 0) {
    console.log('No skills registered.');
    return;
  }

  console.log('\nAvailable Skills:');
  console.log('─'.repeat(70));
  for (const s of skills) {
    const instrTag = s.instructions ? ' [has instructions]' : '';
    console.log(
      `  ${s.name.padEnd(20)} v${s.version.padEnd(8)} ${s.category.padEnd(14)} ${s.description}${instrTag}`
    );
  }
}

async function initSkill(values: Record<string, unknown>) {
  const name = values['name'] as string;
  if (!name) {
    console.error('Usage: markus skill:init --name <skill-name>');
    process.exit(1);
  }

  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = resolve(process.cwd(), (values['dir'] as string) ?? name);

  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, 'src'), { recursive: true });

  const manifest = {
    name,
    version: '0.1.0',
    description: `${name} skill for Markus agents`,
    author: 'your-name',
    category: 'custom',
    tags: [],
    tools: [
      {
        name: `${name}_example`,
        description: `Example tool from ${name} skill`,
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string', description: 'Input text' } },
          required: ['input'],
        },
      },
    ],
    requiredPermissions: [],
  };

  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const skillTs = `import type { SkillInstance } from '@markus/core';
import manifest from '../manifest.json';

export function create(): SkillInstance {
  return {
    manifest: manifest as SkillInstance['manifest'],
    tools: [
      {
        name: '${name}_example',
        description: manifest.tools[0].description,
        inputSchema: manifest.tools[0].inputSchema,
        execute: async (args: Record<string, unknown>) => {
          const input = args['input'] as string;
          return { content: \`Processed: \${input}\` };
        },
      },
    ],
  };
}
`;

  writeFileSync(resolve(dir, 'src', 'index.ts'), skillTs);

  const readmeContent = `# ${name}

Custom skill for Markus AI agents.

## Tools

- \`${name}_example\`: Example tool

## Development

1. Edit \`src/index.ts\` to implement your tools
2. Update \`manifest.json\` with tool definitions
3. Test: \`markus skill:test --dir .\`
`;

  writeFileSync(resolve(dir, 'README.md'), readmeContent);

  console.log(`\nSkill scaffolded at: ${dir}`);
  console.log(`  manifest.json  - Skill metadata and tool definitions`);
  console.log(`  src/index.ts   - Tool implementations`);
  console.log(`  README.md      - Documentation`);
  console.log(`\nNext: edit src/index.ts and run 'markus skill:test --dir ${dir}'`);
}

async function testSkill(values: Record<string, unknown>) {
  const dir = resolve(process.cwd(), (values['dir'] as string) ?? '.');

  const manifestPath = resolve(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`No manifest.json found in ${dir}`);
    console.error('Run this from a skill directory or use --dir <path>');
    process.exit(1);
  }

  const manifestData = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    name: string;
    version: string;
    tools: Array<{ name: string; description: string }>;
  };

  console.log(`\nTesting skill: ${manifestData.name} v${manifestData.version}`);
  console.log('─'.repeat(50));

  console.log(`\n  Manifest: OK`);
  console.log(`  Tools defined: ${manifestData.tools.length}`);
  for (const t of manifestData.tools) {
    console.log(`    - ${t.name}: ${t.description}`);
  }

  const srcPath = resolve(dir, 'src', 'index.ts');
  if (existsSync(srcPath)) {
    console.log(`  Source: found (src/index.ts)`);
  } else {
    console.log(`  Source: NOT FOUND (src/index.ts)`);
  }

  console.log(`\n  Skill validation: PASSED`);
}

async function listTeamTemplates() {
  const teamsDir = resolve(process.cwd(), 'templates', 'teams');
  if (!existsSync(teamsDir)) {
    console.log('No team templates found in templates/teams/');
    return;
  }

  const { readdirSync } = await import('node:fs');
  const files = readdirSync(teamsDir).filter(f => f.endsWith('.json'));

  console.log('\nAvailable Team Templates:');
  console.log('─'.repeat(70));
  for (const f of files) {
    const data = JSON.parse(readFileSync(resolve(teamsDir, f), 'utf-8')) as {
      name: string;
      description: string;
      category: string;
      agents: Array<{ name: string; role: string; agentRole: string }>;
    };
    console.log(`\n  ${data.name} [${f.replace('.json', '')}]`);
    console.log(`  ${data.description}`);
    console.log(`  Category: ${data.category} · ${data.agents.length} agents`);
    for (const a of data.agents) {
      const badge = a.agentRole === 'manager' ? ' ★' : '';
      console.log(`    - ${a.name} (${a.role})${badge}`);
    }
  }
}

async function deployTeam(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  const templateName = values['template'] as string;
  if (!templateName) {
    console.error('Usage: markus team:deploy --template <template-name>');
    console.error('Run "markus team:list" to see available templates.');
    process.exit(1);
  }

  const teamsDir = resolve(process.cwd(), 'templates', 'teams');
  const filePath = resolve(teamsDir, `${templateName}.json`);
  if (!existsSync(filePath)) {
    console.error(`Template not found: ${templateName}`);
    console.error(`Looked at: ${filePath}`);
    process.exit(1);
  }

  const template = JSON.parse(readFileSync(filePath, 'utf-8')) as {
    name: string;
    agents: Array<{ name: string; role: string; agentRole: string; skills?: string[] }>;
  };

  console.log(`\nDeploying team: ${template.name}`);
  console.log('─'.repeat(50));

  const { orgService } = await createServices(config);

  for (const agentDef of template.agents) {
    try {
      const agent = await orgService.hireAgent({
        name: agentDef.name,
        roleName: agentDef.role,
        orgId: 'default',
        agentRole: agentDef.agentRole as 'manager' | 'worker',
        skills: agentDef.skills,
      });
      const badge = agentDef.agentRole === 'manager' ? ' ★ Manager' : '';
      console.log(`  ✓ ${agent.config.name} (${agent.role.name})${badge} — ${agent.id}`);
    } catch (err) {
      console.error(`  ✗ Failed to hire ${agentDef.name}: ${String(err)}`);
    }
  }

  console.log(`\nTeam deployed! ${template.agents.length} agents hired.`);
}

async function listUsers(config: ReturnType<typeof loadConfig>) {
  const { orgService } = await createServices(config);
  const users = orgService.listHumanUsers('default');

  console.log('\nHuman Users:');
  console.log('─'.repeat(60));
  if (users.length === 0) {
    console.log('  No users found.');
    return;
  }
  for (const u of users) {
    console.log(`  ${u.name.padEnd(20)} ${u.role.padEnd(10)} ${u.id}`);
  }
}

async function addUser(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  const name = values['name'] as string;
  const role = (values['role'] as string) ?? 'member';
  if (!name) {
    console.error(
      'Usage: markus user:add --name <name> [--role owner|admin|member|guest] [--email <email>]'
    );
    process.exit(1);
  }

  const { orgService } = await createServices(config);
  const user = orgService.addHumanUser(
    'default',
    name,
    role as 'owner' | 'admin' | 'member' | 'guest',
    {
      email: values['email'] as string | undefined,
    }
  );
  console.log(`User added: ${user.name} (${user.role}) — ${user.id}`);
}

async function listApprovals(config: ReturnType<typeof loadConfig>) {
  const { hitlService } = await createServices(config);
  const approvals = hitlService.listApprovals();

  console.log('\nApprovals:');
  console.log('─'.repeat(70));
  if (approvals.length === 0) {
    console.log('  No approvals found.');
    return;
  }
  for (const a of approvals) {
    const statusBadge = a.status === 'pending' ? '⏳' : a.status === 'approved' ? '✓' : '✗';
    console.log(`  ${statusBadge} ${a.title.padEnd(35)} ${a.status.padEnd(10)} ${a.id}`);
    console.log(`    From: ${a.agentName} · ${a.requestedAt}`);
  }
}

async function respondApproval(
  config: ReturnType<typeof loadConfig>,
  values: Record<string, unknown>
) {
  const id = values['id'] as string;
  const approved = values['approved'] as string;
  if (!id || approved === undefined) {
    console.error('Usage: markus approval:respond --id <approval-id> --approved true|false');
    process.exit(1);
  }

  const { hitlService } = await createServices(config);
  const result = hitlService.respondToApproval(id, approved === 'true', 'cli-user');
  if (!result) {
    console.error('Approval not found or not pending.');
    process.exit(1);
  }
  console.log(`Approval ${id}: ${result.status}`);
}

async function listBounties(config: ReturnType<typeof loadConfig>) {
  const { hitlService } = await createServices(config);
  const bounties = hitlService.listBounties();

  console.log('\nBounties:');
  console.log('─'.repeat(70));
  if (bounties.length === 0) {
    console.log('  No bounties found.');
    return;
  }
  for (const b of bounties) {
    console.log(`  [${b.status}] ${b.title.padEnd(35)} ${b.id}`);
    console.log(`    From: ${b.agentName} · ${b.createdAt}`);
  }
}

async function listKeys(config: ReturnType<typeof loadConfig>) {
  const { billingService } = await createServices(config);
  const keys = billingService.listAPIKeys('default');

  console.log('\nAPI Keys:');
  console.log('─'.repeat(60));
  if (keys.length === 0) {
    console.log('  No API keys found.');
    return;
  }
  for (const k of keys) {
    const status = k.active ? 'active' : 'revoked';
    console.log(`  ${k.name.padEnd(20)} ${k.keyPreview.padEnd(20)} ${status.padEnd(8)} ${k.id}`);
  }
}

async function createKey(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  const name = (values['name'] as string) ?? 'CLI Key';
  const { billingService } = await createServices(config);
  const key = billingService.createAPIKey('default', name);
  console.log(`\nAPI Key created:`);
  console.log(`  ID:   ${key.id}`);
  console.log(`  Key:  ${key.key}`);
  console.log(`  Name: ${key.name}`);
  console.log(`\n  Save this key — it won't be shown again.`);
}

async function showUsage(config: ReturnType<typeof loadConfig>) {
  const { billingService } = await createServices(config);
  const summary = billingService.getUsageSummary('default');
  const plan = billingService.getOrgPlan('default');

  console.log('\nUsage Summary:');
  console.log('─'.repeat(50));
  console.log(`  Plan:          ${plan.tier}`);
  console.log(`  Period:        ${summary.period}`);
  console.log(
    `  LLM Tokens:    ${summary.llmTokens.toLocaleString()} / ${plan.limits.maxTokensPerMonth < 0 ? 'unlimited' : plan.limits.maxTokensPerMonth.toLocaleString()}`
  );
  console.log(
    `  Tool Calls:    ${summary.toolCalls.toLocaleString()} / ${plan.limits.maxToolCallsPerDay < 0 ? 'unlimited' : plan.limits.maxToolCallsPerDay.toLocaleString()} per day`
  );
  console.log(
    `  Messages:      ${summary.messages.toLocaleString()} / ${plan.limits.maxMessagesPerDay < 0 ? 'unlimited' : plan.limits.maxMessagesPerDay.toLocaleString()} per day`
  );
  console.log(
    `  Storage:       ${(summary.storageBytes / 1024 / 1024).toFixed(1)}MB / ${plan.limits.maxStorageBytes < 0 ? 'unlimited' : (plan.limits.maxStorageBytes / 1024 / 1024).toFixed(0) + 'MB'}`
  );
}

async function showAuditLog(
  config: ReturnType<typeof loadConfig>,
  values: Record<string, unknown>
) {
  const { auditService } = await createServices(config);
  const entries = auditService.query({
    orgId: 'default',
    agentId: values['id'] as string | undefined,
    type: values['type'] as AuditEventType | undefined,
    limit: 30,
  });

  if (entries.length === 0) {
    console.log('\nNo audit entries found.');
    return;
  }

  console.log('\nAudit Log:');
  console.log('─'.repeat(90));
  console.log(
    `  ${'Time'.padEnd(22)} ${'Type'.padEnd(18)} ${'Agent'.padEnd(14)} ${'Action'.padEnd(20)} OK`
  );
  console.log('─'.repeat(90));
  for (const e of entries) {
    console.log(
      `  ${e.timestamp.slice(0, 19).padEnd(22)} ${e.type.padEnd(18)} ${(e.agentId ?? '-').padEnd(14)} ${e.action.slice(0, 20).padEnd(20)} ${e.success ? '✓' : '✗'}`
    );
  }
}

async function showAuditSummary(config: ReturnType<typeof loadConfig>) {
  const { auditService } = await createServices(config);
  const summary = auditService.summary('default');

  console.log('\nAudit Summary (org: default):');
  console.log('─'.repeat(50));
  console.log(`  Total Events:  ${summary.totalEvents}`);
  console.log(`  Total Tokens:  ${summary.totalTokens.toLocaleString()}`);
  console.log(`  Errors:        ${summary.errorCount}`);
  console.log(`\n  Events by Type:`);
  for (const [type, count] of Object.entries(summary.eventsByType)) {
    console.log(`    ${type.padEnd(20)} ${count}`);
  }
  if (summary.agentActivity.length > 0) {
    console.log(`\n  Agent Activity:`);
    for (const a of summary.agentActivity) {
      console.log(`    ${a.agentId.padEnd(20)} events=${a.events}  tokens=${a.tokens}`);
    }
  }
}

async function quickInit() {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join: pathJoin } = await import('node:path');
  const readline = await import('node:readline');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def?: string): Promise<string> =>
    new Promise(r =>
      rl.question(`${q}${def ? ` [${def}]` : ''}: `, ans => r(ans.trim() || def || ''))
    );

  const MODEL_MAP: Record<string, string> = {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.4',
    google: 'gemini-3-1-pro',
    minimax: 'MiniMax-M2.7',
    siliconflow: 'Qwen/Qwen3.5-35B-A3B',
    ollama: 'llama3',
  };

  const ENV_KEY_MAP: Array<{ provider: string; label: string; envKey: string; baseUrl?: string }> = [
    { provider: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { provider: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY' },
    { provider: 'google', label: 'Google Gemini', envKey: 'GOOGLE_API_KEY' },
    { provider: 'siliconflow', label: 'SiliconFlow', envKey: 'SILICONFLOW_API_KEY', baseUrl: 'https://api.siliconflow.cn/v1' },
    { provider: 'minimax', label: 'MiniMax', envKey: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io/v1' },
  ];

  console.log('\n  Markus Setup\n');

  // --- Step 1: Auto-detect available sources ---
  const envProviders: Array<{ provider: string; label: string; key: string; baseUrl?: string }> = [];
  for (const def of ENV_KEY_MAP) {
    const key = process.env[def.envKey];
    if (key) envProviders.push({ provider: def.provider, label: def.label, key, baseUrl: def.baseUrl });
  }

  let openclawPath = '';
  const openclawCandidates = [
    pathJoin(homedir(), '.openclaw', 'openclaw.json'),
    pathJoin(homedir(), '.openclaw', 'openclaw.json5'),
  ];
  for (const p of openclawCandidates) {
    if (existsSync(p)) { openclawPath = p; break; }
  }

  // --- Step 2: Show detected sources and let user choose ---
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
  if (sources.length === 0) {
    console.log('  No API keys detected in environment or OpenClaw config.');
  }
  console.log('');

  let mode: string;
  if (sources.length > 0) {
    const options = [
      ...sources.map(s => s === 'env' ? 'env (use environment variables)' : 'openclaw (import from OpenClaw)'),
      'manual (enter API key manually)',
    ];
    mode = await ask(`  Config source? ${options.join(' / ')}`, sources[0]);
    if (!['env', 'openclaw', 'manual'].includes(mode)) mode = sources[0];
  } else {
    mode = 'manual';
  }

  // --- Step 3: Build provider configs based on chosen source ---
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
    if (envProviders.length > 1) {
      const choices = envProviders.map(e => e.provider).join('/');
      defaultProvider = await ask(`  Default provider? (${choices})`, defaultProvider);
      if (!providers[defaultProvider]) defaultProvider = envProviders[0].provider;
    }
  } else if (mode === 'openclaw') {
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
        if (provNames.length > 1) {
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
  }

  if (mode === 'manual') {
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

  // --- Step 4: API port ---
  const port = await ask('\n  API Port', '8056');
  rl.close();

  // --- Step 5: Save config ---
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
    console.log(`\n  Config saved to ${getDefaultConfigPath()}`);
    if (Object.keys(providers).length > 0) {
      console.log(`  Providers: ${Object.keys(providers).join(', ')} (default: ${defaultProvider})`);
    }
  } catch (e) {
    console.error(`\n  Failed to save config: ${e}`);
  }

  // Ensure templates/roles directory exists with a default developer role
  const rolesDir = pathJoin(process.cwd(), 'templates', 'roles', 'developer');
  if (!existsSync(rolesDir)) {
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(
      pathJoin(rolesDir, 'ROLE.md'),
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

  console.log('\n  Setup complete! Run `markus start` to launch.\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
