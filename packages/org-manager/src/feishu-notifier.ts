import * as Lark from '@larksuiteoapi/node-sdk';
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
  notifyChatId?: string;
  notifyOnApproval?: boolean;
  notifyOnNotification?: boolean;
  notifyPriority?: string[];
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
  private wsConnected = false;

  constructor(opts: {
    eventBus: EventBus;
    hitlService: HITLService;
    orgId: string;
    agentManager?: { getAgentName?: (id: string) => string | undefined };
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

  /** Whether the long connection is active. */
  get connected(): boolean {
    return this.wsConnected;
  }

  /** Start listening — subscribe to EventBus events, HITL notifications, and establish Feishu long connection. */
  start(): void {
    for (const [eventName] of Object.entries(EVENT_MAP)) {
      const unsub = this.eventBus.on(eventName, (...args: unknown[]) => {
        this.handleEventBusEvent(eventName, args).catch((err) => {
          log.error('Failed to handle EventBus event', { event: eventName, error: String(err) });
        });
      });
      this.unsubscribes.push(unsub);
    }

    this.hitlUnsubscribe = this.hitlService.onNotification((notification: HITLNotification) => {
      this.handleHITLNotification(notification).catch((err) => {
        log.error('Failed to handle HITL notification', { error: String(err) });
      });
    });

    if (this.config) {
      this.startLongConnection(this.config).catch((err) => {
        log.error('Failed to start Feishu long connection on init', { error: String(err) });
      });
    }

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
    if (this.apiClient) {
      this.apiClient.stopWSClient();
    }
    this.apiClient = null;
    this.config = null;
    this.wsConnected = false;
    log.info('FeishuNotifier stopped');
  }

  /** Update the Feishu integration config at runtime (e.g. when settings are saved). */
  updateConfig(config: FeishuNotifierConfig): void {
    this.config = config;
    if (config.appId && config.appSecret) {
      if (this.apiClient) {
        this.apiClient.stopWSClient();
      }
      this.apiClient = new FeishuApiClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.domain,
      });
      this.startLongConnection(config).catch((err) => {
        log.error('Failed to restart Feishu long connection', { error: String(err) });
      });
    } else {
      if (this.apiClient) {
        this.apiClient.stopWSClient();
      }
      this.apiClient = null;
      this.wsConnected = false;
    }
    log.info('FeishuNotifier config updated');
  }

  /** Establish the WebSocket long connection to receive Feishu events. */
  private async startLongConnection(config: FeishuNotifierConfig): Promise<void> {
    if (!this.apiClient) {
      this.apiClient = new FeishuApiClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.domain,
      });
    }

    const eventDispatcher = new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.debug,
    }).register({
      'im.message.receive_v1': (data: unknown) => {
        log.info('im.message.receive_v1 event fired', { hasData: !!data, dataKeys: data ? Object.keys(data as object).join(',') : 'null' });
        this.handleFeishuMessage(data).catch((err: unknown) => {
          log.error('Failed to handle Feishu message', { error: String(err) });
        });
      },
    });

    // Monkey-patch invoke to log ALL incoming events for debugging
    const originalInvoke = eventDispatcher.invoke.bind(eventDispatcher);
    eventDispatcher.invoke = async (data: unknown, params?: { needCheck?: boolean }) => {
      log.info('EventDispatcher.invoke called', {
        dataType: typeof data,
        dataKeys: data && typeof data === 'object' ? Object.keys(data).join(',') : 'n/a',
      });
      return originalInvoke(data, params);
    };

    try {
      await this.apiClient.startWSClient(eventDispatcher);
      this.wsConnected = true;
      log.info('Feishu long connection established successfully');
    } catch (err) {
      this.wsConnected = false;
      log.error('Failed to start Feishu long connection', { error: String(err) });
    }
  }

  /** Handle incoming Feishu messages (from bot chat). */
  private async handleFeishuMessage(data: unknown): Promise<void> {
    const event = data as {
      sender?: {
        sender_id?: { open_id?: string; user_id?: string; union_id?: string };
        sender_type?: string;
      };
      message?: {
        chat_id?: string;
        message_id?: string;
        content?: string;
        message_type?: string;
        chat_type?: string;
      };
    };

    const chatId = event?.message?.chat_id;
    const content = event?.message?.content;
    if (!chatId || !content) {
      log.warn('Feishu message missing chatId or content', {
        hasChatId: !!chatId,
        hasContent: !!content,
        dataKeys: data ? Object.keys(data as object) : [],
      });
      return;
    }

    const senderId = event.sender?.sender_id?.open_id;
    log.info('Received Feishu message', {
      chatId,
      senderId,
      messageType: event.message?.message_type,
      chatType: event.message?.chat_type,
    });

    this.eventBus.emit('feishu:message_received', {
      chatId,
      messageId: event.message?.message_id,
      content,
      messageType: event.message?.message_type,
      senderId,
    });
  }

  /** Handle interactive card button actions (approve/reject). */
  private handleCardAction(data: unknown): Record<string, unknown> {
    const action = data as {
      action?: { value?: { action?: string; approval_id?: string } };
      open_id?: string;
    };

    const actionValue = action?.action?.value;
    if (actionValue?.approval_id) {
      log.info('Feishu card action', { action: actionValue.action, approvalId: actionValue.approval_id });
      this.eventBus.emit('feishu:card_action', {
        action: actionValue.action,
        approvalId: actionValue.approval_id,
        openId: action?.open_id,
      });
    }

    return {
      toast: {
        type: 'success',
        content: actionValue?.action === 'approve' ? '已批准' : '已拒绝',
      },
    };
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

    // Fallback: use notifyChatId from simplified config if no explicit rules matched
    if (matchedTargets.length === 0 && this.config.notifyChatId) {
      const isApprovalType = ['approval_request', 'approval_approved', 'approval_rejected'].includes(eventType);
      const shouldForward = isApprovalType
        ? this.config.notifyOnApproval !== false
        : this.config.notifyOnNotification === true;

      if (shouldForward) {
        const allowedPriorities = this.config.notifyPriority ?? ['high', 'urgent'];
        if (allowedPriorities.includes(priority) || allowedPriorities.includes('*')) {
          matchedTargets.push({ type: 'chat', channelId: this.config.notifyChatId });
        }
      }
    }

    // Deduplicate by channelId
    const seen = new Set<string>();
    const uniqueTargets = matchedTargets.filter(t => {
      if (seen.has(t.channelId)) return false;
      seen.add(t.channelId);
      return true;
    });

    if (uniqueTargets.length === 0) return;

    const includeActions = metadata?.approvalId
      ? rules.some(r => r.type === eventType && r.enabled && r.includeApprovalActions) || true
      : false;

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

  /** Send a text message to a specific Feishu chat. */
  async sendTextToChat(chatId: string, text: string): Promise<void> {
    if (!this.apiClient) return;
    await this.apiClient.sendText(chatId, text);
  }
}
