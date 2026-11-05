/**
 * 责任域工具：让 agent **自己**声明「我负责哪个资源、负责到哪一档」。
 *
 * 这是整条链路的入口——没有它，责任域只能靠人在 UI 上一次点点点配置，
 * agent 永远是被动的。
 *
 * 三条硬约束（来自设计文档 §4.2）：
 *  1. **升档要返回「已提交审批」而不是「已生效」**。工具结果是 agent 唯一的反馈通道，
 *     撒谎的代价是它会在后续回合里以为权限已经到手，进而做出越界动作。
 *  2. **绑定即订阅**：绑定成功顺带建订阅，后续事件天然直通，不新造机制。
 *  3. 解绑只能解自己的；解绑不删任何既有产物（卡/交付物都留着，只是不再自动接单）。
 */
import type { AgentToolHandler } from '../agent.js';
import { autonomyNeedsApproval, isScope, L3_SCOPE, RESOURCE_SCOPES } from '@markus/shared';
import type { Autonomy, MandateState, ResourceBinding, ResourceScope } from '@markus/shared';

export interface ResourceToolDeps {
  agentId: string;
  agentName: string;
  teamId?: string;
  bindings: {
    bind(b: {
      holder: { kind: 'agent' | 'team'; id: string };
      resource: string;
      scope: ResourceScope;
      autonomy?: Autonomy;
      grantedBy: string;
    }): { ok: true; binding: ResourceBinding } | { ok: false; reason: string };
    findByHolder(kind: 'agent' | 'team', id: string, resource: string): ResourceBinding | null;
    listByHolder(kind: 'agent' | 'team', id: string): ResourceBinding[];
    listByResource(resource: string): ResourceBinding[];
    unbind(id: string): boolean;
  };
  /** 绑定即订阅：由调用方注入（core 不直接依赖 thread 存储） */
  subscribe(resource: string, agentId: string): void;
  /** 升档审批通道。缺失时工具**不得**假装已生效，只能回 pending_approval。 */
  requestApproval?: (req: { agentId: string; resource: string; scope: ResourceScope; autonomy: Autonomy }) => Promise<boolean>;
  /**
   * 逐件事审批（Mandate）的读取器。缺失 = 一律 'none'（不知道就是没批）。
   *
   * 为什么放在这里而不是 core 自己查：core 不依赖 storage。为什么 agent 需要它：
   * 执行闸门（`Agent.enforceRedLine`）要回答「这件事批了没有」，答案只能来自审批库。
   */
  mandates?: {
    findMandate(q: { agentId: string; resource: string; actionScope: ResourceScope; eventKey?: string }): { state: MandateState };
  };
  /** 资源最近发生了什么（可选；缺失时明说「未知」，不编） */
  recentActivity?: (resource: string) => string[] | undefined;
}

const RESOURCE_HELP =
  '资源键格式：`<prefix>:<local>`，例如 `gh:owner/repo`、`xhs:brand_01`、`rss:competitor-a`；' +
  '平台实体直接写 id（`tsk_…`）。前缀必须是已登记的来源（见 event_sources）。';

export function buildResourceTools(deps: ResourceToolDeps): AgentToolHandler[] {
  return [
    {
      name: 'resource_bind',
      description:
        'Declare that YOU (or your team) are responsible for an external resource, and to what degree. ' +
        'scope is ordered by reversibility: read < draft < publish < admin. ' +
        'autonomy decides how you behave: off (never act) / observe (record, do not act) / auto (act, then report) / trusted (act silently). ' +
        'Binding ALSO subscribes you to that resource, so future events come straight to you. ' +
        'IMPORTANT: raising autonomy to auto/trusted requires human approval — when that happens this tool returns ' +
        "status:'pending_approval', which means NOT yet in effect. Only admin is exclusive (one holder per resource). " +
        RESOURCE_HELP,
      inputSchema: {
        type: 'object',
        properties: {
          resource: { type: 'string', description: '资源键，例如 `xhs:brand_01` 或 `gh:owner/repo`' },
          scope: { type: 'string', enum: [...RESOURCE_SCOPES], description: 'read < draft < publish < admin（按可撤回性递增）' },
          autonomy: {
            type: 'string',
            enum: ['off', 'observe', 'auto', 'trusted'],
            description: '默认 observe：先记录、不自动动手',
          },
          for_team: { type: 'boolean', description: 'true = 以团队名义绑定（默认以自己名义）' },
        },
        required: ['resource', 'scope'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const resource = String(args['resource'] ?? '').trim();
        const scope = String(args['scope'] ?? '');
        const autonomy = (args['autonomy'] ? String(args['autonomy']) : 'observe') as Autonomy;
        const forTeam = args['for_team'] === true && !!deps.teamId;

        if (!resource) {
          return JSON.stringify({ status: 'error', error: 'resource 必填。' + RESOURCE_HELP });
        }
        if (!isScope(scope)) {
          return JSON.stringify({
            status: 'error',
            error: `scope 只能是 ${RESOURCE_SCOPES.join(' / ')}（按可撤回性递增），收到 "${scope}"`,
          });
        }
        if (!['off', 'observe', 'auto', 'trusted'].includes(autonomy)) {
          return JSON.stringify({ status: 'error', error: `autonomy 只能是 off / observe / auto / trusted，收到 "${autonomy}"` });
        }

        const holder = forTeam
          ? ({ kind: 'team', id: deps.teamId! } as const)
          : ({ kind: 'agent', id: deps.agentId } as const);

        // 升档：先审批，后落库。顺序反了就会出现「已生效但没批」的窗口。
        if (autonomyNeedsApproval(autonomy)) {
          const existing = deps.bindings.findByHolder(holder.kind, holder.id, resource);
          const alreadyAt = existing && existing.autonomy === autonomy;
          if (!alreadyAt) {
            if (!deps.requestApproval) {
              return JSON.stringify({
                status: 'pending_approval',
                effective: false,
                resource,
                scope,
                autonomy,
                reason: `autonomy=${autonomy} 需要人批准，但当前会话没有审批通道，因此**尚未生效**。请让人在 UI 里批准后重试。`,
              });
            }
            const approved = await deps.requestApproval({ agentId: deps.agentId, resource, scope, autonomy });
            if (!approved) {
              return JSON.stringify({
                status: 'rejected',
                effective: false,
                resource,
                scope,
                autonomy,
                reason: '审批未通过，权限未变更。可以先用 autonomy=observe 继续观察。',
              });
            }
          }
        }

        const result = deps.bindings.bind({
          holder,
          resource,
          scope,
          autonomy,
          grantedBy: `agent:${deps.agentId}`,
        });

        if (!result.ok) {
          return JSON.stringify({ status: 'conflict', effective: false, resource, reason: result.reason });
        }

        // 绑定即订阅：后续事件直通，不需要再单独订阅一次
        deps.subscribe(resource, holder.kind === 'agent' ? holder.id : deps.agentId);

        return JSON.stringify({
          status: 'bound',
          effective: true,
          holder: holder.kind === 'agent' ? deps.agentName : `team:${holder.id}`,
          resource,
          scope,
          autonomy,
          exclusive: scope === L3_SCOPE,
          subscribed: true,
          next:
            autonomy === 'observe'
              ? '你现在会收到该资源的事件并留痕，但不会自动动手。确认判断稳定后可以升到 auto（需人批）。'
              : '事件会直接投给你，按 autonomy 档位执行。',
        });
      },
    },

    {
      name: 'resource_release',
      description:
        'Release YOUR responsibility for a resource. Only bindings you own can be released — ' +
        'another agent’s or a team’s binding will be refused. Releasing never deletes tasks or deliverables ' +
        'already produced; it only stops new events from being routed to you.',
      inputSchema: {
        type: 'object',
        properties: { resource: { type: 'string', description: '要解除的资源键' } },
        required: ['resource'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const resource = String(args['resource'] ?? '').trim();
        if (!resource) return JSON.stringify({ status: 'error', error: 'resource 必填' });

        const own = deps.bindings.findByHolder('agent', deps.agentId, resource);
        if (!own) {
          const others = deps.bindings.listByResource(resource).filter(b => !(b.holder.kind === 'agent' && b.holder.id === deps.agentId));
          if (others.length === 0) {
            return JSON.stringify({ status: 'error', error: `你并未负责 ${resource}，无需解除。` });
          }
          return JSON.stringify({
            status: 'error',
            error:
              `你不负责 ${resource}，它现在由 ${others.map(o => `${o.holder.kind}:${o.holder.id}(${o.scope})`).join(', ')} 负责。` +
              '解绑只能解自己的绑定；要接管请让对方释放，或请人执行转移。',
          });
        }

        const ok = deps.bindings.unbind(own.id);
        return JSON.stringify({
          status: ok ? 'released' : 'error',
          resource,
          releasedScope: own.scope,
          note: '既有任务与交付物不会被删除，只是不再自动接单。',
        });
      },
    },

    {
      name: 'resource_owners',
      description:
        'Read-only: who is currently responsible for a resource, and to what degree (scope) with what autonomy. ' +
        'Use this before binding to avoid taking over someone’s area by accident.',
      inputSchema: {
        type: 'object',
        properties: { resource: { type: 'string', description: '资源键' } },
        required: ['resource'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const resource = String(args['resource'] ?? '').trim();
        if (!resource) return JSON.stringify({ status: 'error', error: 'resource 必填' });
        const holders = deps.bindings.listByResource(resource);
        return JSON.stringify({
          status: 'success',
          resource,
          owners: holders.map(b => ({
            holder: `${b.holder.kind}:${b.holder.id}`,
            scope: b.scope,
            autonomy: b.autonomy,
            grantedBy: `${b.grantedBy.kind}:${b.grantedBy.id}`,
            since: new Date(b.since).toISOString(),
          })),
          exclusiveScopeTaken: holders.some(b => b.scope === L3_SCOPE),
        });
      },
    },

    {
      name: 'resource_status',
      description:
        'Your self-awareness entry point: which resources are you responsible for, at what scope/autonomy, ' +
        'and what happened there recently. Call this at the start of a turn when you need to know ' +
        '"am I on the hook for anything?" — cheaper and more accurate than a heartbeat.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        const mine = [
          ...deps.bindings.listByHolder('agent', deps.agentId),
          ...(deps.teamId ? deps.bindings.listByHolder('team', deps.teamId) : []),
        ];
        if (mine.length === 0) {
          return JSON.stringify({
            status: 'success',
            count: 0,
            message: '你目前不负责任何外部资源。如果这个方向需要长期盯，用 resource_bind 声明。',
            bindings: [],
          });
        }
        return JSON.stringify({
          status: 'success',
          count: mine.length,
          bindings: mine.map(b => {
            const activity = deps.recentActivity?.(b.resource);
            return {
              resource: b.resource,
              scope: b.scope,
              autonomy: b.autonomy,
              since: new Date(b.since).toISOString(),
              recent: activity ?? null,
              recentUnknown: activity === undefined,
            };
          }),
        });
      },
    },
  ];
}
