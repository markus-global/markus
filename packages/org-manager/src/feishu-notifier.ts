import * as Lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@markus/shared';
import type { EventBus } from '@markus/core';
import type { HITLService, Notification as HITLNotification } from './hitl-service.js';
import { FeishuApiClient } from './feishu-api-client.js';

const log = createLogger('feishu-notifier');

// ── Types ───────────────────────────────────────────────────────────

export interface ForwardTarget {
  channelId: string;
  type: 'chat' | 'webhook' | 'open_id';
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

export type FeishuLocale = 'zh' | 'en';

export interface FeishuNotifierConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  locale?: FeishuLocale;
  notifyChatId?: string;
  notifyOpenId?: string;
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
  'agent:restored': 'notification',
  'agent:removed': 'notification',
};

// ── i18n ─────────────────────────────────────────────────────────────

const messages: Record<FeishuLocale, Record<string, string>> = {
  zh: {
    'btn.approve': '✅ 批准',
    'btn.reject': '❌ 驳回',
    'input.comment_placeholder': '输入审批意见（可选）',
    'input.comment_hint': '💡 回复本消息可附带审批意见',
    'toast.approved': '✅ 已批准',
    'toast.rejected': '❌ 已拒绝',
    'toast.option_selected': '✅ 已选择',
    'toast.expired': '该审批已被处理或已过期',
    'toast.error': '处理失败',
    'toast.received': '操作已收到',
    'card.approval': '审批',
    'card.status_approved': '已批准',
    'card.status_rejected': '已驳回',
    'card.selected': '已选择',
    'card.comment': '审批意见',
    'card.processed_at': '处理时间',
    'event.task_completed': '✅ 任务完成',
    'event.system_announcement': '📢 系统公告',
    'event.agent_started': '▶️ Agent 启动',
    'event.agent_stopped': '⏹️ Agent 停止',
    'event.agent_paused': '⏸️ Agent 暂停',
    'event.agent_resumed': '▶️ Agent 恢复',
    'event.agent_created': '🆕 Agent 创建',
    'event.agent_restored': '♻️ Agent 恢复就绪',
    'event.agent_removed': '🗑️ Agent 删除',
    'label.agent': 'Agent',
    'label.task_id': '任务 ID',
    'label.reason': '原因',
    'card.type_label': '类型',
  },
  en: {
    'btn.approve': '✅ Approve',
    'btn.reject': '❌ Reject',
    'input.comment_placeholder': 'Enter your comment (optional)',
    'input.comment_hint': '💡 Reply to this message to add a comment',
    'toast.approved': '✅ Approved',
    'toast.rejected': '❌ Rejected',
    'toast.option_selected': '✅ Option selected',
    'toast.expired': 'This approval has already been processed or expired',
    'toast.error': 'Processing failed',
    'toast.received': 'Action received',
    'card.approval': 'Approval',
    'card.status_approved': 'Approved',
    'card.status_rejected': 'Rejected',
    'card.selected': 'Selected',
    'card.comment': 'Comment',
    'card.processed_at': 'Processed at',
    'event.task_completed': '✅ Task Completed',
    'event.system_announcement': '📢 System Announcement',
    'event.agent_started': '▶️ Agent Started',
    'event.agent_stopped': '⏹️ Agent Stopped',
    'event.agent_paused': '⏸️ Agent Paused',
    'event.agent_resumed': '▶️ Agent Resumed',
    'event.agent_created': '🆕 Agent Created',
    'event.agent_restored': '♻️ Agent Restored',
    'event.agent_removed': '🗑️ Agent Removed',
    'label.agent': 'Agent',
    'label.task_id': 'Task ID',
    'label.reason': 'Reason',
    'card.type_label': 'Type',
  },
};

function t(locale: FeishuLocale, key: string): string {
  return messages[locale]?.[key] ?? messages['zh'][key] ?? key;
}

// ── Card Building Helpers ───────────────────────────────────────────

/** Build a Feishu interactive card from notification data. */
function buildNotificationCard(
  title: string,
  body: string,
  priority: string,
  eventType: string,
  locale: FeishuLocale,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  const color = priority === 'urgent' ? 'red' : priority === 'high' ? 'orange' : 'blue';
  const timeStr = locale === 'en'
    ? new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })
    : new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: body,
    },
  ];

  if (metadata?.approvalId) {
    const approvalId = metadata.approvalId as string;
    const options = metadata.options as Array<{ id: string; label: string; description?: string }> | undefined;
    const allowFreeform = metadata.allowFreeform as boolean | undefined;

    if (options && options.length > 0) {
      // Multi-option: render each option as a separate button
      const actions: Record<string, unknown>[] = options.map((opt, idx) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.label + (opt.description ? ` — ${opt.description}` : '') },
        type: idx === 0 ? 'primary' : (idx === options.length - 1 && options.length > 2 ? 'danger' : 'default'),
        value: { action: 'select_option', approval_id: approvalId, option_id: opt.id },
      }));
      elements.push({ tag: 'action', actions });
    } else {
      // Default: approve/reject
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t(locale, 'btn.approve') },
            type: 'primary',
            value: { action: 'approve', approval_id: approvalId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t(locale, 'btn.reject') },
            type: 'danger',
            value: { action: 'reject', approval_id: approvalId },
          },
        ],
      });
    }

    if (allowFreeform) {
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: t(locale, 'input.comment_hint') }],
      });
    }
  }

  elements.push(
    { tag: 'hr' },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `${t(locale, 'card.type_label')}: ${eventType} | ${timeStr}`,
        },
      ],
    },
  );

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template: color },
    elements,
  };
}

function buildSimpleCard(title: string, body: string, priority: string, eventType: string, locale: FeishuLocale): Record<string, unknown> {
  return buildNotificationCard(title, body, priority, eventType, locale, undefined);
}

// ── FeishuNotifier ──────────────────────────────────────────────────

export class FeishuNotifier {
  private eventBus: EventBus;
  private hitlService: HITLService;
  private orgId: string;
  private locale: FeishuLocale = 'zh';
  private agentManager?: { getAgentName?: (id: string) => string | undefined };
  private apiClient: FeishuApiClient | null = null;
  private config: FeishuNotifierConfig | null = null;
  private unsubscribes: Array<() => void> = [];
  private hitlUnsubscribe: (() => void) | null = null;
  private wsConnected = false;
  /** Map messageId → approvalId for tracking replies as comments */
  private approvalMessageMap = new Map<string, string>();

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
      this.locale = opts.config.locale ?? 'zh';
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
      this.startLongConnection(this.config).then(() => {
        if (this.wsConnected) {
          this.flushPendingOnConnect().catch((err) => {
            log.warn('Failed to flush pending items on connect', { error: String(err) });
          });
        }
      }).catch((err) => {
        log.error('Failed to start Feishu long connection on init', { error: String(err) });
      });
    }

    log.info('FeishuNotifier started');
  }

  /** On first connection, send all pending approvals and unread notifications. */
  private async flushPendingOnConnect(): Promise<void> {
    if (!this.apiClient || !this.config) return;

    const L = this.locale;
    const pendingApprovals = this.hitlService.listApprovals('pending');

    // Send each pending approval as a card with action buttons
    for (const approval of pendingApprovals) {
      const title = `🔔 ${approval.title}`;
      const body = `${t(L, 'label.agent')}: ${approval.agentName}\n\n${approval.description}`;
      const metadata: Record<string, unknown> = { approvalId: approval.id };
      if (approval.options?.length) metadata['options'] = approval.options;
      if (approval.allowFreeform) metadata['allowFreeform'] = true;
      await this.routeNotification('approval_requested', 'high', title, body, metadata);
    }

    // Send unread notifications summary (batch into one card to avoid spam)
    const unreadNotifs = this.hitlService.listNotifications('all', true, { limit: 20 });
    if (unreadNotifs.length > 0) {
      const lines = unreadNotifs.slice(0, 10).map(n => `• **${n.title}** — ${n.body.slice(0, 60)}`);
      if (unreadNotifs.length > 10) {
        lines.push(L === 'en'
          ? `• ...and ${unreadNotifs.length - 10} more`
          : `• ...还有 ${unreadNotifs.length - 10} 条`);
      }
      const title = L === 'en'
        ? `📬 ${unreadNotifs.length} Unread Notification(s)`
        : `📬 ${unreadNotifs.length} 条未读通知`;
      const body = lines.join('\n');
      await this.routeNotification('notification', 'normal', title, body);
    }

    if (pendingApprovals.length > 0 || unreadNotifs.length > 0) {
      log.info('Flushed pending items on Feishu connect', {
        approvals: pendingApprovals.length,
        notifications: unreadNotifs.length,
      });
    }
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
    this.locale = config.locale ?? 'zh';
    if (config.appId && config.appSecret) {
      if (this.apiClient) {
        this.apiClient.stopWSClient();
      }
      this.apiClient = new FeishuApiClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.domain,
      });
      this.startLongConnection(config).then(() => {
        if (this.wsConnected) {
          this.flushPendingOnConnect().catch((err) => {
            log.warn('Failed to flush pending on reconnect', { error: String(err) });
          });
        }
      }).catch((err) => {
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
      'card.action.trigger': (data: unknown) => {
        log.info('card.action.trigger event fired', { data: JSON.stringify(data).slice(0, 500) });
        return this.handleCardAction(data);
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
        parent_id?: string;
        root_id?: string;
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
    const parentId = event.message?.parent_id ?? event.message?.root_id;

    // Check if this is a reply to an approval card → treat as approval comment
    if (parentId && this.approvalMessageMap.has(parentId)) {
      const approvalId = this.approvalMessageMap.get(parentId)!;
      const approval = this.hitlService.getApproval(approvalId);
      if (approval && approval.status === 'pending') {
        let textContent = '';
        try {
          const parsed = JSON.parse(content);
          textContent = parsed.text ?? content;
        } catch { textContent = content; }

        // Store comment on the approval without resolving it
        if (textContent && approval.allowFreeform) {
          approval.responseComment = textContent;
          log.info('Approval comment received via reply', { approvalId, comment: textContent.slice(0, 100) });
          // Send confirmation
          if (this.apiClient && senderId) {
            const confirmText = this.locale === 'zh'
              ? `💬 已记录审批意见: "${textContent.slice(0, 50)}"`
              : `💬 Comment recorded: "${textContent.slice(0, 50)}"`;
            this.apiClient.sendTextToUser(senderId, confirmText).catch(() => {});
          }
          return;
        }
      }
    }

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

  /** Handle interactive card button actions (approve/reject/select_option). */
  private handleCardAction(data: unknown): Record<string, unknown> {
    const payload = data as {
      action?: { value?: { action?: string; approval_id?: string; option_id?: string }; name?: string; input_value?: string };
      open_id?: string;
      form_value?: Record<string, string>;
    };

    const actionValue = payload?.action?.value;
    if (!actionValue?.approval_id || !actionValue?.action) {
      return { toast: { type: 'info', content: t(this.locale, 'toast.received') } };
    }

    const approvalId = actionValue.approval_id;
    const actionType = actionValue.action;
    const respondedBy = payload?.open_id ?? 'feishu_user';

    // Extract comment: from form_value, action input, or pre-filled reply comment
    const existingApproval = this.hitlService.getApproval(approvalId);
    const comment = payload?.form_value?.[`comment_${approvalId}`]
      ?? payload?.action?.input_value
      ?? existingApproval?.responseComment
      ?? undefined;

    let approved: boolean;
    let selectedOption: string | undefined;

    if (actionType === 'select_option') {
      selectedOption = actionValue.option_id;
      approved = true;
    } else {
      approved = actionType === 'approve';
    }

    log.info('Feishu card action: processing approval', { actionType, approvalId, respondedBy, selectedOption, hasComment: !!comment });

    let result: { status: string; title: string; agentName: string; description: string } | undefined;
    try {
      result = this.hitlService.respondToApproval(
        approvalId,
        approved,
        respondedBy,
        comment ? `${comment}` : `Via Feishu card action`,
        selectedOption,
      ) as typeof result;
      if (result) {
        log.info('Approval processed via Feishu card', { approvalId, status: result.status, selectedOption });
      } else {
        log.warn('Approval not found or already processed', { approvalId });
        return {
          toast: { type: 'warning', content: t(this.locale, 'toast.expired') },
        };
      }
    } catch (err) {
      log.error('Failed to process approval via Feishu card', { approvalId, error: String(err) });
      return {
        toast: { type: 'error', content: `${t(this.locale, 'toast.error')}: ${String(err).slice(0, 100)}` },
      };
    }

    this.eventBus.emit('feishu:card_action', {
      action: actionType,
      approvalId,
      selectedOption,
      comment,
      openId: payload?.open_id,
    });

    // Return updated card to replace the original (showing processed state)
    const updatedCard = this.buildProcessedCard(result, approved, selectedOption, comment);
    let toastContent: string;
    if (actionType === 'select_option' && selectedOption) {
      toastContent = `${t(this.locale, 'toast.option_selected')}: ${selectedOption}`;
    } else {
      toastContent = approved ? t(this.locale, 'toast.approved') : t(this.locale, 'toast.rejected');
    }
    return {
      toast: { type: 'success', content: toastContent },
      card: { type: 'raw', data: updatedCard },
    };
  }

  /** Build a card that replaces the original after an approval has been processed. */
  private buildProcessedCard(
    approval: { status: string; title: string; agentName: string; description: string },
    approved: boolean,
    selectedOption?: string,
    comment?: string,
  ): Record<string, unknown> {
    const L = this.locale;
    const timeStr = L === 'en'
      ? new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })
      : new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const statusIcon = approved ? '✅' : '❌';
    const statusText = selectedOption
      ? `${statusIcon} ${t(L, 'card.selected')}: ${selectedOption}`
      : (approved ? `${statusIcon} ${t(L, 'card.status_approved')}` : `${statusIcon} ${t(L, 'card.status_rejected')}`);

    const headerColor = approved ? 'green' : 'red';
    const headerTitle = `${statusIcon} ${approval.title}`;

    const elements: Record<string, unknown>[] = [
      {
        tag: 'markdown',
        content: `${t(L, 'label.agent')}: ${approval.agentName}\n\n${approval.description}`,
      },
    ];

    // Status badge
    elements.push({
      tag: 'markdown',
      content: `**${statusText}**`,
    });

    // Comment if any
    if (comment) {
      elements.push({
        tag: 'markdown',
        content: `💬 ${t(L, 'card.comment')}: ${comment}`,
      });
    }

    elements.push(
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: `${t(L, 'card.processed_at')}: ${timeStr}` },
        ],
      },
    );

    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: headerTitle }, template: headerColor },
      elements,
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

    const L = this.locale;
    const resolveAgentName = (id?: string | unknown): string => {
      if (!id || typeof id !== 'string') return 'Unknown';
      return this.agentManager?.getAgentName?.(id) ?? id;
    };

    switch (eventName) {
      case 'task:completed': {
        const agentName = resolveAgentName(payload['agentId']);
        const taskTitle = payload['title'] as string | undefined;
        title = t(L, 'event.task_completed');
        body = `${t(L, 'label.agent')}: ${agentName}`;
        if (taskTitle) body += `\n${taskTitle}`;
        else body += `\n${t(L, 'label.task_id')}: ${payload['taskId'] as string}`;
        priority = 'normal';
        break;
      }
      case 'system:announcement': {
        title = t(L, 'event.system_announcement');
        body = (payload['content'] as string) ?? payload['message'] as string ?? '';
        priority = payload['priority'] as string ?? 'high';
        break;
      }
      case 'agent:started': {
        const agentName = resolveAgentName(payload['agentId']);
        title = t(L, 'event.agent_started');
        body = `${t(L, 'label.agent')}: ${agentName}`;
        priority = 'low';
        break;
      }
      case 'agent:stopped': {
        const agentName = resolveAgentName(payload['agentId']);
        const reason = payload['reason'] as string | undefined;
        title = t(L, 'event.agent_stopped');
        body = `${t(L, 'label.agent')}: ${agentName}`;
        if (reason) body += `\n${t(L, 'label.reason')}: ${reason}`;
        priority = 'high';
        break;
      }
      case 'agent:paused': {
        const agentName = resolveAgentName(payload['agentId']);
        const reason = payload['reason'] as string | undefined;
        title = t(L, 'event.agent_paused');
        body = `${t(L, 'label.agent')}: ${agentName}`;
        if (reason) body += `\n${t(L, 'label.reason')}: ${reason}`;
        priority = 'high';
        break;
      }
      case 'agent:resumed': {
        const agentName = resolveAgentName(payload['agentId']);
        title = t(L, 'event.agent_resumed');
        body = `${t(L, 'label.agent')}: ${agentName}`;
        priority = 'low';
        break;
      }
      case 'agent:created': {
        const agentName = (payload['name'] as string) ?? resolveAgentName(payload['agentId']);
        title = t(L, 'event.agent_created');
        body = `${t(L, 'label.agent')}: ${agentName}`;
        priority = 'normal';
        break;
      }
      case 'agent:restored': {
        const agentName = (payload['name'] as string) ?? resolveAgentName(payload['agentId']);
        title = t(L, 'event.agent_restored');
        body = `${t(L, 'label.agent')}: ${agentName}`;
        priority = 'low';
        break;
      }
      case 'agent:removed': {
        const agentName = resolveAgentName(payload['agentId']);
        title = t(L, 'event.agent_removed');
        body = `${t(L, 'label.agent')}: ${agentName}`;
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
      const approval = this.hitlService.getApproval(notification.metadata.approvalId as string);
      if (approval) {
        if (approval.options?.length) metadata['options'] = approval.options;
        if (approval.allowFreeform) metadata['allowFreeform'] = true;
      }
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

    // Fallback: use notifyChatId or notifyOpenId from simplified config
    if (matchedTargets.length === 0 && (this.config.notifyChatId || this.config.notifyOpenId)) {
      const isApprovalType = ['approval_requested', 'approval_approved', 'approval_rejected'].includes(eventType);
      const shouldForward = isApprovalType
        ? this.config.notifyOnApproval !== false
        : this.config.notifyOnNotification === true;

      if (shouldForward) {
        const allowedPriorities = this.config.notifyPriority ?? ['high', 'urgent'];
        if (allowedPriorities.includes(priority) || allowedPriorities.includes('*')) {
          if (this.config.notifyChatId) {
            matchedTargets.push({ type: 'chat', channelId: this.config.notifyChatId });
          } else if (this.config.notifyOpenId) {
            matchedTargets.push({ type: 'open_id', channelId: this.config.notifyOpenId });
          }
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

    const includeActions = !!metadata?.approvalId;

    const card = includeActions
      ? buildNotificationCard(title, body, priority, eventType, this.locale, metadata)
      : buildSimpleCard(title, body, priority, eventType, this.locale);

    for (const target of uniqueTargets) {
      try {
        let messageId: string | undefined;
        if (target.type === 'webhook') {
          const resp = await fetch(target.channelId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msg_type: 'interactive', card }),
          });
          if (!resp.ok) {
            log.warn('Feishu webhook send failed', { channelId: target.channelId, status: resp.status });
          }
        } else if (target.type === 'open_id') {
          messageId = await this.apiClient!.sendCardToUser(target.channelId, card);
        } else {
          messageId = await this.apiClient!.sendCard(target.channelId, card);
        }
        // Track approval card messages for reply-based comments
        if (messageId && metadata?.approvalId) {
          this.approvalMessageMap.set(messageId, metadata.approvalId as string);
        }
      } catch (err) {
        log.error('Failed to send Feishu notification', {
          channelId: target.channelId,
          type: target.type,
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
