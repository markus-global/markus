// Core service
export { ExternalService, type ExternalServiceDeps, type ExternalServiceStore, type ExternalSessionStore, type ExternalMessageStore, type SnapshotProvider } from './external-service.js';
export { SessionWorker, type LLMRouterLike, type ContextEngineLike, type ToolHandler, type SessionMessageStore, type ToolCall } from './session-worker.js';
export { SessionPool, type SessionPoolConfig } from './session-pool.js';
export { ShareManager, type ShareManagerConfig, type ShareTokenStore } from './share-manager.js';

// Prompt engineering
export { buildExternalSystemPrompt, buildFallbackExternalPrompt, type PersonaSnapshot, type ExternalPromptOpts } from './prompt-builder.js';

// Middleware pipeline + all built-in middlewares
export {
  MiddlewarePipeline,
  createSecurityGateMiddleware, checkInputSafety,
  createRateLimiterMiddleware,
  createAuditLoggerMiddleware,
  createContentFilterMiddleware,
  createTokenBudgetMiddleware,
  createAuthCheckerMiddleware,
  createPaymentMiddleware,
  createFileUploadMiddleware,
  createFeedbackMiddleware,
  LLMModerationService, createInputModerationHook, createOutputModerationHook,
  type MiddlewareHandler, type MiddlewareDefinition,
  type ModerationHook, type SecurityGateConfig,
  type OutputModerationHook, type LLMModerationConfig, type ModerationResult,
  type TokenBudgetConfig, type TokenUsageTracker,
  type AuthValidator,
  type PaymentConfig, type PaymentProvider,
  type FileUploadConfig, type FileStorageProvider,
  type FeedbackConfig, type FeedbackStore, type FeedbackEntry,
} from './middleware/index.js';

// API layer
export { createExternalRoutes, type ExternalRouteContext, type HttpRequest, type HttpResponse } from './api/routes.js';
export { SSEConnectionManager, formatSSEEvent, formatSSEDone, type SSEConnection } from './api/sse-handler.js';
export { generateAgentCard, createAgentCardHandler, type AgentCardOptions } from './api/agent-card.js';

// CommAdapter integration
export { ExternalChatAdapter } from './comm-adapter.js';

// UI config
export { validateUIConfig, normalizeUIConfig, type ValidationResult } from './ui/config-schema.js';

// Internal-External Bridge
export { InternalExternalBridge, type MailboxInjector, type ExternalStatsProvider, type DailySummary, type UnansweredQuery } from './internal-bridge.js';

// Types
export type { StreamCallback, StreamEvent, SessionWorkerConfig } from './types.js';
