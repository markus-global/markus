/**
 * 邮箱地址自助工具面（第六刀 C1 / 执行文档 §2.4）。
 *
 * 判据：Agent 看不到日志，只能靠返回值建模。所以：
 *   - 「没绑上」不是 `false`，而是 `{status:'bounced', reason, detail, hint}`；
 *   - 「被别人占了」是 `{status:'conflict'}`，不是抛异常；
 *   - 「不是你的」是 `{status:'forbidden'}`（I5 的正面回答）。
 * 每个分支都带可行动提示（下一步该做什么），而不只是拒绝的原因。
 *
 * 这里只做**表面语义**（谁能绑谁、target_ref 怎么解释）；唯一性与解析在
 * storage 的 `SqliteAddressBindingRepo`（唯一写者 / 唯一解析器）。core 不依赖
 * storage：端口是结构化接口，接线在 agent-manager + cli。
 */
import type { AgentToolHandler } from '../agent.js';
import type { AddressBindOutcome, AddressRevokeOutcome } from '@markus/shared';

/** 一条地址绑定（storage 视图的结构化投影；不引入 storage 依赖）。 */
export interface AddressBindingRecord {
  address: string;
  targetRef: string;
  revokedAt: string | null;
  createdAt: string;
}

/** 地址绑定端口。缺省（未接线）⇒ 工具不注册，而不是注册一堆必然失败的桩。 */
export interface AddressBindingPort {
  bind(input: { orgId: string; agentId: string; address: string }): AddressBindOutcome;
  revoke(input: { orgId: string; agentId: string; address: string }): AddressRevokeOutcome;
  list(input: { orgId: string; agentId: string; includeOrg?: boolean }): AddressBindingRecord[];
}

export interface AddressToolContext extends AddressBindingPort {
  agentId: string;
  orgId: string;
}

/** `target_ref` 的唯一解释点：只接受 `agent:<自己>`，其余一律拒绝（I5）。 */
export function parseTargetRef(
  raw: string,
  selfAgentId: string,
): { ok: true } | { ok: false; hint: string } {
  const expected = `agent:${selfAgentId}`;
  if (raw === expected || raw === selfAgentId) return { ok: true };
  return {
    ok: false,
    hint:
      `Only your own target may be bound: pass "${expected}" or omit target_ref. ` +
      `Rebinding another agent's address is not allowed (I5) — ask that agent to revoke it first.`,
  };
}

export function createAddressTools(ctx: AddressToolContext): AgentToolHandler[] {
  return [
    {
      name: 'bind_address',
      description:
        'Claim a mailbox address of yours: <local>.<org>@markus.global (exactly one dot, lowercase ASCII, ' +
        'no +tag, no reserved words). Returns {status:"bound"|"bounced"|"conflict"|"forbidden"} — read ' +
        '`reason`/`detail`/`hint` to decide the next step. You can only bind your own target ' +
        '(target_ref defaults to you). A re-bind by the owner is a no-op, not an error.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Full address, e.g. "cto.markus@markus.global".' },
          target_ref: {
            type: 'string',
            description: 'Optional target of the binding. Defaults to you; only "agent:<your id>" is accepted.',
          },
        },
        required: ['address'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const address = args['address'];
        if (typeof address !== 'string' || address.trim().length === 0) {
          return JSON.stringify({
            status: 'bounced',
            address: String(address ?? ''),
            reason: 'unresolved_address',
            detail: 'malformed',
            hint: 'Pass the full address, e.g. "cto.markus@markus.global".',
            catchAllId: null,
          });
        }
        const rawTarget = args['target_ref'];
        if (typeof rawTarget === 'string' && rawTarget.trim().length > 0) {
          const check = parseTargetRef(rawTarget.trim(), ctx.agentId);
          if (!check.ok) {
            return JSON.stringify({ status: 'forbidden', address, hint: check.hint });
          }
        }
        return JSON.stringify(ctx.bind({ orgId: ctx.orgId, agentId: ctx.agentId, address }));
      },
    },

    {
      name: 'address_revoke',
      description:
        'Release one of YOUR active mailbox addresses (sets revoked_at; the row is kept for audit and the ' +
        'address becomes claimable again). Returns {status:"revoked"|"forbidden"|"not_bound"|"bounced"} — ' +
        '"forbidden" means the address is bound to someone else (I5).',
      inputSchema: {
        type: 'object',
        properties: { address: { type: 'string', description: 'The address you want to release.' } },
        required: ['address'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const address = args['address'];
        if (typeof address !== 'string' || address.trim().length === 0) {
          return JSON.stringify({
            status: 'bounced',
            address: String(address ?? ''),
            reason: 'unresolved_address',
            detail: 'malformed',
            hint: 'Pass the address to release, e.g. "cto.markus@markus.global".',
            catchAllId: null,
          });
        }
        return JSON.stringify(ctx.revoke({ orgId: ctx.orgId, agentId: ctx.agentId, address }));
      },
    },

    {
      name: 'address_list',
      description:
        'List mailbox bindings you can see: your own (active + revoked, with status) and optionally the ' +
        "org's active bindings (include_org:true). Read-only; use it before bind_address to avoid a conflict.",
      inputSchema: {
        type: 'object',
        properties: {
          include_org: { type: 'boolean', description: 'Also list active bindings held by others in your org.' },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const includeOrg = args['include_org'] === true;
        const rows = ctx.list({ orgId: ctx.orgId, agentId: ctx.agentId, includeOrg });
        return JSON.stringify({
          status: 'ok',
          count: rows.length,
          bindings: rows.map((r) => ({
            address: r.address,
            targetRef: r.targetRef,
            status: r.revokedAt ? 'revoked' : 'active',
            revokedAt: r.revokedAt,
            createdAt: r.createdAt,
          })),
        });
      },
    },
  ];
}
