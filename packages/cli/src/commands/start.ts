import type { Command } from 'commander';
import type { BackendInstance } from '../backend.js';
import { resolve, join, dirname, delimiter } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { allTemplateDirs, resolveTemplatesDir, resolveWebUiDir } from '../paths.js';
import {
  loadConfig,
  getDefaultConfigPath,
  createLogger,
  closeRuntimeLogger,
  checkForUpdate,
  generateId,
  userId,
  TRIAGE_MAX_TOKENS,
  TRIAGE_TEMPERATURE,
  TRIAGE_ALLOWED_TOOLS,
  type LLMProviderConfig,
  type DecisionType,
} from '@markus/shared';
import {
  AgentManager,
  LLMRouter,
  LLMLogger,
  ModelCatalogService,
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
  type NotificationPriority,
  BillingService,
  LicenseService,
  TelemetryService,
  AuditService,
  ProjectService,
  RequirementService,
  KnowledgeService,
  FileKnowledgeStore,
  DeliverableService,
  ReportService,
  TrustService,
  ArchiveService,
  StaleDetector,
  ScheduledTaskRunner,
  initStorage,
  searchRegistries,
  installSkill,
  WorkflowService,
  WorkflowRunner,
  WorkflowScheduler,
  type AuditEventType,
} from '@markus/org-manager';
import { MessageRouter, FeishuAdapter, WebUIAdapter } from '@markus/comms';
import { initStartupLogger, startupLog, startupBlank, startupSection, closeStartupLogger, getStartupLogFile } from '../utils/logger.js';
import { openBrowserAfterHealthCheck } from '../utils/browser.js';
import { StartupProgress } from '../utils/startupProgress.js';

const log = createLogger('cli');

export function registerStartCommand(program: Command) {
  program
    .command('start')
    .description('Start the Markus server (auto-initializes on first run)')
    .option('--setup', 'Force re-run the interactive setup wizard before starting')
    .action(async (opts) => {
      const globalOpts = program.optsWithGlobals();
      const configPath = globalOpts.config ?? getDefaultConfigPath();

      // Auto-detect first run: no config file → run setup wizard (non-interactive
      // so it won't hang when stdin isn't available, e.g. under concurrently/CI).
      if (opts.setup || !existsSync(configPath)) {
        if (!existsSync(configPath)) {
          console.log('  No configuration found — auto-configuring from environment...\n');
        }
        const { quickInit } = await import('./init.js');
        await quickInit({ nonInteractive: true });
      }

      const config = loadConfig(globalOpts.config);
      await startServer(config, { port: globalOpts.port, config: globalOpts.config });
    });
}

export async function createServices(config: ReturnType<typeof loadConfig>) {
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
      model: config.llm.providers['anthropic']?.model ?? config.llm.defaultModel,
      apiKey: anthropicKey,
      timeoutMs: llmTimeoutMs,
    };
  }

  const openaiKey = config.llm.providers['openai']?.apiKey ?? process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    providerConfigs['openai'] = {
      provider: 'openai',
      model: config.llm.providers['openai']?.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5.4',
      apiKey: openaiKey,
      timeoutMs: llmTimeoutMs,
    };
  }

  const siliconflowKey =
    config.llm.providers['siliconflow']?.apiKey ?? process.env['SILICONFLOW_API_KEY'];
  if (siliconflowKey) {
    providerConfigs['siliconflow'] = {
      provider: 'siliconflow',
      model: config.llm.providers['siliconflow']?.model ?? process.env['SILICONFLOW_MODEL'] ?? 'Qwen/Qwen3.5-35B-A3B',
      apiKey: siliconflowKey,
      baseUrl:
        config.llm.providers['siliconflow']?.baseUrl ??
        process.env['SILICONFLOW_BASE_URL'] ??
        'https://api.siliconflow.cn/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'siliconflow') {
      defaultProvider = 'siliconflow';
    }
  }

  const siliconflowIntlKey =
    config.llm.providers['siliconflow-intl']?.apiKey ?? process.env['SILICONFLOW_INTL_API_KEY'];
  if (siliconflowIntlKey) {
    providerConfigs['siliconflow-intl'] = {
      provider: 'siliconflow',
      model: config.llm.providers['siliconflow-intl']?.model ?? process.env['SILICONFLOW_INTL_MODEL'] ?? 'Qwen/Qwen3.5-35B-A3B',
      apiKey: siliconflowIntlKey,
      baseUrl:
        config.llm.providers['siliconflow-intl']?.baseUrl ??
        process.env['SILICONFLOW_INTL_BASE_URL'] ??
        'https://api-st.siliconflow.cn/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'siliconflow-intl') {
      defaultProvider = 'siliconflow-intl';
    }
  }

  const minimaxKey =
    config.llm.providers['minimax']?.apiKey ?? process.env['MINIMAX_API_KEY'];
  if (minimaxKey) {
    providerConfigs['minimax'] = {
      provider: 'openai',
      model: config.llm.providers['minimax']?.model ?? process.env['MINIMAX_MODEL'] ?? 'MiniMax-M3',
      apiKey: minimaxKey,
      baseUrl:
        config.llm.providers['minimax']?.baseUrl ??
        process.env['MINIMAX_BASE_URL'] ??
        'https://api.minimax.io/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'minimax') {
      defaultProvider = 'minimax';
    }
  }

  const minimaxCnKey =
    config.llm.providers['minimax-cn']?.apiKey ?? process.env['MINIMAX_CN_API_KEY'];
  if (minimaxCnKey) {
    providerConfigs['minimax-cn'] = {
      provider: 'openai',
      model: config.llm.providers['minimax-cn']?.model ?? process.env['MINIMAX_CN_MODEL'] ?? 'MiniMax-M3',
      apiKey: minimaxCnKey,
      baseUrl:
        config.llm.providers['minimax-cn']?.baseUrl ??
        process.env['MINIMAX_CN_BASE_URL'] ??
        'https://api.minimaxi.com/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'minimax-cn') {
      defaultProvider = 'minimax-cn';
    }
  }

  const openrouterKey =
    config.llm.providers['openrouter']?.apiKey ?? process.env['OPENROUTER_API_KEY'];
  if (openrouterKey) {
    providerConfigs['openrouter'] = {
      provider: 'openrouter',
      model: config.llm.providers['openrouter']?.model ?? process.env['OPENROUTER_MODEL'] ?? 'xiaomi/mimo-v2-pro',
      apiKey: openrouterKey,
      baseUrl:
        config.llm.providers['openrouter']?.baseUrl ??
        process.env['OPENROUTER_BASE_URL'] ??
        'https://openrouter.ai/api/v1',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'openrouter') {
      defaultProvider = 'openrouter';
    }
  }

  const zaiKey =
    config.llm.providers['zai']?.apiKey ?? process.env['ZAI_API_KEY'];
  if (zaiKey) {
    providerConfigs['zai'] = {
      provider: 'zai',
      model: config.llm.providers['zai']?.model ?? process.env['ZAI_MODEL'] ?? 'glm-5.1',
      apiKey: zaiKey,
      baseUrl:
        config.llm.providers['zai']?.baseUrl ??
        process.env['ZAI_BASE_URL'] ??
        'https://api.z.ai/api/paas/v4',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'zai') {
      defaultProvider = 'zai';
    }
  }

  const deepseekKey =
    config.llm.providers['deepseek']?.apiKey ?? process.env['DEEPSEEK_API_KEY'];
  if (deepseekKey) {
    providerConfigs['deepseek'] = {
      provider: 'deepseek',
      model: config.llm.providers['deepseek']?.model ?? process.env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash',
      apiKey: deepseekKey,
      baseUrl:
        config.llm.providers['deepseek']?.baseUrl ??
        process.env['DEEPSEEK_BASE_URL'] ??
        'https://api.deepseek.com',
      timeoutMs: llmTimeoutMs,
    };
    if (config.llm.defaultProvider === 'deepseek') {
      defaultProvider = 'deepseek';
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

  // Apply auto-fallback setting
  if (config.llm.autoFallback === false) {
    llmRouter.setAutoFallback(false);
  }

  // Apply capability routing config
  if (config.llm.capabilityRouting) {
    llmRouter.setCapabilityRouting(config.llm.capabilityRouting);
  }
  if (config.llm.routingDefaultModel) {
    llmRouter.setRoutingDefaultModel(config.llm.routingDefaultModel);
  }

  // Load custom models from config
  if (config.llm.customModels) {
    for (const [providerName, models] of Object.entries(config.llm.customModels)) {
      for (const model of models) {
        llmRouter.addCustomModel(providerName, model as any);
      }
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
    if (storage.executionStreamRepo) {
      taskService.setExecutionStreamRepo(storage.executionStreamRepo);
    }
    if (storage.taskCommentRepo) {
      taskService.setTaskCommentRepo(storage.taskCommentRepo);
    }
    if (storage.requirementCommentRepo) {
      taskService.setRequirementCommentRepo(storage.requirementCommentRepo);
    }
    if (storage.statusTransitionRepo) {
      taskService.setStatusTransitionRepo(storage.statusTransitionRepo);
    }
    taskService.setUserNameLookup((userId: string) => {
      try {
        const user = storage!.userRepo.findById(userId);
        return user?.name ?? user?.email ?? null;
      } catch { return null; }
    });
    await taskService.loadFromDB('default');
    taskService.startTimeoutChecker();
  }

  // Inject Feishu MCP server whenever credentials are available
  const mcpServers = { ...config.mcpServers };
  const feishuIntegration = config.integrations?.feishu;
  const feishuAppId = feishuIntegration?.appId ?? process.env['FEISHU_APP_ID'];
  const feishuAppSecret = feishuIntegration?.appSecret ?? process.env['FEISHU_APP_SECRET'];
  if (feishuAppId && feishuAppSecret) {
    const presets = feishuIntegration?.mcp?.presets ?? ['preset.default'];
    let larkMcpBin: string;
    try {
      const esmRequire = createRequire(import.meta.url);
      const pkgPath = esmRequire.resolve('@larksuiteoapi/lark-mcp/package.json');
      larkMcpBin = join(dirname(pkgPath), 'dist', 'cli.js');
    } catch {
      larkMcpBin = '';
    }
    const baseArgs = [
      'mcp',
      '-a', feishuAppId,
      '-s', feishuAppSecret,
      '-t', presets.join(','),
      '--token-mode', 'tenant_access_token',
    ];
    if (larkMcpBin && existsSync(larkMcpBin)) {
      mcpServers['feishu-lark'] = {
        command: 'node',
        args: [larkMcpBin, ...baseArgs],
      };
    } else {
      mcpServers['feishu-lark'] = {
        command: 'npx',
        args: ['-y', '@larksuiteoapi/lark-mcp', ...baseArgs],
      };
    }
    log.info('Feishu MCP server configured', { presets, localBin: !!larkMcpBin });
  }

  const agentManager = new AgentManager({
    llmRouter,
    roleLoader,
    dataDir: join(markusDataDir, 'agents'),
    sharedDataDir,
    skillRegistry,
    taskService,
    mcpServers,
  });

  if (config.agent?.maxToolIterations) {
    agentManager.maxToolIterations = config.agent.maxToolIterations;
  }
  if (config.agent?.cognitive) {
    const cc = config.agent.cognitive;
    agentManager.cognitiveConfig = {
      enabled: cc.enabled ?? false,
      maxDepth: cc.maxDepth,
      appraisalModel: cc.appraisalModel,
      timeoutMs: cc.timeoutMs,
    };
  }
  if (config.codingTools) {
    agentManager.setCodingToolsConfig(config.codingTools);
  }
  if (config.browser?.bringToFront !== undefined) {
    agentManager.setBrowserBringToFront(config.browser.bringToFront);
  }
  if (config.browser?.autoCloseTabs !== undefined) {
    agentManager.setBrowserAutoCloseTabs(config.browser.autoCloseTabs);
  }
  if (config.browser?.remoteDebuggingPort) {
    agentManager.setBrowserRemoteDebuggingPort(config.browser.remoteDebuggingPort);
  }
  if (config.browser?.autoClickAllowDialog) {
    agentManager.setBrowserAutoClickAllowDialog(true);
  }
  agentManager.startBrowserBridge(config.browser?.extensionBridgePort);

  taskService.setAgentManager(agentManager);

  const orgService = new OrganizationService(agentManager, roleLoader, storage ?? undefined);
  taskService.setOrgService(orgService);

  const bootstrapOwnerId = userId();
  await orgService.createOrganization(config.org.name, bootstrapOwnerId, 'default');

  orgService.addHumanUser('default', 'Owner', 'owner', { id: bootstrapOwnerId });

  const hitlService = new HITLService();
  hitlService.setOrgService(orgService);
  taskService.setHITLService(hitlService);
  const licenseService = new LicenseService(config.hub?.url);
  const telemetryService = new TelemetryService(config.hub?.url ?? 'https://markus.global', licenseService.getInstanceId());
  const billingService = new BillingService();
  billingService.setOrgPlan('default', licenseService.getPlan());
  const auditService = new AuditService();
  taskService.setAuditService(auditService);
  if (storage?.auditRepo) {
    auditService.setRepository(storage.auditRepo);
  }

  return {
    agentManager,
    orgService,
    taskService,
    roleLoader,
    llmRouter,
    skillRegistry,
    hitlService,
    billingService,
    licenseService,
    telemetryService,
    auditService,
    bootstrapOwnerId,
  };
}

/**
 * Headless server startup — no progress UI, no blocking, no browser open.
 * Used by Electron desktop app and programmatic embedding.
 */
export async function startServerHeadless(
  config: ReturnType<typeof loadConfig>,
  values: { port?: unknown; config?: unknown; onProgress?: (step: string, message: string) => void },
): Promise<BackendInstance> {
  const instance = await startServerCore(config, values, { headless: true });
  return instance!;
}

interface StartServerCoreOptions {
  headless?: boolean;
}

async function startServer(config: ReturnType<typeof loadConfig>, values: Record<string, unknown>) {
  await startServerCore(config, values, { headless: false });
}

async function startServerCore(
  config: ReturnType<typeof loadConfig>,
  values: { port?: unknown; config?: unknown; onProgress?: (step: string, message: string) => void },
  opts: StartServerCoreOptions,
): Promise<BackendInstance | undefined> {
  const headless = opts.headless ?? false;
  const onProgress = values.onProgress;

  // Initialize startup logger first — all startup output goes to file AND console
  const logPath = initStartupLogger();

  // Boot the animated progress display (CLI only)
  const progress = headless ? null : new StartupProgress(logPath);
  progress?.start();

  // ── Step 0: Boot ──────────────────────────────────────────────────────────
  progress?.setActive(0);
  progress?.complete(0, 'markus CLI initialised');
  onProgress?.('boot', 'markus initialised');

  startupSection('Markus 启动');
  startupLog('INFO', `日志文件: ${logPath}`);

  // ── Step 1: Config ─────────────────────────────────────────────────────────
  progress?.setActive(1);
  progress?.complete(1, `config loaded from ~/.markus/markus.json`);
  onProgress?.('config', 'config loaded');

  // LLM preflight check: warn if no VALID LLM API key is configured
  // "***" or other placeholder patterns are NOT valid keys
  const PLACEHOLDER_PATTERNS = ['***', 'your-', 'dummy', 'fake', 'test-key', 'replace-me'];
  const isPlaceholder = (key: string): boolean =>
    PLACEHOLDER_PATTERNS.some(p => key.toLowerCase().includes(p)) || key.length < 8;

  const configuredLLMProviders: string[] = [];
  const llmProviders = config.llm?.providers ?? {};
  for (const [name, cfg] of Object.entries(llmProviders)) {
    const key = (cfg as any)?.apiKey ?? process.env[`${name.toUpperCase()}_API_KEY`];
    if (key && !isPlaceholder(key)) configuredLLMProviders.push(name);
  }

  // ── Step 2: LLM Providers ──────────────────────────────────────────────────
  progress?.setActive(2);
  if (configuredLLMProviders.length > 0) {
    progress?.complete(2, `providers ready: ${configuredLLMProviders.join(', ')}`);
    for (const name of configuredLLMProviders) {
      startupLog('OK', `LLM Provider: ${name}`, (llmProviders[name] as any)?.model ?? 'default');
    }
  } else {
    progress?.fail(2, 'no valid LLM API key detected');
    startupLog('FAIL', '未检测到有效的 LLM API key', '*** 占位符不会被识别为有效 key');
    startupLog('INFO', '请选择配置方式:', '');
    startupLog('INFO', '  1. 在浏览器中配置  → http://localhost:8056');
    startupLog('INFO', '  2. 交互式配置    → 正在启动向导...');
    startupBlank();
    // Always use non-interactive mode during server startup — interactive
    // prompts can hang when stdin is shared (concurrently, CI, systemd, etc.).
    // Users who need interactive setup should run `markus init` first.
    const { quickInit } = await import('./init.js');
    startupLog('INFO', '自动从环境变量/已知配置导入 LLM 设置...');
    await quickInit({ nonInteractive: true });
    // Reload config after init
    const { loadConfig: reloadConfig } = await import('@markus/shared');
    const updatedConfig = reloadConfig(values['config'] as string | undefined);
    // Re-check after init
    for (const [name, cfg] of Object.entries(updatedConfig.llm?.providers ?? {})) {
      const key = (cfg as any)?.apiKey ?? process.env[`${name.toUpperCase()}_API_KEY`];
      if (key && !isPlaceholder(key)) configuredLLMProviders.push(name);
    }
    if (configuredLLMProviders.length > 0) {
      progress?.complete(2, `providers ready: ${configuredLLMProviders.join(', ')}`);
      startupLog('OK', 'LLM 配置成功', `已配置: ${configuredLLMProviders.join(', ')}`);
      startupBlank();
    } else {
      progress?.skip(2, 'LLM not configured — server will start with disabled provider');
      startupLog('WARN', '仍未配置有效的 LLM key', '服务将使用 disabled provider 启动');
      startupLog('INFO', '稍后可运行 markus init 或 markus model 重新配置');
      startupBlank();
    }
  }

  // ── Step 3: Database ───────────────────────────────────────────────────────
  progress?.setActive(3);
  onProgress?.('llm', 'LLM providers configured');
  startupLog('INFO', '正在启动服务...');

  // Ensure `markus` is available in PATH for agents invoking it via shell_execute.
  // In npm-global mode: process.argv[1] is the installed binary (e.g. /usr/local/bin/markus)
  // In source-dev mode: node_modules/.bin contains the symlink
  const currentPath = process.env['PATH'] ?? '';
  const extraPaths: string[] = [];
  const selfBinDir = dirname(resolve(process.argv[1] ?? ''));
  if (selfBinDir && !currentPath.includes(selfBinDir)) extraPaths.push(selfBinDir);
  const cwdBin = join(process.cwd(), 'node_modules', '.bin');
  if (existsSync(cwdBin) && !currentPath.includes(cwdBin)) extraPaths.push(cwdBin);
  if (extraPaths.length > 0) {
    process.env['PATH'] = `${extraPaths.join(delimiter)}${delimiter}${currentPath}`;
  }

  // Propagate markus.json security settings into env so downstream services can read them
  if (config.security?.adminPassword && !process.env['ADMIN_PASSWORD']) {
    process.env['ADMIN_PASSWORD'] = config.security.adminPassword;
  }

  // Propagate markus.json search API keys into env so web_search tool can read them
  if (config.integrations?.search?.serperApiKey && !process.env['SERPER_API_KEY']) {
    process.env['SERPER_API_KEY'] = config.integrations.search.serperApiKey;
  }
  if (config.integrations?.search?.tavilyApiKey && !process.env['TAVILY_API_KEY']) {
    process.env['TAVILY_API_KEY'] = config.integrations.search.tavilyApiKey;
  }
  if (config.integrations?.search?.bingApiKey && !process.env['BING_SEARCH_API_KEY']) {
    process.env['BING_SEARCH_API_KEY'] = config.integrations.search.bingApiKey;
  }
  if (config.integrations?.search?.googleSearchApiKey && !process.env['GOOGLE_SEARCH_API_KEY']) {
    process.env['GOOGLE_SEARCH_API_KEY'] = config.integrations.search.googleSearchApiKey;
  }
  if (config.integrations?.search?.googleSearchCx && !process.env['GOOGLE_SEARCH_CX']) {
    process.env['GOOGLE_SEARCH_CX'] = config.integrations.search.googleSearchCx;
  }
  if (config.integrations?.search?.serpApiKey && !process.env['SERPAPI_API_KEY']) {
    process.env['SERPAPI_API_KEY'] = config.integrations.search.serpApiKey;
  }
  if (config.integrations?.search?.braveApiKey && !process.env['BRAVE_SEARCH_API_KEY']) {
    process.env['BRAVE_SEARCH_API_KEY'] = config.integrations.search.braveApiKey;
  }
  if (config.integrations?.search?.exaApiKey && !process.env['EXA_API_KEY']) {
    process.env['EXA_API_KEY'] = config.integrations.search.exaApiKey;
  }
  if (config.integrations?.search?.bochaApiKey && !process.env['BOCHA_API_KEY']) {
    process.env['BOCHA_API_KEY'] = config.integrations.search.bochaApiKey;
  }

  const apiPort = Number(values['port']) || config.server.apiPort;

  const {
    orgService,
    taskService,
    agentManager,
    llmRouter,
    skillRegistry,
    hitlService,
    billingService,
    licenseService,
    telemetryService,
    auditService,
    bootstrapOwnerId,
  } = await createServices(config);
  progress?.complete(3, 'SQLite storage initialised');
  progress?.complete(4, `services ready: agent manager, task service, api server on :${apiPort}`);
  onProgress?.('services', `services ready on :${apiPort}`);

  const apiServer = new APIServer(orgService, taskService, apiPort);
  apiServer.setSkillRegistry(skillRegistry);
  apiServer.setHITLService(hitlService);
  apiServer.setBillingService(billingService);
  apiServer.setLicenseService(licenseService);
  apiServer.setTelemetryService(telemetryService);
  apiServer.setAuditService(auditService);

  const projectService = new ProjectService();
  const storage = orgService.getStorage();
  if (storage?.notificationRepo) {
    hitlService.setNotificationRepo(storage.notificationRepo);
  }
  if (storage?.approvalRepo) {
    hitlService.setApprovalRepo(storage.approvalRepo);
  }
  if (storage?.projectRepo) {
    projectService.setProjectRepo(storage.projectRepo);
  }
  await projectService.loadFromDB('default');
  const knowledgeStore = new FileKnowledgeStore(join(homedir(), '.markus', 'knowledge'));
  const knowledgeService = new KnowledgeService(knowledgeStore);
  const deliverableService = new DeliverableService(storage?.deliverableRepo);
  await deliverableService.load();

  // One-time migrations
  await taskService.migrateBranchToCompletionSummary();
  await deliverableService.cleanupLegacyRows();

  const reportService = new ReportService(taskService, billingService, auditService, knowledgeService);
  const _trustService = new TrustService();
  const requirementService = new RequirementService();
  if (storage?.requirementRepo) {
    requirementService.setRequirementRepo(storage.requirementRepo);
  }
  if (storage?.statusTransitionRepo) {
    requirementService.setStatusTransitionRepo(storage.statusTransitionRepo);
  }
  if (storage) {
    requirementService.setUserNameLookup((userId: string) => {
      try {
        const user = storage!.userRepo.findById(userId);
        return user?.name ?? user?.email ?? null;
      } catch { return null; }
    });
  }
  await requirementService.loadFromStorage('default');
  requirementService.rebuildTaskLinks(taskService.listTasks());

  agentManager.setRequirementService(requirementService);
  agentManager.setProjectService(projectService);
  agentManager.setDeliverableService(deliverableService);
  agentManager.setWebUiBaseUrl(`http://localhost:${apiPort}`);

  requirementService.setAgentManager(agentManager);
  requirementService.setHITLService(hitlService);
  apiServer.setProjectService(projectService);
  apiServer.setReportService(reportService);
  apiServer.setKnowledgeService(knowledgeService);
  apiServer.setDeliverableService(deliverableService);
  apiServer.setRequirementService(requirementService);
  taskService.setDeliverableService(deliverableService);
  orgService.setDeliverableService(deliverableService);

  // Wire WorkflowService + WorkflowRunner (must be constructed before tools factory)
  const workflowService = new WorkflowService(orgService);
  const workflowRunner = new WorkflowRunner(requirementService, taskService, orgService);
  if (storage?.workflowRunRepo) {
    workflowRunner.setRunRepo(storage.workflowRunRepo);
  }
  workflowRunner.setWSBroadcaster(apiServer.getWSBroadcaster());
  apiServer.setWorkflowService(workflowService);
  apiServer.setWorkflowRunner(workflowRunner);

  await workflowRunner.loadFromDB();

  // Hook workflow run status tracking into task status changes
  taskService.onTaskEvent(async (event) => {
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'status_changed') {
      const task = taskService.getTask(event.taskId);
      if (task) await workflowRunner.onTaskStatusChange(task);
    }
  });

  // Wire workflow tools factory for manager agents
  agentManager.setWorkflowToolsFactory((teamId: string) => {
    return {
      teamId,
      listWorkflows: () => workflowService.listWorkflows(teamId),
      getWorkflow: (name: string) => workflowService.getWorkflow(teamId, name),
      runWorkflow: async (name: string, params: Record<string, string>, projectId: string, roleMapping?: Record<string, string>) => {
        const template = workflowService.getWorkflow(teamId, name);
        if (!template) throw new Error(`Workflow "${name}" not found`);
        const mapping = roleMapping ?? workflowService.buildDefaultRoleMapping(teamId, template);
        const run = await workflowRunner.createRun(teamId, template, params, mapping, projectId, 'agent');
        return { runId: run.id, runNumber: run.runNumber, requirementId: run.requirementId, taskIds: run.taskIds };
      },
      listRuns: async (name: string, limit?: number) => {
        const runs = await workflowRunner.listRuns(teamId, name, limit);
        return runs.map(r => ({ id: r.id, runNumber: r.runNumber, status: r.status, taskIds: r.taskIds, triggeredBy: r.triggeredBy, startedAt: r.startedAt, completedAt: r.completedAt }));
      },
      getActiveRuns: () => {
        const runs = workflowRunner.getActiveRuns(teamId);
        return runs.map(r => ({ id: r.id, workflowName: r.workflowName, runNumber: r.runNumber, status: r.status, taskIds: r.taskIds, startedAt: r.startedAt }));
      },
      cancelRun: async (runId: string) => { await workflowRunner.cancelRun(runId); },
      addWorkflow: (name: string, yaml: string) => { workflowService.addWorkflow(teamId, name, yaml); },
      updateWorkflow: (name: string, yaml: string) => { workflowService.updateWorkflow(teamId, name, yaml); },
      removeWorkflow: (name: string) => { workflowService.removeWorkflow(teamId, name); },
    };
  });

  // Wire ProjectService into TaskService (workspace management is handled by agents)
  taskService.setProjectService(projectService);
  taskService.setRequirementService(requirementService);

  // Auto-archive: archive terminal tasks and requirements after configured thresholds
  const archiveService = new ArchiveService(taskService, projectService);
  archiveService.setRequirementService(requirementService);
  archiveService.start();

  // Stale task detection: alert humans when tasks are stuck in review/in_progress/pending
  const staleDetector = new StaleDetector(taskService, undefined, (items) => {
    for (const item of items) {
      hitlService.notify({
        targetUserId: 'all',
        type: 'system',
        title: item.type === 'review_stale' ? 'Stale review' : item.type === 'stuck_task' ? 'Stuck task' : 'Unstarted task',
        body: item.message,
        priority: item.type === 'review_stale' ? 'high' : 'normal',
        actionType: item.taskId ? 'navigate' : 'none',
        actionTarget: item.taskId ? JSON.stringify({ path: `/work?openTask=${item.taskId}` }) : undefined,
        metadata: { taskId: item.taskId, agentId: item.agentId, staleType: item.type },
      });
    }
  });
  staleDetector.start();

  // Expose LLM router to API server so settings can read/write it at runtime
  apiServer.setLLMRouter(llmRouter);
  apiServer.setConfigPath(values['config'] as string ?? getDefaultConfigPath());

  // Initialize model catalog service (loads baseline, tries to fetch latest in background)
  const modelCatalog = new ModelCatalogService({ mirrorUrl: config.llm?.catalogMirrorUrl });
  await modelCatalog.initialize();
  apiServer.setModelCatalog(modelCatalog);
  llmRouter.setModelCatalogService(modelCatalog);

  if (config.hub?.url) apiServer.setHubUrl(config.hub.url);

  // Telemetry: connect stats provider and start background reporting
  telemetryService.setStatsProvider(() => {
    const am = orgService.getAgentManager();
    return {
      agentCount: am ? am.listAgents().length : 0,
      taskCount: taskService.listTasks().length,
      toolCallCount: billingService.getUsageSummary('default').toolCalls,
      teamCount: orgService.listTeams('default').length,
      plan: licenseService.getPlan(),
    };
  });
  telemetryService.start();

  // Serve pre-built Web UI if available
  const webUiDir = resolveWebUiDir();
  if (webUiDir) {
    apiServer.setWebUiDir(webUiDir);
    log.info('Web UI static files enabled', { dir: webUiDir });
  }

  // File storage for uploads (images, attachments)
  {
    const { LocalFileStorageProvider } = await import('@markus/org-manager');
    const localDir = config.fileStorage?.local?.dir;
    const fileStorage = new LocalFileStorageProvider(localDir ?? undefined);
    apiServer.setFileStorage(fileStorage);
    log.info('File storage initialized', { provider: 'local', dir: localDir ?? '~/.markus/uploads' });
  }

  // Wire storage for chat persistence and auth
  const firstOrgId = 'default';
  let ownerUserId = bootstrapOwnerId;
  if (storage) {
    apiServer.setStorage(storage);
    ownerUserId = await apiServer.ensureAdminUser(firstOrgId);

    // Restore persisted teams, agents, and users from DB
    await orgService.loadFromDB(firstOrgId);

    // Sync in-memory owner representation with DB owner
    if (ownerUserId !== bootstrapOwnerId) {
      orgService.removeHumanUser(bootstrapOwnerId);
    }
    const existingOwner = orgService.listHumanUsers(firstOrgId).find(u => u.id === ownerUserId);
    if (!existingOwner) {
      orgService.addHumanUser(firstOrgId, 'Owner', 'owner', { id: ownerUserId });
    }
  }

  // Seed default team + Secretary agent (runs for both DB and in-memory mode)
  await orgService.seedDefaultTeam(firstOrgId, ownerUserId);

  // Register builder context providers on agents with building skills (e.g. Secretary)
  orgService.registerBuilderContextProviders(skillRegistry);

  // Wire BuilderService and HubClient into AgentManager for hire/install/hub tools
  const builderService = apiServer.getBuilderService();
  if (builderService) {
    const builtinTeamsDir = resolveTemplatesDir('teams');
    if (builtinTeamsDir && existsSync(builtinTeamsDir)) {
      builderService.setBuiltinTeamTemplatesDir(builtinTeamsDir);
    }
    agentManager.setBuilderService(builderService);
  }
  const hubClient = apiServer.getHubClient();
  if (hubClient) {
    agentManager.setHubClient(hubClient);
  }

  // Wire team/agent update callbacks for manager tools
  agentManager.setTeamUpdater(async (teamId, data) => {
    const team = await orgService.updateTeam(teamId, data);
    return { id: teamId, name: team.name, description: team.description };
  });
  if (storage) {
    agentManager.setAgentConfigPersister(async (agentId, data) => {
      await storage.agentRepo.updateConfig(agentId, data);
    });
  }

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

  // Wire user approval requester through HITL service
  agentManager.setUserApprovalRequester(async (opts) => {
    const taskTitle = opts.relatedTaskId ? taskService.getTask(opts.relatedTaskId)?.title : undefined;
    return hitlService.requestApprovalAndWait({
      agentId: opts.agentId,
      agentName: opts.agentName,
      type: 'custom',
      title: opts.title,
      description: opts.description,
      targetUserId: ownerUserId,
      options: opts.options,
      allowFreeform: opts.allowFreeform,
      details: { priority: opts.priority, taskId: opts.relatedTaskId, taskTitle },
    });
  });

  // Wire user notifier through HITL service
  agentManager.setUserNotifier((opts) => {
    hitlService.notify({
      targetUserId: 'all',
      type: opts.type as any,
      title: opts.title,
      body: opts.body,
      priority: opts.priority as any,
      actionType: opts.actionType as any,
      actionTarget: opts.actionTarget,
      metadata: opts.metadata,
    });
  });

  // Ensure every agent has a main session on startup, then persist activity logs to it
  if (storage?.chatSessionRepo) {
    // Migrate legacy assistant messages that lack segments metadata
    try {
      storage.chatSessionRepo.migrateLegacyMessages();
    } catch (e) {
      log.warn('Legacy chat message migration failed', { error: String(e) });
    }

    // Resolve the owner/first user for session ownership
    const defaultSessionUserId: string = ownerUserId;

    // Migrate legacy sessions with NULL user_id to the owner
    try {
      storage.chatSessionRepo.migrateNullUserSessions(defaultSessionUserId);
    } catch (e) {
      log.warn('NULL user_id session migration failed', { error: String(e) });
    }

    // Migrate legacy user_id='default' to real owner ID across tables
    try {
      storage.chatSessionRepo.migrateDefaultUserSessions(defaultSessionUserId);
    } catch (e) {
      log.warn("'default' user_id session migration failed", { error: String(e) });
    }
    try {
      storage.notificationRepo.migrateDefaultUserId(defaultSessionUserId);
    } catch (e) {
      log.warn("'default' user_id notification migration failed", { error: String(e) });
    }
    if (storage.approvalRepo) {
      try {
        storage.approvalRepo.migrateDefaultTargetUserId(defaultSessionUserId);
      } catch (e) {
        log.warn("'default' target_user_id approval migration failed", { error: String(e) });
      }
    }

    for (const info of agentManager.listAgents()) {
      try {
        storage.chatSessionRepo.getOrCreateMainSession(info.id, defaultSessionUserId);
      } catch { /* skip */ }
    }
    const ws = apiServer.getWSBroadcaster();
    agentManager.getEventBus().on('agent:activity-log', async (evt: unknown) => {
      const { agentId, message, metadata } = evt as {
        agentId: string; message: string;
        metadata: Record<string, unknown>;
      };
      try {
        const mainSession = storage.chatSessionRepo.getOrCreateMainSession(agentId, defaultSessionUserId);
        const msg = storage.chatSessionRepo.appendMessage(
          mainSession.id, agentId, 'assistant', message, 0, metadata,
        );
        storage.chatSessionRepo.updateLastMessage(mainSession.id);
        const agent = agentManager.getAgent(agentId);
        ws.broadcastProactiveMessage(agentId, agent.config.name, mainSession.id, msg.id, message, {
          ...metadata,
          isMainSession: true,
        }, defaultSessionUserId);
      } catch (e) {
        log.warn('Failed to persist activity log', { agentId, error: String(e) });
      }
    });
    // notify_user: persist as regular chat message + WS broadcast + notification bell
    agentManager.getEventBus().on('agent:notify-user', async (evt: unknown) => {
      const { agentId, title, body, priority, taskId, requirementId, targetUserId } = evt as {
        agentId: string; title: string; body: string; priority?: NotificationPriority;
        taskId?: string; requirementId?: string; targetUserId?: string;
      };
      try {
        const sessionUserId = targetUserId || defaultSessionUserId;
        const mainSession = storage.chatSessionRepo.getOrCreateMainSession(agentId, sessionUserId);
        const agent = agentManager.getAgent(agentId);
        const contextParts: string[] = [];
        if (taskId) contextParts.push(`task_id=${taskId}`);
        if (requirementId) contextParts.push(`requirement_id=${requirementId}`);
        if (priority && priority !== 'normal') contextParts.push(`priority=${priority}`);
        const contextSuffix = contextParts.length > 0
          ? `\n\n<!-- notify_context: ${contextParts.join(', ')} -->`
          : '';
        const formattedMsg = `**${title}**\n\n${body}${contextSuffix}`;
        const msgMetadata: Record<string, unknown> = {
          notifyUser: true,
          priority: priority ?? 'normal',
          ...(taskId ? { taskId } : {}),
          ...(requirementId ? { requirementId } : {}),
        };
        const msg = storage.chatSessionRepo.appendMessage(
          mainSession.id, agentId, 'assistant', formattedMsg, 0, msgMetadata,
        );
        storage.chatSessionRepo.updateLastMessage(mainSession.id);
        ws.broadcastProactiveMessage(agentId, agent.config.name, mainSession.id, msg.id, formattedMsg, {
          isMainSession: true,
          notifyUser: true,
          priority: priority ?? 'normal',
          taskId,
          requirementId,
        }, sessionUserId);
        const hasTask = !!taskId;
        hitlService.notify({
          targetUserId: targetUserId ?? 'all',
          type: 'agent_report',
          title, body, priority,
          actionType: hasTask ? 'navigate' : 'open_chat',
          actionTarget: hasTask
            ? JSON.stringify({ path: `/work?openTask=${taskId}` })
            : JSON.stringify({ agentId, sessionId: mainSession.id }),
          metadata: { agentId, agentName: agent.config.name, taskId, requirementId, sessionId: mainSession.id },
        });
      } catch (e) {
        log.warn('Failed to handle notify-user event', { agentId, error: String(e) });
      }
    });

    // escalation: persist as regular chat message + WS broadcast + notification + audit
    agentManager.getEventBus().on('agent:escalation', async (evt: unknown) => {
      const { agentId, reason } = evt as { agentId: string; reason: string };
      try {
        const mainSession = storage.chatSessionRepo.getOrCreateMainSession(agentId, defaultSessionUserId);
        const agent = agentManager.getAgent(agentId);
        const formattedMsg = `**I need help**\n\n${reason}`;
        const msg = storage.chatSessionRepo.appendMessage(
          mainSession.id, agentId, 'assistant', formattedMsg, 0, {},
        );
        storage.chatSessionRepo.updateLastMessage(mainSession.id);
        ws.broadcastProactiveMessage(agentId, agent.config.name, mainSession.id, msg.id, formattedMsg, {
          isMainSession: true,
        }, defaultSessionUserId);
        hitlService.notify({
          targetUserId: 'all',
          type: 'system',
          title: 'Agent needs help',
          body: reason,
          priority: 'high',
          actionType: 'open_chat',
          actionTarget: JSON.stringify({ agentId, sessionId: mainSession.id }),
          metadata: { agentId, sessionId: mainSession.id },
        });
        auditService.record({
          orgId: 'default', agentId, type: 'error', action: 'escalation', detail: reason, success: false,
        });
      } catch (e) {
        log.warn('Failed to handle escalation event', { agentId, error: String(e) });
      }
    });

    // Also create main session for newly created agents
    agentManager.getEventBus().on('agent:created', (evt: unknown) => {
      const { agentId } = evt as { agentId: string };
      try { storage.chatSessionRepo.getOrCreateMainSession(agentId, defaultSessionUserId); } catch { /* skip */ }
    });
  }

  // Task resume is triggered after agents finish starting (see below).

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
    const reply = await agent.sendMessage(message);
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

  // ── Remote Access (WebRTC P2P via markus-hub + signal server) ─────────
  {
    const hubTokenPath = join(homedir(), '.markus', 'hub-token');

    const createRemoteAgent = async () => {
      const token = existsSync(hubTokenPath) ? readFileSync(hubTokenPath, 'utf-8').trim() : undefined;
      if (!token) return null;
      const { RemoteAccessAgent } = await import('@markus/remote');
      return new RemoteAccessAgent({
        hubUrl: config.remote?.hubUrl ?? config.hub?.url ?? 'https://www.markus.global',
        hubToken: token,
        instanceName: config.remote?.instanceName ?? config.org?.name ?? 'My Markus',
        localPort: config.server?.apiPort ?? 8056,
        jwtSecret: process.env['JWT_SECRET'],
      });
    };

    apiServer.setRemoteAgentFactory(createRemoteAgent);

    if (config.remote?.enabled === true) {
      const remoteAgent = await createRemoteAgent();
      if (remoteAgent) {
        apiServer.setRemoteAgent(remoteAgent);
        if (config.remote?.autoConnect !== false) {
          remoteAgent.start().then(() => {
            const status = remoteAgent.getStatus();
            if (status.remoteUrl) {
              log.info(`Remote access available at ${status.remoteUrl}`);
            }
          }).catch((err: unknown) => {
            log.warn('Remote access failed to start', { error: String(err) });
          });
        }
      } else {
        log.debug('Remote access: no Hub token yet (can enable later via Settings)');
      }
    }
  }

  apiServer.start();
  taskService.setWSBroadcaster(apiServer.getWSBroadcaster());
  requirementService.setWSBroadcaster(apiServer.getWSBroadcaster());
  deliverableService.setWSBroadcaster(apiServer.getWSBroadcaster());

  const scheduledTaskRunner = new ScheduledTaskRunner(taskService);
  scheduledTaskRunner.start();

  const workflowScheduler = new WorkflowScheduler(workflowService, workflowRunner, orgService);
  if (storage?.workflowScheduleRepo) {
    workflowScheduler.setScheduleRepo(storage.workflowScheduleRepo);
  }
  await workflowScheduler.start();

  // Escalation callback kept for agent-internal state management; actual notification/DB/WS/audit
  // logic is handled by the 'agent:escalation' event handler registered above.
  agentManager.setEscalationHandler((agentId, reason) => {
    log.warn('Agent escalation', { agentId, reason });
  });

  agentManager.setApprovalHandler(async (agentId, request) => {
    const agents = agentManager.listAgents();
    const agentName = agents.find(a => a.id === agentId)?.name ?? agentId;
    let title = `Tool: ${request.toolName}`;
    if (request.toolName === 'shell_execute') {
      const reasonMatch = request.reason.match(/requires approval:\s*(.+?)\.?\s*Command:/);
      title = reasonMatch ? `Git: ${reasonMatch[1]}` : 'Shell: command approval';
    }
    const taskTitle = request.taskId ? taskService.getTask(request.taskId)?.title : undefined;
    const result = await hitlService.requestApprovalAndWait({
      agentId,
      agentName,
      type: 'action',
      title,
      description: request.reason,
      details: { ...request.toolArgs, toolName: request.toolName, agentId, taskId: request.taskId, taskTitle },
      targetUserId: ownerUserId,
    });
    auditService.record({
      orgId: 'default',
      agentId,
      userId: result.respondedBy,
      type: 'approval_response',
      action: request.toolName,
      detail: result.approved ? 'approved' : `rejected${result.comment ? ': ' + result.comment : ''}`,
      success: result.approved,
    });
    return result;
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

  billingService.setToolCallsTodayProvider(() => {
    let total = 0;
    for (const a of agentManager.listAgents()) {
      try { total += agentManager.getAgent(a.id).getUsageStats().toolCallsToday; } catch { /* not loaded */ }
    }
    return total;
  });
  agentManager.setToolCallLimitChecker(() => billingService.checkLimit('default', 'tool_call'));

  // Wire agent state changes to DB persistence + WS broadcast
  if (storage) {
    agentManager.setStateChangeHandler(async (agentId, state) => {
      try {
        await storage.agentRepo.updateStatus(
          agentId,
          state.status as 'idle' | 'working' | 'offline' | 'error'
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

    agentManager.setDisabledChangeHandler((agentId, disabled) => {
      try {
        storage.agentRepo.setDisabled(agentId, disabled);
      } catch (err) {
        log.warn('Failed to persist agent disabled flag', { agentId, disabled, error: String(err) });
      }
    });
  }

  // Wire activity persistence to SQLite
  if (storage?.activityRepo) {
    const actRepo = storage.activityRepo;
    const execStreamRepo = storage.executionStreamRepo;
    agentManager.setActivityCallbacks({
      onStart: (activity) => {
        try {
          actRepo.insertActivity({
            id: activity.id,
            agentId: activity.agentId,
            type: activity.type,
            label: activity.label,
            taskId: activity.taskId,
            mailboxItemId: activity.mailboxItemId,
            startedAt: activity.startedAt,
          });
        } catch (err) {
          log.warn('Failed to persist activity start', { activityId: activity.id, error: String(err) });
        }
      },
      onLog: (data) => {
        if (execStreamRepo) {
          try {
            execStreamRepo.append({
              sourceType: 'activity',
              sourceId: data.activityId,
              agentId: data.agentId ?? '',
              seq: data.seq,
              type: data.type,
              content: data.content,
              metadata: data.metadata,
            });
          } catch (err) {
            log.warn('Failed to persist execution stream activity log', { activityId: data.activityId, error: String(err) });
          }
        }
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

    // Wire recall_activity tool to query execution history from SQLite
    agentManager.setRecallCallbacks({
      listActivities: (agentId, opts) => {
        const results = actRepo.queryActivities(agentId, {
          type: opts.type,
          limit: opts.limit,
        });
        if (opts.taskId) return results.filter((a: { taskId?: string | null }) => a.taskId === opts.taskId);
        return results;
      },
      getActivityLogs: (activityId) => {
        return actRepo.getActivityLogs(activityId);
      },
      searchActivities: (agentId, query, opts) => {
        return actRepo.searchActivities(agentId, query, opts);
      },
    });
  }

  // Wire mailbox + decision persistence to SQLite
  if (storage?.mailboxRepo && storage?.decisionRepo) {
    const mbRepo = storage.mailboxRepo;
    const decRepo = storage.decisionRepo;
    const wireMailboxPersistence = (agentId: string) => {
      try {
        const agent = agentManager.getAgent(agentId);
        const mailbox = agent.getMailbox();
        mailbox.setPersistence({
          save: (item) => {
            try {
              const { responsePromise, ...persistableMetadata } = (item.metadata ?? {}) as Record<string, unknown>;
              mbRepo.save({
                id: item.id, agentId: item.agentId, sourceType: item.sourceType,
                priority: item.priority, status: item.status,
                payload: item.payload as unknown as Record<string, unknown>,
                metadata: persistableMetadata,
                queuedAt: item.queuedAt,
              });
            } catch (e) { log.warn('Failed to persist mailbox item', { id: item.id, error: String(e) }); }
          },
          updateStatus: (itemId: string, status: string, extra?: Partial<Record<string, unknown>>) => {
            try { mbRepo.updateStatus(itemId, status, extra as Record<string, unknown>); }
            catch (e) { log.warn('Failed to update mailbox status', { itemId, error: String(e) }); }
          },
          markStaleProcessingAsDropped: (aid: string) => mbRepo.markStaleProcessingAsDropped(aid),
          markStaleProcessingAsCompleted: (aid: string) => mbRepo.markStaleProcessingAsCompleted(aid),
          loadQueued: (aid: string) => {
            const rows = mbRepo.getByAgent(aid, { status: 'queued' });
            return rows.map((r: any) => ({
              id: r.id,
              agentId: r.agentId,
              sourceType: r.sourceType,
              priority: r.priority,
              status: r.status as 'queued',
              payload: r.payload,
              metadata: r.metadata,
              queuedAt: r.queuedAt,
              startedAt: r.startedAt ?? undefined,
              completedAt: r.completedAt ?? undefined,
              deferredUntil: r.deferredUntil ?? undefined,
              mergedInto: r.mergedInto ?? undefined,
              retryCount: r.retryCount ?? 0,
            }));
          },
          loadDeferred: (aid: string) => {
            const rows = mbRepo.getByAgent(aid, { status: 'deferred' });
            return rows.map((r: any) => ({
              id: r.id,
              agentId: r.agentId,
              sourceType: r.sourceType,
              priority: r.priority,
              status: r.status as 'deferred',
              payload: r.payload,
              metadata: r.metadata,
              queuedAt: r.queuedAt,
              startedAt: r.startedAt ?? undefined,
              completedAt: r.completedAt ?? undefined,
              deferredUntil: r.deferredUntil ?? undefined,
              mergedInto: r.mergedInto ?? undefined,
              retryCount: r.retryCount ?? 0,
            }));
          },
        });
        const { dropped, restored, expired, merged } = mailbox.recoverStaleItems();
        if (dropped > 0 || restored > 0 || expired > 0 || merged > 0) log.info('Mailbox recovery on startup', { agentId, dropped, restored, expired, merged });
        agent.getAttentionController().setDecisionPersistence({
          save: (decision) => {
            try {
              decRepo.save({
                id: decision.id, agentId: decision.agentId,
                decisionType: decision.decisionType, mailboxItemId: decision.mailboxItemId,
                context: decision.context as unknown as Record<string, unknown>,
                reasoning: decision.reasoning ?? '',
                outcome: decision.outcome,
                createdAt: decision.createdAt,
              });
            } catch (e) { log.warn('Failed to persist decision', { id: decision.id, error: String(e) }); }
          },
        });
        // Wire TriageJudge — used as fallback when full-session deliberation
        // (delegate.performDeliberation) is not triggered or returns null.
        const triageProvider = agent.config.llmConfig?.modelMode === 'custom'
          ? agent.config.llmConfig.primary : undefined;
        const triageSystemPrompt = 'You are a mailbox triage assistant. Output ONLY a single JSON object — no explanation, no markdown fences, no <think> tags. Start your response with {';
        const triageCacheSegments = [{ content: triageSystemPrompt, cacheBreakpoint: true }];
        agent.getAttentionController().setTriageJudge(async (prompt: string) => {
          const response = await llmRouter.chat({
            messages: [
              { role: 'system', content: triageSystemPrompt },
              { role: 'user', content: prompt },
            ],
            systemCacheSegments: triageCacheSegments,
            temperature: TRIAGE_TEMPERATURE,
            maxTokens: TRIAGE_MAX_TOKENS,
          }, triageProvider);
          return response.content;
        });

        // Wire LLM interrupt judge — evaluates whether to preempt current
        // work when a new message arrives (e.g. "stop publishing", "pause that task").
        // Only called when heuristics return 'continue' for ambiguous cases.
        const interruptSystemPrompt = 'You are an attention interrupt judge. Decide whether to interrupt current work for a new incoming message. Reply with ONLY one word: continue, preempt, cancel, merge, or defer. Use "preempt" to pause (resume later) and "cancel" to permanently stop current work.';
        const interruptCacheSegments = [{ content: interruptSystemPrompt, cacheBreakpoint: true }];
        agent.getAttentionController().setLLMJudge(async (prompt: string) => {
          const response = await llmRouter.chat({
            messages: [
              { role: 'system', content: interruptSystemPrompt },
              { role: 'user', content: prompt },
            ],
            systemCacheSegments: interruptCacheSegments,
            temperature: 0.1,
            maxTokens: 32,
          }, triageProvider);
          const raw = response.content.trim().toLowerCase();
          const valid: DecisionType[] = ['continue', 'preempt', 'cancel', 'merge', 'defer'];
          return valid.includes(raw as DecisionType) ? (raw as DecisionType) : 'continue';
        });

        // Wire triage chat function (fallback mini tool loop, used when
        // performDeliberation is not available or deliberation is disabled).
        // The attention controller prefers full-session deliberation via
        // delegate.performDeliberation when available.
        agent.getAttentionController().setTriageChatFn(async (messages, tools) => {
          const llmTools = tools?.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }));
          const response = await llmRouter.chat({
            messages: messages as any,
            tools: llmTools,
            temperature: TRIAGE_TEMPERATURE,
            maxTokens: TRIAGE_MAX_TOKENS,
          }, triageProvider);
          return { content: response.content, toolCalls: response.toolCalls, reasoningContent: response.reasoningContent };
        });

        // Wire read-only triage tools from the agent's tool set
        const triageToolMap = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> }>();
        const agentTools = agent.getTools();
        for (const toolName of TRIAGE_ALLOWED_TOOLS) {
          const handler = agentTools.get(toolName);
          if (handler) {
            triageToolMap.set(toolName, {
              name: handler.name,
              description: handler.description,
              inputSchema: handler.inputSchema,
              execute: handler.execute.bind(handler),
            });
          }
        }
        if (triageToolMap.size > 0) {
          agent.getAttentionController().setTriageTools(triageToolMap);
        }
      } catch { /* agent not found */ }
    };

    // Wire for existing agents
    for (const a of agentManager.listAgents()) wireMailboxPersistence(a.id);

    // Wire for future agents via event bus
    agentManager.getEventBus().on('agent:created', (evt: unknown) => {
      const { agentId } = evt as { agentId: string };
      wireMailboxPersistence(agentId);
    });
  }

  // Persist runtime-created agents (e.g. via package_install role) to DB
  if (storage?.agentRepo) {
    const agentRepo = storage.agentRepo;
    const existingIds = new Set(agentManager.listAgents().map(a => a.id));
    agentManager.getEventBus().on('agent:created', (evt: unknown) => {
      const { agentId } = evt as { agentId: string };
      if (existingIds.has(agentId)) return;
      existingIds.add(agentId);
      try {
        const agent = agentManager.getAgent(agentId);
        agentRepo.create({
          id: agent.id,
          name: agent.config.name,
          orgId: agent.config.orgId ?? 'default',
          teamId: agent.config.teamId,
          roleId: agent.config.roleId,
          roleName: agent.role.name,
          agentRole: agent.config.agentRole ?? 'worker',
          skills: agent.config.skills,
          llmConfig: agent.config.llmConfig,
          heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
        }).catch((err: unknown) => {
          log.warn('Failed to persist runtime-created agent to DB', { agentId, error: String(err) });
        });
      } catch { /* agent not found */ }
    });
  }

  // Wire agent activity logs to WS broadcast
  agentManager.getEventBus().on('agent:activity_log', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:activity_log', payload: event, timestamp: new Date().toISOString() });
  });

  // Wire mailbox & attention events to WS broadcast
  const eventBus = agentManager.getEventBus();
  eventBus.on('mailbox:new-item', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:mailbox', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('attention:decision', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:decision', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('attention:state-changed', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:attention', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('agent:focus-changed', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:focus', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('attention:triage', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:triage', payload: event, timestamp: new Date().toISOString() });
  });

  // Wire agent lifecycle events to WS broadcast
  eventBus.on('agent:removed', (event: unknown) => {
    const { agentId } = event as { agentId: string };
    const ws = apiServer.getWSBroadcaster();
    ws.broadcastAgentUpdate(agentId, 'removed');
  });
  eventBus.on('agent:paused', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:paused', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('agent:resumed', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:resumed', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('agent:started', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:started', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('agent:stopped', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'agent:stopped', payload: event, timestamp: new Date().toISOString() });
  });

  // Wire task completion/failure events to WS broadcast
  eventBus.on('task:completed', (event: unknown) => {
    const { taskId, agentId } = event as { taskId: string; agentId: string };
    const ws = apiServer.getWSBroadcaster();
    ws.broadcastTaskUpdate(taskId, 'completed', { agentId });
  });
  eventBus.on('task:failed', (event: unknown) => {
    const { taskId, agentId, error } = event as { taskId: string; agentId: string; error?: string };
    const ws = apiServer.getWSBroadcaster();
    ws.broadcastTaskUpdate(taskId, 'failed', { agentId, error });
  });

  // Wire system-wide events to WS broadcast
  eventBus.on('system:pause-all', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'system:pause-all', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('system:resume-all', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'system:resume-all', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('system:emergency-stop', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'system:emergency-stop', payload: event, timestamp: new Date().toISOString() });
  });
  eventBus.on('system:announcement', (event: unknown) => {
    const ws = apiServer.getWSBroadcaster();
    ws.broadcast({ type: 'system:announcement', payload: event, timestamp: new Date().toISOString() });
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
      const reply = await agent.sendMessage(message.content.text ?? '', message.senderId);
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

  // ── Step 5: Gateway ───────────────────────────────────────────────────────
  progress?.setActive(5);
  await messageRouter.connectAll([{ platform: 'webui', port: commPort }]);

  // Check for Feishu config
  const feishuAppId = config.integrations?.feishu?.appId ?? process.env['FEISHU_APP_ID'];
  const feishuAppSecret = config.integrations?.feishu?.appSecret ?? process.env['FEISHU_APP_SECRET'];
  if (feishuAppId && feishuAppSecret) {
    const feishuAdapter = new FeishuAdapter();
    messageRouter.registerAdapter(feishuAdapter);
    try {
      await messageRouter.connectAll([
        {
          platform: 'feishu',
          appId: feishuAppId,
          appSecret: feishuAppSecret,
        },
      ]);
      startupLog('OK', '飞书适配器已连接');
      progress?.complete(5, 'webhook adapters: WebUI + Feishu');
    } catch (error) {
      startupLog('WARN', `飞书适配器连接失败，跳过: ${error instanceof Error ? error.message : String(error)}`);
      progress?.complete(5, 'webhook adapter: WebUI only (Feishu failed)');
    }
  } else {
    progress?.complete(5, 'webhook adapter: WebUI only');
  }

  startupBlank();

  // ── Done — replace console.error spam with progress.finish() ────────────────
  const logFile = getStartupLogFile();
  const logFileName = logFile.replace(/.*[/\\]/, '') || logFile;
  const uiUrl = `http://localhost:${apiPort}`;

  progress?.finish(uiUrl);
  onProgress?.('ready', `server ready at ${uiUrl}`);

  // Build the shutdown function for programmatic use
  const shutdown = async () => {
    closeStartupLogger();
    closeRuntimeLogger();
    archiveService.stop();
    staleDetector.stop();
    scheduledTaskRunner.stop();
    apiServer.stop();
    await agentManager.shutdown();
    await messageRouter.disconnectAll();
  };

  const instance: BackendInstance = {
    apiServer,
    port: apiPort,
    url: uiUrl,
    shutdown,
  };

  // In headless mode (Electron), return without blocking
  if (headless) {
    // Still start restored agents in background
    orgService.startRestoredAgentsInBackground().then(async () => {
      try {
        await taskService.resumeInProgressTasks();
      } catch (err) {
        log.warn('Failed to auto-resume in_progress tasks', { error: String(err) });
      }
    });
    return instance;
  }

  // Auto-open browser after health check confirms the server is ready
  if (!process.env['NO_BROWSER'] && webUiDir) {
    openBrowserAfterHealthCheck(uiUrl, `${uiUrl}/api/health`);
  }

  // Non-blocking update check — runs after startup, never blocks or throws
  checkForUpdate().then(info => {
    if (info.updateAvailable) {
      console.log(`\n  \x1b[33m⬆ New version available: v${info.latestVersion} (current: v${info.currentVersion})\x1b[0m`);
      console.log(`    Visit \x1b[1mhttps://markus.global/download\x1b[0m to download the latest version\n`);
    }
  }).catch(() => {});

  // Start restored agents in background (server is already accepting requests),
  // then auto-resume in_progress tasks once all agents are ready.
  orgService.startRestoredAgentsInBackground().then(async () => {
    try {
      await taskService.resumeInProgressTasks();
    } catch (err) {
      log.warn('Failed to auto-resume in_progress tasks', { error: String(err) });
    }
  });

  process.on('SIGINT', () => {
    console.error('\nShutting down...');
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  // Keep alive (vitest sets process.env.VITEST so the start command can be tested)
  if (process.env.VITEST) {
    apiServer.stop();
    await messageRouter.disconnectAll();
    return undefined;
  }
  await new Promise(() => {});
  return undefined;
}

