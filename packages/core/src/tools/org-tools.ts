/**
 * 组织查询工具面（C10-D）：`org_info` / `org_list` / `org_usage`。
 *
 * 判据：Agent 看不到日志，只能靠返回值建模。所以：
 *   - 组织身份是一个**有名字的状态**（`hosted` | `local-only`），不是一个名字字段；
 *   - 余额查不到时给出**有名字的原因**（`not_connected` / `hub_unreachable` /
 *     `hub_rejected`），而不是一个空对象或静默 0 ——「0 积分」和「不知道」必须可区分；
 *   - 每个分支都带可行动提示（下一步该做什么）。
 *
 * 这里只做**表面语义**（怎么读、怎么呈现）；组织身份的唯一写者是 storage 的
 * `SqliteOrgRepo.bindHubOrg`，余额的唯一计算点是 hub 的 `helpers/org-usage`。
 * core 不依赖 storage / 网络：端口是结构化接口，接线在 agent-manager + api-server。
 */
import type { AgentToolHandler } from '../agent.js';

/** 一个本地组织的身份视图（storage 行的结构化投影，不引入 storage 依赖）。 */
export interface OrgIdentityView {
  id: string;
  name: string;
  /** 地址段（`<local>.<org>@markus.global` 的 `<org>`）。总是合法的。 */
  orgSlug: string | null;
  /** hub 侧组织 id；null = 从未连接 hub。 */
  hubOrgId: string | null;
  plan: string;
  /** 最近一次对齐全成功的时间；null = 从未对齐。 */
  hubSyncedAt: string | null;
  /** 已绑定的邮箱地址数（让人判断这个组织「有没有在用」）。 */
  addressCount: number;
}

/** 配额视图 —— 数值全部来自 hub 的单一实现（不在这里重算）。 */
export interface OrgUsageView {
  orgSlug: string | null;
  plan: string;
  remainingCu: number;
  monthlyQuotaCu: number;
  purchasedCu: number;
  bonusCu: number;
  cuUsed: number;
  /** hub 侧的读取时刻（不是本地缓存时间）。 */
  syncedAt: string;
}

/** 余额查询的结局：成功带数，失败带**有名字的原因**与下一步。 */
export type OrgUsageOutcome =
  | { ok: true; usage: OrgUsageView }
  | {
      ok: false;
      reason: 'not_connected' | 'hub_unreachable' | 'hub_rejected' | 'org_not_found';
      hint: string;
    };

/** 组织查询端口。缺省（未接线）⇒ 工具不注册，而不是注册必然失败的桩。 */
export interface OrgQueryPort {
  info(input: { orgId: string }): OrgIdentityView | null;
  list(): OrgIdentityView[];
  usage(input: { orgId: string }): Promise<OrgUsageOutcome>;
}

export interface OrgToolContext extends OrgQueryPort {
  agentId: string;
  orgId: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 一个组织「在世界上的位置」——三段式，避免调用方自己拼字符串判断。 */
function identityOf(org: OrgIdentityView): {
  hosting: 'hosted' | 'local-only';
  address: string | null;
  note: string;
} {
  const hosted = Boolean(org.hubOrgId);
  const address = org.orgSlug ? `<local>.${org.orgSlug}@markus.global` : null;
  return {
    hosting: hosted ? 'hosted' : 'local-only',
    address,
    note: hosted
      ? 'This org is linked to a markus.global org; its slug is authoritative there.'
      : 'Not linked to a markus.global org yet. The slug above is a local placeholder (<local> is up to you). Sign in with a Hub account to claim the Hub org identity.',
  };
}

export function createOrgTools(ctx: OrgToolContext): AgentToolHandler[] {
  return [
    {
      name: 'org_info',
      description:
        'Read this organisation\'s identity: local id, display name, address slug, whether it is linked ' +
        'to a markus.global org (hosting: "hosted" | "local-only"), and how many mailbox addresses are bound. ' +
        'Use it before telling anyone an address — a "local-only" slug is a placeholder that the Hub does not know.',
      inputSchema: {
        type: 'object',
        properties: {
          org_id: {
            type: 'string',
            description: 'Optional org id. Defaults to the org you are running in.',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const wanted = typeof args['org_id'] === 'string' ? (args['org_id'] as string) : ctx.orgId;
        const org = ctx.info({ orgId: wanted });
        if (!org) {
          return json({
            status: 'not_found',
            org_id: wanted,
            hint: `No local organisation "${wanted}". Call org_list to see the orgs on this instance.`,
          });
        }
        return json({ status: 'ok', org, ...identityOf(org) });
      },
    },
    {
      name: 'org_list',
      description:
        'List every organisation on this instance with its address slug, hosting state ' +
        '("hosted" = linked to markus.global, "local-only" = placeholder slug) and bound address count. ' +
        'A self-hosted instance normally has exactly one.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        const orgs = ctx.list();
        return json({
          status: 'ok',
          count: orgs.length,
          orgs: orgs.map((o) => ({ ...o, ...identityOf(o) })),
        });
      },
    },
    {
      name: 'org_usage',
      description:
        'Read this org\'s compute-credit balance from markus.global: remaining / monthly quota / purchased / ' +
        'bonus / used CU, plus the reading time. Returns {ok:true,usage} or {ok:false,reason,hint} where reason ' +
        'is "not_connected" | "hub_unreachable" | "hub_rejected" | "org_not_found". Never assumes zero: ' +
        '"unknown balance" and "zero balance" are different answers.',
      inputSchema: {
        type: 'object',
        properties: {
          org_id: {
            type: 'string',
            description: 'Optional org id. Defaults to the org you are running in.',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const wanted = typeof args['org_id'] === 'string' ? (args['org_id'] as string) : ctx.orgId;
        const outcome = await ctx.usage({ orgId: wanted });
        return json(
          outcome.ok
            ? { status: 'ok', usage: outcome.usage }
            : { status: 'unavailable', reason: outcome.reason, hint: outcome.hint },
        );
      },
    },
  ];
}
