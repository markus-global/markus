import { createLogger } from '@markus/shared';
import type { EventBus } from '@markus/core';
import type { HITLService, Notification as HITLNotification } from './hitl-service.js';
import { FeishuApiClient } from './feishu-api-client.js';

const log = createLogger('feishu-notifier');

// ── Types ───────────────────────────────────────────────────────────

export interface ForwardTarget {
  channelId: string;
  type: 'chat' | 'webhook';
}

export interface NotificationForwardRule {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  priorityFilter: string;
  targets: ForwardTarget[];
  keywordFilter?: string;
  includeApprovalActions?: boolean;
}

export interface FeishuNotifierConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  forwardRules: NotificationForwardRule[];
}

// EventBus event → FeishuForwardEventType mapping
const EVENT_MAP: Record<string, string> = {
  'task:completed': 'task_completed',
  'system:announcement': 'notification',
  'agent:started': 'notification',
  'agent:stopped': 'notification',
  'agent:paused': 'notification',
  'agent:resumed': 'notification',
  'agent:created': 'notification',
  'agent:removed': 'notification',
};

// ── Card Building Helpers ───────────────────────────────────────────

/** Build a Feishu interactive card from notification data. */
function buildNotificationCard(
  title: string,
  body: string,
  priority: string,
  eventType: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const color = priority === 'urgent' ? 'red' : priority === 'high' ? 'orange' : 'blue';
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: body,
    },
    {
      tag: 'hr',
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `Type: ${eventType} | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        },
      ],
    },
  ];

  // Add action buttons for approval events
  if (metadata?.approvalId) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ Approve' },
          type: 'primary',
          value: { action: 'approve', approval_id: metadata.approvalId as string },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ Reject' },
          type: 'danger',
          value: { action: 'reject', approval_id: metadata.approvalId as string },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: color },
    elements,
  };
}

function buildSimpleCard(title: string, body: string, priority: string, eventType: string): Record<string, unknown> {
  return buildNotificationCard(title, body, priority, eventType, undefined);
}

// ── FeishuNotifier ──────────────────────────────────────────────────

export class FeishuNotifier {
  private eventBus: EventBus;
  private hitlService: HITLService;
  private orgId: string;
  private agentManager?: { getAgentName?: (id: string) => string | undefined };
  private apiClient: FeishuApiClient | null = null;
  private config: FeishuNotifierConfig | null = null;
  private unsubscribes: Array<() => void> = [];
  private hitlUnsubscribe: (() => void) | null = null;

  constructor(opts: {
    eventBus: EventBus;
    hitlService: HITLService;
    orgId: string;
    agentManager?: { getAgentName?: (id: string) => string | undefined };
    /** Optional initial config — can be set later via updateConfig(). */
    config?: FeishuNotifierConfig;
  }) {
    this.eventBus = opts.eventBus;
    this.hitlService = opts.hitlService;
    this.orgId = opts.orgId;
    this.agentManager = opts.agentManager;
    if (opts.config?.appId && opts.config?.appSecret) {
      this.config = opts.config;
    }
  }

  /** Start listening — subscribe to EventBus events and HITL notifications. */
  start(): void {
    // Subscribe to EventBus events
    for (const [eventName] of Object.entries(EVENT_MAP)) {
      const unsub = this.eventBus.on(eventName, (...args: unknown[]) => {
        this.handleEventBusEvent(eventName, args).catch((err) => {
          log.error('Failed to handle EventBus event', { event: eventName, error: String(err) });
        });
      });
      this.unsubscribes.push(unsub);
    }

    // Subscribe to HITL notifications
    this.hitlUnsubscribe = this.hitlService.onNotification((notification: HITLNotification) => {
      this.handleHITLNotification(notification).catch((err) => {
        log.error('Failed to handle HITL notification', { error: String(err) });
      });
    });

    log.info('FeishuNotifier started');
  }

  /** Stop listening and clean up. */
  stop(): void {
    for (const unsub of this.unsubscribes) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.unsubscribes = [];
    if (this.hitlUnsubscribe) {
      try { this.hitlUnsubscribe(); } catch { /* ignore */ }
      this.hitlUnsubscribe = null;
    }
    this.apiClient = null;
    this.config = null;
    log.info('FeishuNotifier stopped');
  }

  /** Update the Feishu integration config at runtime (e.g. when settings are saved). */
  updateConfig(config: FeishuNotifierConfig): void {
    this.config = config;
    if (config.appId && config.appSecret) {
      if (!this.apiClient) {
        this.apiClient = new FeishuApiClient({
          appId: config.appId,
          appSecret: config.appSecret,
          domain: config.domain,
        });
      } else {
        this.apiClient.clearToken();
      }
    } else {
      this.apiClient = null;
    }
    log.info('FeishuNotifier config updated');
  }

  /** Handle an EventBus event. */
  private async handleEventBusEvent(eventName: string, args: unknown[]): Promise<void> {
    if (!this.apiClient || !this.config) return;

    const forwardType = EVENT_MAP[eventName];
    if (!forwardType) return;

    const payload = args[0] as Record<string, unknown> | undefined;
    if (!payload) return;

    let title = '';
    let body = '';
    let priority = 'normal';

    switch (eventName) {
      case 'task:completed': {
        const agentName = payload['agentId']
          ? this.agentManager?.getAgentName?.(payload['agentId'] as string) ?? payload['agentId'] as string
          : 'Unknown';
        title = '✅ 任务完成';
        body = `Agent: ${agentName}\nTask ID: ${payload['taskId'] as string}`;
        break;
      }
      case 'system:announcement': {
        title = '📢 系统公告';
        body = (payload['content'] as string) ?? payload['message'] as string ?? '';
        priority = payload['priority'] as string ?? 'high';
        break;
      }
      case 'agent:started': {
        title = '▶️ Agent 启动';
        body = `Agent: ${payload['agentId'] as string}`;
        break;
      }
      case 'agent:stopped': {
        title = '⏹️ Agent 停止';
        body = `Agent: ${payload['agentId'] as string}`;
        priority = 'high';
        break;
      }
      case 'agent:paused': {
        title = '⏸️ Agent 暂停';
        const reason = payload['reason'] as string | undefined;
        body = `Agent: ${payload['agentId'] as string}${reason ? `\n原因: ${reason}` : ''}`;
        priority = 'high';
        break;
      }
      case 'agent:resumed': {
        title = '▶️ Agent 恢复';
        body = `Agent: ${payload['agentId'] as string}`;
        break;
      }
      case 'agent:created': {
        title = '🆕 Agent 创建';
        body = `Agent: ${(payload['name'] as string) ?? payload['agentId'] as string}`;
        break;
      }
      case 'agent:removed': {
        title = '🗑️ Agent 删除';
        body = `Agent ID: ${payload['agentId'] as string}`;
        priority = 'high';
        break;
      }
      default: {
        title = eventName;
        body = JSON.stringify(payload);
      }
    }

    await this.routeNotification(forwardType, priority, title, body, payload['metadata'] as Record<string, unknown> | undefined);
  }

  /** Handle a HITL notification. */
  private async handleHITLNotification(notification: HITLNotification): Promise<void> {
    if (!this.apiClient || !this.config) return;

    const typeMap: Record<string, string> = {
      'approval_request': 'approval_requested',
      'task_created': 'task_assigned',
      'task_completed': 'task_completed',
      'task_review': 'task_assigned',
      'task_failed': 'notification',
      'requirement_created': 'notification',
      'requirement_decision': 'notification',
      'agent_report': 'report_ready',
      'direct_message': 'mention',
      'group_message': 'mention',
      'system': 'notification',
    };

    const forwardType = typeMap[notification.type] ?? 'notification';
    const title = notification.title;
    const body = notification.body;
    const priority = notification.priority;

    const metadata: Record<string, unknown> = {};
    if (notification.type === 'approval_request' && notification.metadata?.approvalId) {
      metadata['approvalId'] = notification.metadata.approvalId;
    }

    await this.routeNotification(forwardType, priority, title, body, metadata);
  }

  /** Match rules and send to all matched targets. */
  private async routeNotification(
    eventType: string,
    priority: string,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config) return;

    const rules = this.config.forwardRules ?? [];
    const matchedTargets: ForwardTarget[] = [];

    for (const rule of rules) {
      if (!rule.enabled) continue;

      if (rule.type !== '*' && rule.type !== eventType) continue;

      if (rule.priorityFilter === 'urgent' && priority !== 'urgent') continue;
      if (rule.priorityFilter === 'high' && priority !== 'high' && priority !== 'urgent') continue;

      if (rule.keywordFilter) {
        const kw = rule.keywordFilter.toLowerCase();
        const haystack = `${title} ${body}`.toLowerCase();
        if (!haystack.includes(kw)) continue;
      }

      matchedTargets.push(...rule.targets);
    }

    // Deduplicate by channelId
    const seen = new Set<string>();
    const uniqueTargets = matchedTargets.filter(t => {
      if (seen.has(t.channelId)) return false;
      seen.add(t.channelId);
      return true;
    });

    if (uniqueTargets.length === 0) return;

    const includeActions = rules.some(
      r => r.type === eventType && r.enabled && r.includeApprovalActions && metadata?.approvalId,
    );

    const card = includeActions
      ? buildNotificationCard(title, body, priority, eventType, metadata)
      : buildSimpleCard(title, body, priority, eventType);

    for (const target of uniqueTargets) {
      try {
        if (target.type === 'webhook') {
          const resp = await fetch(target.channelId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msg_type: 'interactive', card }),
          });
          if (!resp.ok) {
            log.warn('Feishu webhook send failed', { channelId: target.channelId, status: resp.status });
          }
        } else {
          await this.apiClient!.sendCard(target.channelId, card);
        }
      } catch (err) {
        log.error('Failed to send Feishu notification', {
          channelId: target.channelId,
          error: String(err),
        });
      }
    }
  }
}
