import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { allTemplateDirs, resolveTemplatesDir, resolveWebUiDir } from '../paths.js';
import {
  loadConfig,
  getDefaultConfigPath,
  createLogger,
  type LLMProviderConfig,
} from '@markus/shared';
import {
  AgentManager,
  LLMRouter,
  LLMLogger,
  type LLMLogEntry,
  RoleLoader,
  createDefaultSkillRegistry,
  ExternalAgentGateway,
  type GatewayStore,
  type ExternalAgentRegistration,
} from '@markus/core';
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

const log = createLogger('cli');

export function registerStartCommand(program: Command) {
  program
    .command('start')
    .description('Start the Markus server (auto-initializes on first run)')
    .option('--setup', 'Force re-run the interactive setup wizard before starting')
    .action(async (opts) => {
      const globalOpts = program.optsWithGlobals();
      const configPath = globalOpts.config ?? getDefaultConfigPath();

      // Auto-detect first run: no config file → run setup wizard
      if (opts.setup || !existsSync(configPath)) {
        if (!existsSync(configPath)) {
          console.log('  No configuration found — running first-time setup...\n');
        }
        const { quickInit } = await import('./init.js');
        await quickInit();
      }

      const config = loadConfig(globalOpts.config);
      await startServer(config, { port: globalOpts.port, config: globalOpts.config });
    });
}

async function createServices(config: ReturnType<typeof loadConfig>) {
  const templateDirs = allTemplateDirs('roles');
  if (templateDirs.length === 0) templateDirs.push(resolveTemplatesDir('roles'));
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

  const openrouterKey =
    config.llm.providers['openrouter']?.apiKey ?? process.env['OPENROUTER_API_KEY'];
  if (openrouterKey) {
    providerConfigs['openrouter'] = {
      provider: 'openrouter',
      model: process.env['OPENROUTER_MODEL'] ?? 'xiaomi/mimo-v2-pro',
      apiKey: openrouterKey,
      baseUrl:
        process.env['OPENROUTER_BASE_URL'] ??
        config.llm.providers['openrouter']?.baseUrl ??
        'https://openrouter.ai/api/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'openrouter') {
      defaultProvider = 'openrouter';
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

  const skillDirs = allTemplateDirs('skills');
  const skillRegistry = await createDefaultSkillRegistry({
    extraSkillDirs: skillDirs,
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

  // Inject project node_modules/.bin into PATH so agents can invoke `markus` via shell_execute
  const projectBin = join(process.cwd(), 'node_modules', '.bin');
  const currentPath = process.env['PATH'] ?? '';
  if (!currentPath.includes(projectBin)) {
    process.env['PATH'] = `${projectBin}:${currentPath}`;
  }

  // Propagate markus.json security settings into env so downstream services can read them
  if (config.security?.adminPassword && !process.env['ADMIN_PASSWORD']) {
    process.env['ADMIN_PASSWORD'] = config.security.adminPassword;
  }

  // Propagate markus.json search API keys into env so web_search tool can read them
  if (config.integrations?.search?.serperApiKey && !process.env['SERPER_API_KEY']) {
    process.env['SERPER_API_KEY'] = config.integrations.search.serperApiKey;
  }
  if (config.integrations?.search?.braveApiKey && !process.env['BRAVE_SEARCH_API_KEY']) {
    process.env['BRAVE_SEARCH_API_KEY'] = config.integrations.search.braveApiKey;
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

  // Serve pre-built Web UI if available
  const webUiDir = resolveWebUiDir();
  if (webUiDir) {
    apiServer.setWebUiDir(webUiDir);
    log.info('Web UI static files enabled', { dir: webUiDir });
  }

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

  // Auto-resume in_progress tasks after agents are fully loaded.
  // Tasks retain their execution history in DB (task_logs + comments),
  // so the agent receives full previous context on resume.
  setTimeout(async () => {
    try {
      await taskService.resumeInProgressTasks();
    } catch (err) {
      log.warn('Failed to auto-resume in_progress tasks', { error: String(err) });
    }
  }, 3000);

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

  // Wire activity persistence to SQLite
  if (storage?.activityRepo) {
    const actRepo = storage.activityRepo;
    agentManager.setActivityCallbacks({
      onStart: (activity) => {
        try {
          actRepo.insertActivity({
            id: activity.id,
            agentId: activity.agentId,
            type: activity.type,
            label: activity.label,
            taskId: activity.taskId,
            startedAt: activity.startedAt,
          });
        } catch (err) {
          log.warn('Failed to persist activity start', { activityId: activity.id, error: String(err) });
        }
      },
      onLog: (data) => {
        try {
          actRepo.insertActivityLog(data);
        } catch (err) {
          log.warn('Failed to persist activity log', { activityId: data.activityId, error: String(err) });
        }
      },
      onEnd: (activityId, summary) => {
        try {
          actRepo.updateActivity(activityId, summary);
        } catch (err) {
          log.warn('Failed to persist activity end', { activityId, error: String(err) });
        }
      },
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
  const webUiLine = webUiDir
    ? `  Web UI:      http://localhost:${apiPort}  (built-in)`
    : `  Web UI:      http://localhost:${webPort}  (run: pnpm --filter @markus/web-ui dev)`;
  console.log(`
  Markus is running!

  API Server:  http://localhost:${apiPort}
${webUiLine}
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

