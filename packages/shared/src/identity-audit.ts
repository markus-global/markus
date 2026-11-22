/**
 * C10-0B §3.4 —— 身份不变量门禁的**唯一**定义（纯数据 + SQL 字符串）。
 *
 * 为什么住在这里，而不是继续留在 `scripts/identity-audit.mjs` 里：
 *
 *   1. **一个事实一个写者**。判据此前有三份消费者（CI 自检 / 运维真库跑 / 新增的
 *      每日审计），却只有一份定义写在脚本里。每日审计要跑同样的判据时，唯一
 *      不产生第二套语义的做法是让定义成为**模块**，三处 import 同一份。
 *   2. **纪元是产品常量，不是部署参数**。旧脚本用滚动窗口
 *      `MARKUS_AUDIT_SINCE = now - 7d`：同一行历史数据今天算违规、明天不算，
 *      同一件事于是有两个度量（R2）。固定纪元说的是实话——「这件事从这一刻起
 *      才算数」，且每个实例读到同一个值（绝不读实例重启时间）。
 *   3. **谓词白名单从代码派生**。旧脚本用正则去读 `facts/predicates.ts` 的源码
 *      字面量，那是「同一份知识的第二个读者」：代码改个写法，解析就静默失效。
 *      这里直接用 `FACT_PREDICATES`。
 *
 * ⚠️ 本模块**不 import `node:sqlite`**：它只产出 SQL 字符串。执行归调用方
 * （脚本用 CLI 的 `DatabaseSync`，每日审计用只读连接）。把执行也放进来，这个
 * 模块就再也不能被 web-ui / 无 Node 内置 sqlite 的运行时安全导入。
 */
import { FACT_PREDICATES } from './facts/predicates.js';

/**
 * 身份修复的**产品纪元**（决策台账 / 邮箱行从这一刻起必须带身份）。
 *
 * 语义：纪元之前的行是**档案**，不是违规；纪元之后缺身份才是缺陷。
 * 因此它是常量，不是 `now()`、不是实例重启时间、不是滚动窗口 ——
 * 三个实例读到不同下界，就等于没有下界。
 *
 * ── 哨兵期（CTO 裁决 A，2026-11-21；卡面结构解第 4 条）─────────────────────
 * `null` = **纪元未定值**。修复构建上线（Owner 执行重启）之前，不存在正确的
 * 纪元值：任何预置的「计划时刻」都是赌重启准时，赌输了就把旧构建仍在漏的行
 * 算成纪元后违规（永远红），或把新构建的干净行漏掉（假绿）。
 *
 * 定值协议（处置决议记录 docs/records/identity-backlog-disposition-2026-11-22.md
 * 是唯一权威出处）：
 *   1. 纪元**定义为**「修复构建的新进程启动时刻」，唯一读数 = `ps -o lstart`
 *      （或 runtime 日志首行，二者只取其一）——定义与读数必须同源。
 *   2. 定值 commit 同时做三件事：把本常量从 null 改成该时刻、在处置决议记录
 *      写下来源命令 + 原始输出 + 时刻、更新测试期望。一次成型，不留第二写者。
 *   3. 哨兵期间审计必须输出独立的 `epoch-unset` 状态（非零退出 / 告警），
 *      **绝不静默绿**。`identity-audit-epoch.test.ts` 咬住这条：往常量里塞一个
 *      不在处置决议记录里的时刻（预置计划时刻变异）必须红。
 */
export const IDENTITY_FIX_EPOCH: string | null = null;

/**
 * 审计的三态（CTO 补口④）：「已定值且通过」「未定值（哨兵期）」「失败」必须可区分。
 * 只要未定值仍落在「通过」这一态里，「绝不静默绿」就只是措辞。
 * `error` 是仪器自身故障（库打不开等）——同样不是绿。
 */
export type IdentityAuditState = 'pass' | 'fail' | 'epoch-unset' | 'error';

/**
 * 解析本次审计使用的纪元：显式注入优先（自检夹具 / 测试），否则读产品常量。
 * **绝不**用 `Date.now()` 兜底 —— 兜底就是「每台机器一个下界」的第二写者。
 * 返回 null = 哨兵期，调用方必须走 `epoch-unset` 状态，不得建门禁假装通过。
 */
export function resolveIdentityFixEpoch(injected?: string | null): string | null {
  return injected !== undefined ? injected : IDENTITY_FIX_EPOCH;
}

/**
 * 本质上**没有实体**的事实类型（回执 / 平台唤醒信号）。
 *
 * 它们带 NULL ref 是正确语义，不是「忘了传」：平台唤醒不是关于工作的决策，
 * 也没有回合身份可以挂在上面。C10-0B §3.3 让唯一决策写者对这些来源**不落账**，
 * 所以它们既不进决策台账、也不该被门禁 1 计数。
 *
 * 名单只有这一份：`core/src/mailbox.ts` 用它构造入队守卫的豁免集，
 * 门禁 SQL 用它构造 `NOT IN (...)`。两份名单 = 同一个事实两个写者。
 */
export const PLATFORM_INTERNAL_SOURCE_TYPES: readonly string[] = [
  'heartbeat',
  'system_event',
  'session_reply',
  'memory_consolidation',
  'callback_result',
  'workflow_update',
];

export interface IdentityGate {
  /** 稳定编号（告警里认的是它，不是名字）。 */
  id: number;
  name: string;
  sql: string;
  /**
   * 该门禁依赖的列（晚到的迁移）。列不存在时调用方跳过，而不是永远红 ——
   * 「门禁读不到它要审的东西」不该表现成「库很脏」。
   */
  requiresColumn?: { table: string; column: string };
}

export interface IdentityGateOptions {
  /**
   * 下界（默认 {@link IDENTITY_FIX_EPOCH}）。调用方可注入以便两向自检。
   * `null` = 哨兵期：**抛错**而不是建一份没有下界的门禁 —— 调用方必须先走
   * `epoch-unset` 状态（fail closed，不许静默放行历史行）。
   */
  epoch?: string | null;
  /** 谓词闭集（默认 {@link FACT_PREDICATES}）；非法取值会在 SQL 里被计数。 */
  predicates?: readonly string[];
}

/** SQL 字面量转义：名单来自代码常量，仍然只允许「安全字符」，非法即抛。 */
function sqlLiteralList(values: readonly string[], what: string): string {
  if (values.length === 0) {
    throw new Error(`identity-audit：${what} 为空 —— 门禁不能默认放行。`);
  }
  return values
    .map(v => {
      if (!/^[A-Za-z0-9_.:-]+$/.test(v)) {
        throw new Error(`identity-audit：${what} 含非法取值 ${JSON.stringify(v)}。`);
      }
      return `'${v}'`;
    })
    .join(',');
}

/**
 * 门禁清单。
 *
 * 分组口径：
 *   · 纪元下界的「缺失型」判据（1 / 2 / 5 / 11）：只看修复纪元之后的事实。
 *     它们问的是「现在的写者是否还在漏」，历史行答不了这个问题。
 *   · 当前状态型判据（3 / 6–10 / 12 / 13）：问的是**此刻**的不变量
 *     （僵尸在跑、事实没来源、同一结论两个当前值……）。它们不需要下界：
 *     一条 2025 年的 `running` 挂了租约同样是僵尸。
 */
export function makeIdentityGates(options: IdentityGateOptions = {}): IdentityGate[] {
  const epoch = resolveIdentityFixEpoch(options.epoch);
  if (epoch === null) {
    throw new Error(
      'identity-audit：纪元未定值（哨兵期）——审计必须输出 epoch-unset 状态，不得建门禁假装通过。',
    );
  }
  if (Number.isNaN(Date.parse(epoch))) {
    throw new Error(`identity-audit：纪元不是可解析的时间 ${JSON.stringify(epoch)}。`);
  }
  const predicates = options.predicates ?? FACT_PREDICATES.map(p => p.predicate);
  const predicateList = sqlLiteralList(predicates, '谓词闭集');
  const internalList = sqlLiteralList(PLATFORM_INTERNAL_SOURCE_TYPES, '平台内部来源闭集');

  return [
    {
      id: 1,
      name: '身份缺失（非平台内部事实没有 work_unit_ref）',
      sql: `SELECT COUNT(*) AS c FROM mailbox_items
             WHERE work_unit_ref IS NULL AND queued_at >= '${epoch}'
               AND source_type NOT IN (${internalList})`,
    },
    {
      id: 2,
      name: '悬空引用（ref 指向不存在的 work_unit）',
      sql: `SELECT COUNT(*) AS c FROM mailbox_items m
              LEFT JOIN work_units w ON w.ref = m.work_unit_ref
             WHERE m.work_unit_ref IS NOT NULL AND w.id IS NULL
               AND m.queued_at >= '${epoch}'`,
    },
    {
      id: 3,
      name: '租约已过期的 running（僵尸在跑）',
      sql: `SELECT COUNT(*) AS c FROM work_units
             WHERE status = 'running' AND lease_until IS NOT NULL
               AND lease_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    },
    // ── 原判据 4（「触发行已终态但 ended_at 仍为空」）在 C9-B 删除 ──────────────
    // 它测的是一条**由扫库机制维持**的不变量：`agent_activities.ended_at` 必须补齐。
    // C9-B 删掉了那个机制（`closeOrphansAgainstTerminalMailbox`）：「在跑」只认
    // `work_units`，一行 activity 没有结束时间就是「没记到结束」，不是状态、也不是违规。
    {
      id: 5,
      name: '撤销型事实无身份（无法反查「谁撤销了哪一轮」）',
      sql: `SELECT COUNT(*) AS c FROM mailbox_items
             WHERE envelope LIKE '%"invalidatesPremise":true%'
               AND work_unit_ref IS NULL AND queued_at >= '${epoch}'`,
    },
    // ── C9-A：facts 层六条（方案 §8.3）───────────────────────────────────────────
    {
      id: 6,
      name: '事实无来源身份（work_unit_ref 缺失/空串）',
      sql: `SELECT COUNT(*) AS c FROM facts
             WHERE work_unit_ref IS NULL OR TRIM(work_unit_ref) = ''`,
    },
    {
      id: 7,
      name: '事实不可追溯（source_refs_json 为空或不是非空数组）',
      sql: `SELECT COUNT(*) AS c FROM facts
             WHERE source_refs_json IS NULL
                OR json_valid(source_refs_json) = 0
                OR json_array_length(source_refs_json) = 0`,
    },
    {
      id: 8,
      name: '自证通过（verified_by 与 asserted_by 同一人）',
      sql: `SELECT COUNT(*) AS c FROM facts
             WHERE json_valid(verification_json)
               AND json_extract(verification_json, '$.result') = 'pass'
               AND json_extract(verification_json, '$.verified_by') = asserted_by`,
    },
    {
      id: 9,
      name: '同一 subject+predicate 多条 active（结论有两个当前值）',
      sql: `SELECT COUNT(*) AS c FROM (
              SELECT subject_kind, subject_id, predicate, COUNT(*) AS n
                FROM facts WHERE superseded_by IS NULL
               GROUP BY 1, 2, 3 HAVING n > 1)`,
    },
    {
      id: 10,
      name: '谓词不在闭集内（白名单从代码派生）',
      sql: `SELECT COUNT(*) AS c FROM facts
             WHERE predicate NOT IN (${predicateList})`,
    },
    {
      id: 11,
      name: '新纪元决策行无身份（agent_decisions 有列却没写 work_unit_ref）',
      sql: `SELECT COUNT(*) AS c FROM agent_decisions
             WHERE created_at >= '${epoch}' AND work_unit_ref IS NULL`,
      requiresColumn: { table: 'agent_decisions', column: 'work_unit_ref' },
    },
    // ── C9-E：验证事实的两条（验证也是一种事实，但它必须可核）────────────────────
    {
      id: 12,
      name: '验证结论无证据（pass/fail 都没有 evidence_refs）',
      sql: `SELECT COUNT(*) AS c FROM facts
             WHERE json_valid(verification_json)
               AND json_extract(verification_json, '$.result') IN ('pass','fail')
               AND (json_extract(verification_json, '$.evidence_refs') IS NULL
                    OR json_array_length(json_extract(verification_json, '$.evidence_refs')) = 0)`,
    },
    {
      id: 13,
      name: '验证结论无作者（verified_by 缺失/空串）',
      sql: `SELECT COUNT(*) AS c FROM facts
             WHERE json_valid(verification_json)
               AND (json_extract(verification_json, '$.verified_by') IS NULL
                    OR TRIM(json_extract(verification_json, '$.verified_by')) = '')`,
    },
  ];
}
