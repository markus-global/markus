/**
 * Source 的准入判定：**什么算事件**。
 *
 * 设计原文（01 §4.6）：`Source` 是领域概念 —— 「定义什么算事件（含只在时间上成立的条件）、
 * 在进入领域之前丢掉**机器人自己的消息**与监听范围外的事件」。
 *
 * 为什么必须是一个纯函数而不是散在各入口里的 if：
 *  - 现在有三个入口（webhook 单条、批量拉取、未来任何新入口），规则一旦写两处，
 *    「机器人自己发的消息被当成新事件」这类自激循环就只会在这一个入口被堵住；
 *  - 规则是**数据**（`config.policy`），不是枚举、不是平台名分支 —— 加一个平台
 *    不需要动这里（H2 / §7.9），但改「什么算事件」也不需要改任何入口。
 *
 * 顺序即优先级，第一个拒绝胜出：`self → kind → scope → window`。
 * `self` 永远排第一：自激循环是唯一会自己放大自己的失效模式，不能排在任何过滤器后面。
 */
import type { NormalizedEvent } from './event-source.js';

/** 拒绝原因的可判定标签（不是文案；文案是 `reason`） */
export type AdmissionRule = 'self' | 'kind' | 'scope' | 'window';

export type Admission =
  | { admitted: true }
  | { admitted: false; rule: AdmissionRule; reason: string };

/** 来源自己的策略。全部可选；缺省 = 全收（除了拿不到身份时的自激保护，见 `self`）。 */
export interface SourcePolicy {
  /**
   * 机器人自己在本来源上的身份（平台账号 id）。
   *
   * 命中即丢弃：这是**唯一**能挡住「agent 发出去的消息又被当成新事件收回来」的地方
   * —— 那种循环不会报错，只会把账单和噪音一起指数放大。
   * 空/缺省 = 没配置身份。此时 `actorKind === 'bot'` 的事件**不**被无条件丢弃，
   * 因为通用信封默认 `actorKind: 'bot'`（见 `createGenericWebhookAdapter`），
   * 一刀切会把所有内部脚本事件都丢掉；所以按**身份**匹配，而不是按「是不是机器人」。
   */
  selfActorIds?: string[];

  /** 只接受这些事件类别（`TriggerKind`）。缺省/空 = 全收。 */
  acceptKinds?: string[];

  /** 监听范围：只接受 `ref` 以这些前缀开头的事件（如 `gh:owner/repo`）。缺省/空 = 全收。 */
  refPrefixes?: string[];

  /**
   * 只在时间窗内接受（设计原文「含只在时间上成立的条件」）。
   * `[fromMinute, toMinute)` 于 `utcOffsetMinutes` 时区每天生效；`to < from` 表示跨零点。
   */
  activeWindow?: { fromMinute: number; toMinute: number; utcOffsetMinutes?: number };
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string');

/**
 * 把 `event_sources.config.policy` 归一成 `SourcePolicy`。
 *
 * 只认类型正确的值：类型不对的字段被**忽略**（不是抛错）—— 读路径必须永远能跑。
 * 写入路径用 `validateSourcePolicy()` 把这类问题在登记时就说清楚，
 * 否则「配置写错 → 静默不生效」会变成最难查的一类故障。
 */
export function policyOf(config: Record<string, unknown> | null | undefined): SourcePolicy {
  const raw = (config?.['policy'] ?? {}) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') return {};
  const p: SourcePolicy = {};
  if (isStringArray(raw['selfActorIds'])) p.selfActorIds = raw['selfActorIds'];
  if (isStringArray(raw['acceptKinds'])) p.acceptKinds = raw['acceptKinds'];
  if (isStringArray(raw['refPrefixes'])) p.refPrefixes = raw['refPrefixes'];
  const w = raw['activeWindow'] as Record<string, unknown> | undefined;
  if (w && typeof w === 'object') {
    const from = Number(w['fromMinute']);
    const to = Number(w['toMinute']);
    const off = w['utcOffsetMinutes'] === undefined ? 0 : Number(w['utcOffsetMinutes']);
    if (Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(off)) {
      p.activeWindow = { fromMinute: from, toMinute: to, utcOffsetMinutes: off };
    }
  }
  return p;
}

/**
 * 登记来源时的校验：返回**人类可读的问题清单**，空数组 = 通过。
 *
 * 存在的理由：`policyOf()` 必须宽容（读路径不能崩），宽容的代价是「写错了不报」。
 * 所以写入路径必须有一次严格检查，把问题在登记那一刻说出来。
 */
export function validateSourcePolicy(config: Record<string, unknown> | null | undefined): string[] {
  const problems: string[] = [];
  const raw = config?.['policy'];
  if (raw === undefined) return problems;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['config.policy 必须是对象，例如 {"selfActorIds":["markus-bot"],"acceptKinds":["external"]}'];
  }
  const p = raw as Record<string, unknown>;
  for (const key of ['selfActorIds', 'acceptKinds', 'refPrefixes'] as const) {
    if (p[key] !== undefined && !isStringArray(p[key])) {
      problems.push(`config.policy.${key} 必须是字符串数组`);
    }
  }
  if (p['activeWindow'] !== undefined) {
    const w = p['activeWindow'];
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      problems.push('config.policy.activeWindow 必须是 {fromMinute,toMinute,utcOffsetMinutes?} 对象');
    } else {
      const aw = w as Record<string, unknown>;
      const from = Number(aw['fromMinute']);
      const to = Number(aw['toMinute']);
      if (!Number.isFinite(from) || from < 0 || from > 1439) problems.push('activeWindow.fromMinute 必须是 0..1439 的整数');
      if (!Number.isFinite(to) || to < 0 || to > 1440) problems.push('activeWindow.toMinute 必须是 0..1440 的整数');
    }
  }
  return problems;
}

/** 当前时刻在来源本地时区的「分钟数」 */
function minuteOfDay(now: number, offsetMinutes: number): number {
  const shifted = new Date(now + offsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function inWindow(now: number, win: NonNullable<SourcePolicy['activeWindow']>): boolean {
  const minute = minuteOfDay(now, win.utcOffsetMinutes ?? 0);
  const from = win.fromMinute;
  const to = win.toMinute;
  // from == to 视为全天（不用「空窗口」这种反直觉语义）
  if (from === to) return true;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/**
 * 准入判定。纯函数：同样的 `(ev, policy, now)` 永远同样的结论，无 IO、无随机。
 *
 * 返回的 `reason` 是给人看的一句话（面板/HTTP 响应直接展示），
 * `rule` 是可断言的标签（测试与 `health.lastFiltered` 用），两者不会再分叉。
 */
export function admitEvent(ev: NormalizedEvent, policy: SourcePolicy, now: number): Admission {
  // 1. 自激：机器人自己发的消息，进领域之前就丢掉
  const selfIds = policy.selfActorIds ?? [];
  if (ev.actorKind === 'bot' && selfIds.includes(ev.actorId)) {
    return {
      admitted: false,
      rule: 'self',
      reason: `自激丢弃：${ev.actorId} 是本源自己的机器人身份（agent 发出去的消息又被收回来会自我放大）`,
    };
  }

  // 2. 事件类别
  const kinds = policy.acceptKinds ?? [];
  if (kinds.length > 0 && !kinds.includes(ev.kind)) {
    return {
      admitted: false,
      rule: 'kind',
      reason: `不在监听类别内：kind=${ev.kind}，只接受 ${kinds.join('/')}`,
    };
  }

  // 3. 监听范围
  const scopes = policy.refPrefixes ?? [];
  if (scopes.length > 0 && !scopes.some(p => ev.ref.startsWith(p))) {
    return {
      admitted: false,
      rule: 'scope',
      reason: `不在监听范围内：ref=${ev.ref}，只接受前缀 ${scopes.join(' / ')}`,
    };
  }

  // 4. 时间条件
  if (policy.activeWindow && !inWindow(now, policy.activeWindow)) {
    const { fromMinute, toMinute } = policy.activeWindow;
    return {
      admitted: false,
      rule: 'window',
      reason: `不在活动时间窗内：当前不在 [${fromMinute}, ${toMinute})（来源本来就不该在这个时段接事件）`,
    };
  }

  return { admitted: true };
}
