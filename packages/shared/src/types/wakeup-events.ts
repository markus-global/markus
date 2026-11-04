/**
 * 唤醒型投递的事件登记表（L0 · 单一事实源）。
 *
 * ── 为什么需要这张表 ────────────────────────────────────────────────
 * `extra.actionRequired === true` 意味着「这条投递会唤醒 agent 去干活」。这类投递
 * **必须可去重**：同一个事实被重复求值时不能重复唤醒人/agent。
 *
 * 之前的实现是 fail-open：算不出幂等键 → 返回 undefined → 照常放行。于是「忘了声明
 * 结构」在生产里没有任何可观测差异，只在被重复触发时表现为噪音（2026-11-04 事故：
 * 257 条评论自激、审批通知重放、全部任务已终态反复催）。
 *
 * 更隐蔽的坑：只强制「必须带 event」是不够的——自由字符串可以被填成 `'whatever'`，
 * 键算得出来但语义错乱（两个不同事实共用一个键 = **误抑制**，比重复更危险）。
 * 因此 event 必须是**本表登记过的名字**，指纹取哪些字段也由本表规定，
 * 而不是由发射点临时决定。
 *
 * ── 契约 ────────────────────────────────────────────────────────────
 * - `entity`：先查 payload 顶层字段，再查 extra —— 这段事实是关于哪个实体的；
 * - `fingerprint`：只从 extra 取（结构化字段），组成「同一实体的哪个事实」；
 * - 键由 `wakeupDedupKey()` 统一计算，**不得在别处另写一份**。
 */

export interface WakeupEventSpec {
  /** 实体标识字段名按序尝试（payload 顶层优先，其次 extra）。 */
  readonly entity: readonly string[];
  /** 组成事实指纹的 extra 字段名。 */
  readonly fingerprint: readonly string[];
}

/**
 * 登记表。新增唤醒型投递 = 先在这里登记事件名与指纹字段，再在发射点使用该名字。
 * 未登记的名字会被投递层**拒绝**（fail-closed），而不是静默放行。
 */
export const WAKEUP_EVENTS: Readonly<Record<string, WakeupEventSpec>> = {
  // ── 需求域 ────────────────────────────────────────────────────────
  /** 需求下全部任务进入终态，创建者需要复核/收尾。 */
  all_tasks_terminal: { entity: ['requirementId'], fingerprint: ['factFingerprint'] },
  /** 需求审批决定（三种）。approved 用 approvedAt 作指纹 → 同一决定的重放被抑制。 */
  'decision:approved': { entity: ['requirementId'], fingerprint: ['factFingerprint'] },
  'decision:rejected': { entity: ['requirementId'], fingerprint: ['factFingerprint'] },
  'decision:changes_requested': { entity: ['requirementId'], fingerprint: ['factFingerprint'] },

  // ── 工作流域 ──────────────────────────────────────────────────────
  /** 步骤失败。reason 区分「输出契约不满足 / 执行失败 / 超时」= 不同事实。 */
  step_failed: { entity: ['taskId'], fingerprint: ['runId', 'reason', 'missing'] },
  /** 运行完成。同一 run 只通知一次。 */
  run_completed: { entity: ['runId'], fingerprint: ['runNumber'] },
  /** 运行失败。failedTaskId 区分是哪一步炸的。 */
  run_failed: { entity: ['runId'], fingerprint: ['failedTaskId', 'taskId'] },
} as const;

export type WakeupEventName = keyof typeof WAKEUP_EVENTS;

/** 唤醒投递的最小载荷形状（只声明本模块关心的字段）。 */
export interface WakeupPayloadLike {
  requirementId?: string;
  taskId?: string;
  extra?: Record<string, unknown>;
}

/**
 * 计算唤醒型投递的幂等键。**唯一实现**。
 *
 * 返回 `undefined` 表示「这条投递不可去重」，调用方必须视为违规（fail-closed）：
 * 缺 event、event 未登记、缺实体标识，都不会被猜出来。
 */
export function wakeupDedupKey(payload: WakeupPayloadLike): string | undefined {
  const extra = payload.extra;
  if (extra?.actionRequired !== true) return undefined;

  const event = typeof extra.event === 'string' ? extra.event : undefined;
  if (!event) return undefined;

  const spec = WAKEUP_EVENTS[event];
  if (!spec) return undefined;

  const entity = spec.entity
    .map(field => payload[field as keyof WakeupPayloadLike] ?? extra[field])
    .find(value => typeof value === 'string' && value.length > 0);
  if (!entity) return undefined;

  const fingerprint = spec.fingerprint
    .map(field => {
      const value = extra[field];
      if (value === undefined || value === null) return '';
      return Array.isArray(value) ? value.join(',') : String(value);
    })
    .join('|');

  return `wake:${event}:${String(entity)}:${fingerprint}`;
}
