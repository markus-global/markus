/**
 * Integration Configuration Types
 *
 * Defines the shape of external platform integration configurations
 * (Feishu, Slack, Telegram, etc.) for persistent storage and API exchange.
 */

// ─── Platform union ──────────────────────────────────────────────────────────

/** Supported external IM platforms */
export type IntegrationPlatform = 'feishu' | 'slack' | 'telegram' | 'whatsapp' | 'wecom';

/** Integration operational status */
export type IntegrationStatus = 'active' | 'inactive' | 'error' | 'pending_verify';

// ─── Base integration config ─────────────────────────────────────────────────

/** Generic integration configuration base type */
export interface IntegrationConfig {
  /** Unique identifier (e.g. "feishu_default") */
  id: string;
  /** Platform identifier */
  platform: IntegrationPlatform;
  /** Human-readable label */
  displayName: string;
  /** Whether this integration is enabled */
  enabled: boolean;
  /** Operational status (default: 'inactive') */
  status?: IntegrationStatus;
  /** Org-scoped — which org owns this config */
  orgId: string;
  /** Platform-specific config payload (validated by the consumer) */
  config: Record<string, unknown>;
  /** Notification forwarding rules */
  forwardRules?: NotificationForwardRule[];
  /** Last verification result */
  lastVerifiedAt?: string | null;
  /** Last verification error message */
  lastError?: string | null;
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
}

// ─── Feishu-specific config payload ──────────────────────────────────────────

/** Feishu-specific configuration payload stored inside IntegrationConfig.config */
export interface FeishuConfigPayload {
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /** Verification token for webhook event verification */
  verificationToken?: string;
  /** AES encrypt key for webhook payload decryption */
  encryptKey?: string;
  /** Webhook listener port (default: 8058) */
  webhookPort?: number;
  /** Feishu API base domain (default: "https://open.feishu.cn") */
  domain?: string;
}

// ─── Notification forwarding rules ───────────────────────────────────────────

/** Conditions that trigger a forward */
export interface ForwardCondition {
  /** Match by notification type (e.g. "task_assigned", "mention") */
  type?: string;
  /** Match by priority (e.g. "high", "urgent") */
  priority?: string;
  /** Match by keyword in notification title/body */
  keyword?: string;
}

/** Target for a single forward destination */
export interface ForwardTarget {
  /** Feishu chat/webhook URL or channel ID */
  channelId: string;
  /** Whether this target is active */
  enabled: boolean;
}

/** A single notification forwarding rule */
export interface NotificationForwardRule {
  /** Unique rule ID */
  id: string;
  /** Human-readable rule name */
  name: string;
  /** Whether the rule is active */
  enabled: boolean;
  /** Notification type filter (e.g. "approval", "mention", "all") */
  type: string;
  /** Priority filter (e.g. "urgent", "high", "all") */
  priorityFilter: string;
  /** List of target channels to forward to */
  targets: ForwardTarget[];
  /** Optional keyword filter */
  keywordFilter?: string;
  /** Whether to include approval action buttons in the card */
  includeApprovalActions?: boolean;
}

// ─── Approval event forwarding (for EventBus) ────────────────────────────────

/** Event types that can trigger Feishu notification */
export type FeishuForwardEventType =
  | 'notification'
  | 'approval_requested'
  | 'approval_responded'
  | 'task_assigned'
  | 'task_completed'
  | 'mention'
  | 'report_ready';

/** Mapping from EventBus event types to forward rules */
export interface FeishuEventForwardMap {
  eventType: FeishuForwardEventType;
  ruleIds: string[];
}
