/**
 * C10-B —— 外部信号源自助工具面（镜像 address-tools 模式，契约 D11）。
 *
 * 判据（与 address-tools 同口径）：Agent 看不到日志，只能靠返回值建模 ——
 *   - 「没注册上」不是 false，而是 {status:'bounced', reason, hint}；
 *   - 「不是你的源」是 {status:'forbidden'}（所有权裁决在端口 = org-manager 唯一写者）；
 *   - 身份永远来自 ctx（args 里的 agent_id/org_id 被忽略，不能冒充）。
 *
 * 这里只做**表面语义**（kind 闭集、参数形状）；注册/开关的裁决与持久化在
 * org-manager 的 ExternalSourceService + storage repo（core 不依赖 storage/org-manager：
 * 端口是结构化接口，接线在 agent-manager + cli）。
 */
import type { AgentToolHandler } from '../agent.js';

/** 端口回执（结构化投影；与 org-manager 服务层回执形状兼容）。 */
export interface ExternalSourceRegisterResult {
  status: string;
  source?: { id: string };
  reason?: string;
  hint?: string;
  /**
   * C10-F: the organization's inbound policy at registration time. An agent may
   * register a source (Owner ruling A), but it may not open the organization's
   * door — so the receipt must say what the door currently is, or the agent will
   * believe it just wired up something that can never fire.
   */
  ingress?: string;
  ingressNote?: string;
}

export interface ExternalSourceToggleResult {
  status: string;
  enabled?: boolean;
  reason?: string;
  hint?: string;
}

export interface ExternalSourceListRecord {
  id: string;
  kind: string;
  address: string;
  enabled: boolean;
  /** Relative inbound path for webhook sources (`/api/webhooks/<id>`); null for RSS. */
  urlPath?: string | null;
  hasSecret?: boolean;
  secretPreview?: string | null;
  feedUrl?: string | null;
  lastEventAt?: string | null;
  lastError?: string | null;
}

/** List receipt: the org policy travels with the sources it governs. */
export interface ExternalSourceListResult {
  policy: string;
  sources: ExternalSourceListRecord[];
}

/** 外部源端口。缺省（未接线）⇒ 工具不注册（与 address-tools 同纪律）。 */
export interface ExternalSourcePort {
  register(input: {
    orgId: string;
    agentId: string;
    kind: string;
    address: string;
    config?: Record<string, unknown>;
  }): ExternalSourceRegisterResult;
  list(input: { orgId: string; agentId: string }): ExternalSourceListResult;
  toggle(input: {
    orgId: string;
    agentId: string;
    sourceId: string;
    enabled: boolean;
  }): ExternalSourceToggleResult;
}

export interface ExternalSourceToolContext extends ExternalSourcePort {
  agentId: string;
  orgId: string;
}

function bounced(reason: string, hint: string): string {
  return JSON.stringify({ status: 'bounced', reason, hint });
}

export function createExternalSourceTools(ctx: ExternalSourceToolContext): AgentToolHandler[] {
  return [
    {
      name: 'external_source_register',
      description:
        'Register an external signal source delivering to one of YOUR bound mailbox addresses. ' +
        'kind="webhook" (POST /api/webhooks/<sourceId>, optional config.token shared secret) or ' +
        'kind="rss" (config.feedUrl required; polled periodically). The address must already be bound ' +
        'to you (bind_address first). Returns {status:"registered", source:{id}} or ' +
        '{status:"bounced"|"forbidden", reason, hint} — read the hint to decide the next step. ' +
        'Signals arrive as records (they never force an action turn); you see them in your next turn.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '"webhook" or "rss".' },
          address: { type: 'string', description: 'Your bound address, e.g. "news.markus@markus.global".' },
          config: {
            type: 'object',
            description: 'rss: {feedUrl, pollIntervalMs?}. webhook: {token?} (optional shared secret).',
          },
        },
        required: ['kind', 'address'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const kind = args['kind'];
        if (kind !== 'webhook' && kind !== 'rss') {
          return bounced('invalid_kind', 'kind must be "webhook" or "rss".');
        }
        const address = args['address'];
        if (typeof address !== 'string' || address.trim().length === 0) {
          return bounced('invalid_address', 'Pass your bound address, e.g. "news.markus@markus.global" (bind_address first).');
        }
        const rawConfig = args['config'];
        const config =
          rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
            ? (rawConfig as Record<string, unknown>)
            : undefined;
        if (kind === 'rss' && (typeof config?.['feedUrl'] !== 'string' || (config['feedUrl'] as string).length === 0)) {
          return bounced('invalid_config', 'rss requires config.feedUrl (the feed URL to poll).');
        }
        // 身份来自 ctx —— args 里的 agent_id/org_id 一律忽略（不能冒充）。
        const out = ctx.register({ orgId: ctx.orgId, agentId: ctx.agentId, kind, address: address.trim(), config });
        return JSON.stringify(out);
      },
    },
    {
      name: 'external_source_list',
      description:
        'List YOUR external signal sources (id, kind, address, enabled, inbound path, last event, '
        + 'last error) together with the organization ingress policy that governs them: '
        + '"off" = inbound refused, "observe" = recorded but does not wake you, "accept" = owes a turn. '
        + 'Use the id with external_source_toggle to pause/resume a source (kill switch). '
        + 'If policy is not "accept", say so to the human — they change it in Settings, you cannot.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        return JSON.stringify(ctx.list({ orgId: ctx.orgId, agentId: ctx.agentId }));
      },
    },
    {
      name: 'external_source_toggle',
      description:
        'Pause (enabled=false) or resume (enabled=true) one of YOUR external signal sources — ' +
        'the persistent kill switch (survives restarts). Returns {status:"toggled", enabled} or ' +
        '{status:"forbidden"|"bounced", hint}. You can only toggle your own sources.',
      inputSchema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'The source id from external_source_list / register.' },
          enabled: { type: 'boolean', description: 'false = pause (kill switch), true = resume.' },
        },
        required: ['source_id', 'enabled'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const sourceId = args['source_id'];
        if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
          return bounced('invalid_source_id', 'Pass source_id from external_source_list.');
        }
        const enabled = args['enabled'];
        if (typeof enabled !== 'boolean') {
          return bounced('invalid_enabled', 'enabled must be a boolean (false = pause, true = resume).');
        }
        const out = ctx.toggle({ orgId: ctx.orgId, agentId: ctx.agentId, sourceId: sourceId.trim(), enabled });
        return JSON.stringify(out);
      },
    },
  ];
}
