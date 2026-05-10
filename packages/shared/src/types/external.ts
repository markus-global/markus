/**
 * External Mode types.
 *
 * Defines the data model for agents serving external users and agents
 * through shareable links and A2A protocol.
 */

// ─── Service Configuration ──────────────────────────────────────────────────

export type ExternalServiceStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface ExternalServiceConfig {
  id: string;
  agentId: string;
  snapshotId: string;
  version: number;
  status: ExternalServiceStatus;

  /** Display name for external users */
  name: string;
  description?: string;
  /** Avatar/icon URL */
  avatarUrl?: string;

  /** Max concurrent active LLM calls across all sessions */
  maxConcurrentSessions: number;
  /** Session inactivity timeout (ms) */
  sessionTimeoutMs: number;
  /** Max messages per session before auto-close */
  maxMessagesPerSession: number;

  /** Tool policy for external sessions */
  toolPolicy: ExternalToolPolicy;
  /** Input validation config */
  inputValidation: InputValidationConfig;
  /** Output content filter config */
  contentFilter: ContentFilterConfig;

  /** Per-session token budget */
  tokenBudgetPerSession: number;
  /** Daily token budget across all sessions */
  tokenBudgetPerDay: number;

  /** UI configuration */
  uiMode: 'default' | 'custom';
  uiConfig?: CustomUIConfig;

  /** Ordered middleware chain */
  middlewares: MiddlewareConfig[];

  /** Welcome message shown at session start */
  welcomeMessage?: string;
  /** Placeholder text for input field */
  inputPlaceholder?: string;

  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export interface ExternalToolPolicy {
  /** Tool profile name (maps to tool-profiles.ts) */
  profile: 'external' | 'minimal' | 'custom';
  /** Explicit allow list (used when profile is 'custom') */
  allow?: string[];
  /** Explicit deny list (always applied on top of profile) */
  deny?: string[];
}

export interface InputValidationConfig {
  /** Max characters per message */
  maxMessageLength: number;
  /** Block messages matching these regex patterns */
  blockedPatterns?: string[];
  /** Allow file attachments */
  allowFileUpload: boolean;
  /** Max file size in bytes (if upload allowed) */
  maxFileSizeBytes?: number;
  /** Allowed file MIME types */
  allowedFileTypes?: string[];
}

export interface ContentFilterConfig {
  /** Enable output filtering */
  enabled: boolean;
  /** Patterns to strip from agent responses (e.g. internal URLs, task IDs) */
  stripPatterns?: string[];
  /** Block responses containing these patterns */
  blockPatterns?: string[];
  /** Enable PII detection in output */
  piiDetection?: boolean;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export type ExternalSessionStatus = 'active' | 'idle' | 'closed' | 'expired' | 'error';

export interface ExternalSession {
  id: string;
  serviceId: string;
  agentId: string;

  /** External user/agent identity */
  participantId: string;
  participantType: 'human' | 'agent';
  participantName?: string;
  participantMetadata?: Record<string, unknown>;

  status: ExternalSessionStatus;
  messageCount: number;
  tokensUsed: number;

  /** IP address of the participant (for rate limiting) */
  ipAddress?: string;
  userAgent?: string;

  createdAt: string;
  lastActivityAt: string;
  closedAt?: string;
  closeReason?: 'user_ended' | 'timeout' | 'token_limit' | 'message_limit' | 'error' | 'admin';
}

// ─── Messages ───────────────────────────────────────────────────────────────

export type ExternalMessageRole = 'user' | 'assistant' | 'system';

export interface ExternalMessage {
  id: string;
  sessionId: string;
  role: ExternalMessageRole;
  content: string;
  /** Token count for this message */
  tokens?: number;
  /** Metadata for audit (tool calls, latency, etc.) */
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ─── Share Tokens ───────────────────────────────────────────────────────────

export type ShareTokenStatus = 'active' | 'revoked' | 'expired';

export interface ShareToken {
  id: string;
  token: string;
  serviceId: string;
  agentId: string;

  /** Who created this share link */
  createdBy: string;
  status: ShareTokenStatus;

  /** Permissions granted by this token */
  permissions: SharePermissions;

  /** Max number of sessions that can be created with this token */
  maxUses?: number;
  /** Current usage count */
  usageCount: number;

  expiresAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface SharePermissions {
  /** Allow creating new sessions */
  canChat: boolean;
  /** Allow file uploads */
  canUploadFiles: boolean;
  /** Custom metadata passed to middleware */
  custom?: Record<string, unknown>;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

export type MiddlewarePhase = 'pre' | 'post' | 'both';

export interface MiddlewareConfig {
  /** Unique name identifying this middleware */
  name: string;
  /** Whether enabled */
  enabled: boolean;
  /** Execution phase */
  phase: MiddlewarePhase;
  /** Priority (lower = runs first) */
  priority: number;
  /** Middleware-specific configuration */
  config: Record<string, unknown>;
}

export interface ExternalContext {
  session: ExternalSession;
  message: IncomingExternalMessage;
  response?: OutgoingExternalResponse;
  /** Shared state across middleware chain */
  state: Record<string, unknown>;
  /** Audit entries accumulated during processing */
  audit: AuditEntry[];
  /** Timestamp when processing started */
  startedAt: number;
  /** Whether processing should be aborted */
  aborted: boolean;
  /** Abort reason (set by middleware) */
  abortReason?: string;
}

export interface IncomingExternalMessage {
  content: string;
  /** File attachments (if any) */
  attachments?: ExternalAttachment[];
  /** Client metadata */
  clientMetadata?: Record<string, unknown>;
}

export interface OutgoingExternalResponse {
  content: string;
  /** Whether response is still streaming */
  streaming: boolean;
  /** Tool calls made during response generation */
  toolCalls?: Array<{ name: string; input: unknown; output: unknown }>;
  /** Tokens consumed */
  tokensUsed: number;
  /** Processing time in ms */
  latencyMs: number;
}

export interface ExternalAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface AuditEntry {
  timestamp: string;
  type: 'auth' | 'input_validation' | 'rate_limit' | 'content_filter' | 'tool_call' | 'error' | 'custom';
  action: string;
  success: boolean;
  detail?: string;
  metadata?: Record<string, unknown>;
}

// ─── UI Configuration ───────────────────────────────────────────────────────

export type UILayout = 'fullpage' | 'widget' | 'sidebar';

export interface CustomUIConfig {
  layout: UILayout;
  theme: UITheme;
  components: UIComponent[];
  welcomeMessage?: string;
  placeholder?: string;
  /** Custom CSS (sanitized) */
  customCss?: string;
}

export interface UITheme {
  primaryColor: string;
  backgroundColor?: string;
  textColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  logoUrl?: string;
  faviconUrl?: string;
}

export type UIComponentType = 'chat' | 'form' | 'file-upload' | 'payment' | 'rating' | 'header' | 'footer' | 'custom';

export interface UIComponent {
  type: UIComponentType;
  position: 'header' | 'footer' | 'sidebar' | 'inline' | 'overlay';
  config: Record<string, unknown>;
  /** Show only when a condition is met */
  showWhen?: 'always' | 'session_start' | 'session_end' | 'custom';
}

// ─── Service Stats ──────────────────────────────────────────────────────────

export interface ExternalServiceStats {
  serviceId: string;
  date: string;
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  totalTokensUsed: number;
  averageSessionDuration: number;
  averageMessagesPerSession: number;
  errorCount: number;
}

// ─── Agent Card (A2A Protocol) ──────────────────────────────────────────────

export interface AgentServiceCard {
  name: string;
  description: string;
  version: string;
  provider: { organization: string; url?: string };
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    fileUpload: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    inputModes: string[];
    outputModes: string[];
  }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  securitySchemes?: Record<string, unknown>;
}
