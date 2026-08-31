export { Agent } from './agent.js';
export type { AgentToolHandler, ApprovalCallback, TaskProjectContext } from './agent.js';
export { ToolHookRegistry, auditLogHook, generateIdempotencyKey } from './tool-hooks.js';
export type { ToolHook, ToolHookContext, BeforeToolResult, AfterToolResult } from './tool-hooks.js';
export { startSpan, trace, setTracingProvider } from './tracing.js';
export type { Span, SpanAttributes, TracingProvider } from './tracing.js';
export {
  AgentManager,
  type CreateAgentRequest,
  type RequirementServiceBridge,
  type RoleUpdateStatus,
  type RoleFileStatus,
  type RoleFileDiff,
  type RoleSyncResult,
} from './agent-manager.js';
export { RoleLoader } from './role-loader.js';
export { HeartbeatScheduler } from './heartbeat.js';
export { ContextEngine, type OrgContext, type ContextConfig, type LLMSummarizer, type SystemPromptResult, type SystemPromptSegment } from './context-engine.js';
export { CognitivePreparation, selectCognitiveDepth, type CognitiveLLM, type RetrievalBackend } from './cognitive.js';
export {
  SmartTokenCounter,
  getDefaultTokenCounter,
  initTokenCounter,
  type TokenCounter,
} from './token-counter.js';
export {
  detectEnvironment,
  clearEnvironmentCache,
  type EnvironmentProfile,
  type ToolInfo,
  type BrowserInfo,
  type RuntimeInfo,
} from './environment-profile.js';
export { ToolSelector, type ToolGroup } from './tool-selector.js';
export { LLMRouter } from './llm/router.js';
export type { ChatOptions } from './llm/router.js';
export { LLMLogger, type LLMLogEntry } from './llm/llm-logger.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIProvider } from './llm/openai.js';
export { MiniMaxProvider } from './llm/minimax.js';
export { DashScopeProvider } from './llm/dashscope.js';
export { FireworksProvider } from './llm/fireworks.js';
export { CodexResponsesProvider } from './llm/openai-codex.js';
export { getEffectiveProxy, type EffectiveProxy, type ProxySource } from './llm/proxy-fetch.js';
export { GoogleProvider } from './llm/google.js';
export { OllamaProvider } from './llm/ollama.js';
export { MarkusProvider, resolveMarkusRoute, clearMarkusModelListCache } from './llm/markus-provider.js';
export type { MarkusRoute, MarkusRouteCatalogEntry, MarkusModelInfo } from './llm/markus-provider.js';
export {
  applyHubRecommendedRouting,
  fetchHubRecommendations,
  isGreenfieldLlmConfig,
  isObsoleteMarkusModel,
  recommendedUrlFromModelsUrl,
  markusCatalogUrlFromHub,
  isLegacyMarkusProxyBaseUrl,
  RECOMMENDED_CAPABILITY_KEYS,
  type HubRecommendations,
  type ApplyRecommendedResult,
} from './llm/hub-recommended-routing.js';
export { AuthProfileStore } from './llm/auth-profiles.js';
export { OAuthManager } from './llm/oauth-manager.js';
export { ModelCatalogService } from './llm/model-catalog.js';
export { estimateQualityScore, tierFromQualityScore, costTierFromPrice } from './llm/router.js';
export { MemoryStore, parseNotebook, serializeNotebook, loadNotebook, saveNotebook } from './memory/store.js';
export type { NotebookEntry, NotebookEntryManaged } from './memory/store.js';
export { PendingCallbackRegistry, pendingCallbackRegistry } from './pending-callback.js';
export type { PendingCallback, CallbackResult, CallbackPersistence } from './pending-callback.js';
export type { IMemoryStore, MemoryEntry, ConversationSession } from './memory/types.js';

export {
  SemanticMemorySearch,
  OpenAIEmbeddingProvider,
  LocalVectorStore,
  type EmbeddingProvider,
  type VectorStore,
  type SemanticSearchResult,
} from './memory/semantic-search.js';
export { AgentMetricsCollector } from './agent-metrics.js';
export type { AgentMetricsSnapshot, TokenUsage, TaskMetrics } from './agent-metrics.js';
export { OpenClawConfigParser } from './openclaw-config-parser.js';
export type { OpenClawRoleConfig } from './openclaw-config-parser.js';
export { EnhancedRoleLoader } from './enhanced-role-loader.js';
export type { EnhancedRoleTemplate } from './enhanced-role-loader.js';
export { ExternalAgentGateway, GatewayError } from './external-gateway.js';
export type {
  GatewayConfig,
  GatewayStore,
  ExternalAgentRegistration,
  GatewayToken,
  GatewayMessage,
  GatewayMessageResult,
} from './external-gateway.js';
export { generateHandbook, GatewaySyncHandler } from './gateway/index.js';
export type {
  HandbookContext,
  HandbookColleague,
  HandbookProject,
  SyncRequest,
  SyncResponse,
  SyncTeamContext,
  SyncProjectContext,
  TaskBridge,
  MessageBridge,
  AgentStatusUpdater,
  TeamBridge,
  ProjectBridge,
} from './gateway/index.js';
export {
  ReviewService,
  createDescriptionChecker,
  createChangedFilesChecker,
  createTypeScriptChecker,
  createTestChecker,
  createLintChecker,
} from './review-service.js';
export type {
  ReviewReport,
  ReviewCheckResult,
  ReviewChecker,
  ReviewContext,
} from './review-service.js';
export { EventBus } from './events.js';
export { AgentMailbox, type EnqueueOptions, type MailboxPersistence } from './mailbox.js';
export {
  AttentionController,
  type AttentionDelegate,
  type DecisionPersistence,
  type LLMDecisionJudge,
} from './attention.js';
export { SecurityGuard, defaultSecurityGuard, type SecurityPolicy } from './security.js';
export {
  GuardrailPipeline,
  promptInjectionGuardrail,
  sensitiveDataGuardrail,
  createMaxLengthGuardrail,
} from './guardrails.js';
export type { InputGuardrail, OutputGuardrail, GuardrailResult } from './guardrails.js';
export { DEFAULT_REQUEST_MAX_TOKENS } from './llm/provider.js';
export type { LLMProviderInterface, MultiModalProviderInterface, ImageGenOptions, ImageResult, TTSOptions, AudioResult, STTOptions, VideoGenOptions, VideoResult } from './llm/provider.js';
export {
  ShellTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  WebFetchTool,
  WebSearchTool,
  testSearchProvider,
  resolveMarkusSearchProvider,
  type MarkusSearchProviderId,
  createShellTool,
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
  createGrepTool,
  createGlobTool,
  createListDirectoryTool,
  createPatchTool,
  createBackgroundExecTool,
  createProcessTool,
  onBackgroundCompletion,
  drainCompletedNotifications,
  MCPClientManager,
  createBuiltinTools,
  createManagerTools,
  type ManagerToolsContext,
  createPackageTools,
  type PackageToolsContext,
  createA2ATools,
  type A2AContext,
  createStructuredA2ATools,
  type StructuredA2AContext,
  createSubagentTool,
  createParallelSubagentTool,
  runSubagentLoop,
  type SubagentContext,
  type SubagentProgressCallback,
  createMultiModalTools,
  type MultiModalToolsContext,
  createFeishuTools,
  type FeishuToolsConfig,
} from './tools/index.js';
export {
  ToolLoopDetector,
  type ToolCallRecord,
  type LoopDetectionConfig,
  type LoopDetectionResult,
} from './tool-loop-detector.js';
export {
  applyToolPolicy,
  getToolGroups,
  getAvailableProfiles,
  type ToolProfile,
  type ToolPolicyConfig,
} from './tool-profiles.js';
export {
  type SkillManifest,
  type SkillInstance,
  type SkillRegistry,
  type SkillCategory,
  type SkillToolDef,
  InMemorySkillRegistry,
  createDefaultSkillRegistry,
  discoverSkillsInDir,
  WELL_KNOWN_SKILL_DIRS,
  detectSkillPackageFormat,
  formatLabel,
  importSkillPackage,
  exportSkillPackage,
  renderSkill,
  parseSkillPackage,
  mapAllowedToolsToPermissions,
  json5ToJson,
  SUPPORTED_EXTERNAL_FORMATS,
  type ExternalSkillFormat,
  type NormalizedSkill,
  type SkillImportOptions,
  type SkillImportResult,
  type SkillExportOptions,
  type SkillExportResult,
} from './skills/index.js';
export {
  SkillLoader,
  readSkillInstructions,
  type SkillPackage,
  type SkillSearchResult,
  type SkillLoadResult,
} from './skills/loader.js';
export {
  TemplateRegistry,
  createDefaultTemplateRegistry,
  type TemplatePersistenceAdapter,
  type AgentTemplate,
  type TemplateSource,
  type TemplateSearchQuery,
  type TemplateSearchResult,
  type TemplateInstantiateRequest,
} from './templates/index.js';
export {
  WorkflowEngine,
  createPipeline,
  createFanOut,
  createReviewChain,
  createParallelConsensus,
  TeamTemplateRegistry,
  createDefaultTeamTemplates,
  type WorkflowDefinition,
  type StepDefinition,
  type WorkflowExecution,
  type StepExecution,
  type WorkflowEvent,
  type WorkflowExecutor,
  type WorkflowEventHandler,
  type WorkflowStatus,
  type StepStatus,
  type StepType,
  type PipelineStage,
  type FanOutConfig,
  type TeamTemplate,
  type TeamMemberSpec,
  type TeamInstantiateRequest,
  type TeamInstantiateResult,
} from './workflow/index.js';
export {
  FederationManager,
  DEFAULT_SANDBOX,
  type FederationAgentProvider,
  type FederationEventHandler,
  type FederationLink,
  type FederationStatus,
  type TrustLevel,
  type FederatedAgent,
  type CrossOrgMessage,
  type SandboxPolicy,
  type FederationPolicy,
  type FederationEvent,
} from './federation/index.js';
export {
  AgentSnapshotManager,
  type AgentSnapshot,
  type MemorySnapshot,
  type MigrationResult,
  type AgentDataProvider,
  type AgentDataRestorer,
} from './agent-snapshot.js';
export {
  clickChromeAllowDialog,
  checkAutoClickStatus,
  testAutoClick,
  type AutoClickCheckResult,
  type AutoClickTestResult,
} from './tools/chrome-dialog-clicker.js';
export { MarkusBrowserBridge } from './tools/markus-browser-bridge.js';
export { createBridgeToolHandlers, getBridgeToolDescriptors } from './tools/markus-browser-mcp.js';
export type { EmbeddedBrowserHost, EmbeddedBrowserToolResult } from './tools/embedded-browser-host.js';
export type { BrowserTestResult, BrowserTestStep, ChaosEvent, ChaosOpResult, ChaosStats, ChaosDone } from './tools/browser-test.js';
export { getAdapter, getAllAdapters } from './coding-tools/index.js';

// Agent Runtime — Context Economics + Learning Loop
export {
  scenarioToPack,
  packToolDefBudget,
  getReflexAllowlist,
  getDistillationAllowlist,
  DISTILLATION_EXTRA_TOOLS,
  estimateToolDefTokens,
  evictToolsToBudget,
  formatEvictedToolCatalog,
  type CapabilityPack,
  type PromptProfile,
} from './capability-packs.js';
export { evaluatePromptAfford, ensureAffordablePromptPack } from './afford-guard.js';
export { shouldEnterDeepSleep, nextDeepSleepIntervalMs } from './deep-sleep.js';
export {
  shouldDistillTask,
  recordSkillActivation,
  loadSkillStats,
  type SkillStats,
} from './learning-loop.js';
export {
  buildDistillationPrompt,
  type DistillationPromptInput,
  type DistillationPromptKind,
} from './distillation.js';
export { computeEvolutionMetrics, type EvolutionMetrics } from './evolution-metrics.js';
export { formatTaskContextForPrompt, buildTaskContextPackage } from './task-context.js';
export {
  DeliverableShareService,
  DeliverableShareError,
  NotLoggedIntoHubError,
  DeliverableTooLargeError,
  HubApiError,
  HUB_DELIVERABLE_MAX_BYTES,
  base64ByteLength,
  type DeliverableShareDeps,
  type ShareDeliverableInput,
  type DeliverableShareWriteBack,
  type DeliverableShareRecord,
  type ProducerAgentInfo,
  type ShareVisibility,
  type ShareStatus,
} from './deliverable-share.js';
export { matchAgentsForSkillFanout, applyFanoutDailyCap } from './skill-fanout.js';
export { extractTextFromFile, convertFilesToText, resetMarkitdownCache, type ConvertedFile } from './file-converter.js';
