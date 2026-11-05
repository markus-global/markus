/**
 * in-band 结构标记登记表（L0 · 单一事实源）。
 *
 * ── 为什么需要这张表 ────────────────────────────────────────────────
 * `payload.extra` 是自由字典，但其中有一类**布尔开关**会凭「存在即改变行为」
 * 的方式决定调度：`triggerExecution` 让一条 `task_status_update` 变成「正式任务执行」，
 * `actionRequired` 让需求/工作流更新变成「唤醒 agent 去干活」，
 * `directMention` 让一条 a2a 消息成为「必须单独处理、不可折叠/不可 defer 的待办」。
 *
 * 这类标记此前是**纯约定**：写者随手加一个布尔键，读者随手 `extra?.xxx` 判一下。
 * 后果有两个，都是静默的：
 *  1. 新增标记没人登记 → 现有读侧不认识它 → 真正该改变的行为没改变（fail-open）；
 *  2. 同一个标记被多处各判一遍（truthy / `=== true` 混用）→ 一个契约两处实现，
 *     某处漏改就出现「写侧当唤醒、读侧当流水」的分裂。
 *
 * 唤醒型投递已用 `WAKEUP_EVENTS` + `assertWakeupDedupable()` 收敛了「必须可去重」；
 * 本表是同一模式的下一层：**「in-band 布尔标记必须登记」**，写侧与读侧都 fail-closed。
 *
 * ── 契约（别绕过）────────────────────────────────────────────────────
 * - 登记项三件套：`key`（extra 的键名）/ `meaning`（语义）/ `read`（唯一判定谓词）/
 *   `writers`（唯一投递方，逐处列文件）。
 * - **任何** 写进 `extra` 的布尔值键都必须是本表登记项（写侧 `assertInBandMarkersDeclared`
 *   拒绝未登记项，而不是静默放行）。非布尔键（字符串/数组/对象/数字）是**数据**，
 *   不在本表管辖范围 —— 「标记」的定义就是「靠布尔存在性改变行为的键」。
 * - 读侧**不得**自己比较 `extra[xxx]`，必须调 `isInBandMarkerSet(item, name)`；
 *   这样「判定逻辑」只有一个实现（`readBooleanMarker`），改语义改一处。
 * - 新增标记的完整动作：① 本表加登记项（含语义与写者）；② 写者改用登记的写法；
 *   ③ 读侧改调谓词。漏任何一步都会被本表 + 测试拦住。
 *
 * 与 `WAKEUP_EVENTS` 的关系：不是第二套唤醒去重（那已收敛），而是它的前置门禁 ——
 * `actionRequired` 是唤醒型的 in-band 标记，本表登记它，唤醒去重逻辑再消费它。
 */

/** 读取侧最小组件形状：给 `payload.extra`（item）或直接给载荷本身，两种都接受。 */
export interface InBandMarkerCarrier {
  readonly payload?: { readonly extra?: Record<string, unknown> } | undefined;
  /** 直接传载荷（如 `WakeupPayloadLike`）时用这个字段。 */
  readonly extra?: Record<string, unknown> | undefined;
}

/**
 * 标记种类：
 * - `marker`：**行为标记** —— 存在即改变调度/唤醒/折叠行为，读侧必须走谓词；
 * - `flag`：**载荷标记** —— 只是随消息携带的布尔数据位（如「本条是否流式」），
 *   不改变调度，但同样必须登记，否则「新增行为标记」可以伪装成 flag 悄悄溜过。
 */
export type InBandMarkerKind = 'marker' | 'flag';

export interface InBandMarkerSpec {
  /** `payload.extra` 的键名。 */
  readonly key: string;
  readonly kind: InBandMarkerKind;
  /** 语义：这个标记为真时，投递/消费的哪一条行为被打开。 */
  readonly meaning: string;
  /**
   * **唯一判定谓词**。读侧只能调它（或经 `isInBandMarkerSet`），不得自己比较字面量。
   * 全部实现收敛到 `readBooleanMarker()`：判定口径 = `extra[key] === true`。
   */
  readonly read: (item: InBandMarkerCarrier) => boolean;
  /**
   * **唯一投递方（写者）**：允许写这个键的文件路径（相对仓库根）。
   * 新增写者必须先改本表 —— `packages/shared/test/in-band-markers.test.ts`
   * 与 `packages/core/test/in-band-markers.test.ts` 的静态扫描会咬住不在清单里的写者。
   */
  readonly writers: readonly string[];
}

/**
 * 「标记是否置真」的**唯一实现**。
 *
 * 严格 `=== true`：历史实现 truthy / `=== true` 混用，`actionRequired: 'yes'` 这种
 * 脏值会让「投递方」和「消费方」得出不同结论。写侧现在会拒绝非布尔值，
 * 读侧再以严格相等收口，两侧口径就只有一个。
 */
function extraOf(item: InBandMarkerCarrier): Record<string, unknown> | undefined {
  return item.payload?.extra ?? item.extra;
}

function readBooleanMarker(item: InBandMarkerCarrier, key: string): boolean {
  return extraOf(item)?.[key] === true;
}

/**
 * 登记表。**新增 in-band 标记 = 先加到这里。**
 *
 * 未登记的名字 / 未登记的布尔键会被写侧与读侧**拒绝**（fail-closed），不是静默放行。
 */
export const IN_BAND_MARKERS = {
  // ── 行为标记（marker）───────────────────────────────────────────────
  /**
   * 唤醒型载荷：这条投递是「请你去做一件事」，不是流水账。
   * 消费侧据此走正式执行路径（requirement_action / workflow_action），
   * 折叠/合并/defer/drop 任意一个都会静默丢掉一个待办动作。
   * 与 `extra.event` + `WAKEUP_EVENTS` 联动：唤醒型必须可去重。
   */
  actionRequired: {
    key: 'actionRequired',
    kind: 'marker',
    meaning:
      '唤醒型载荷：投递方在要求 agent 执行动作（非流水账）。读侧据此走正式执行路径、'
      + '拒绝折叠/合并/defer/drop，并要求可去重（WAKEUP_EVENTS）。',
    read: item => readBooleanMarker(item, 'actionRequired'),
    writers: [
      'packages/org-manager/src/requirement-service.ts',
      'packages/org-manager/src/workflow-runner.ts',
    ],
  },
  /**
   * 正式任务执行指令：这条 `task_status_update` 要求 agent 真的跑一次任务。
   * `isStrictStateItem()` / `isTaskExecutionItem()` 的唯一判据；
   * 缺它 → 收到的是纯状态流水（不唤醒 LLM）。
   */
  triggerExecution: {
    key: 'triggerExecution',
    kind: 'marker',
    meaning:
      '正式任务执行指令：该 task_status_update 必须走 executeTask 全路径（不是纯状态流水）。'
      + '严格的 state item，绝不可折叠、合并、defer、drop 或 inline 完成。',
    read: item => readBooleanMarker(item, 'triggerExecution'),
    writers: [
      'packages/core/src/agent.ts',
    ],
  },
  /**
   * 点名投递：这条 a2a 消息 @ 了收件人本人，属于「直接找我」的待办，
   * 不允许被批量分拣 inline 完成 / defer / drop。
   */
  directMention: {
    key: 'directMention',
    kind: 'marker',
    meaning:
      '点名投递：该消息直接 @ 收件人本人（不是群发旁听）。读侧据此把它当受保护待办 —— '
      + '不可 inline 完成、不可 defer/drop、不可被心跳折叠吞掉。',
    read: item => readBooleanMarker(item, 'directMention'),
    writers: [
      'packages/org-manager/src/agent-delivery.ts',
      'packages/core/src/agent.ts',
    ],
  },

  // ── 载荷标记（flag，纯数据位；同样必须登记才能写）─────────────────────
  /** 该轮需要等待对端回复（A2A 同步式问答的选项位，不是调度开关）。 */
  waitForReply: {
    key: 'waitForReply',
    kind: 'flag',
    meaning: '载荷选项：发起方是否等待本次对话的回复（A2A 同步问答）。不改变调度行为。',
    read: item => readBooleanMarker(item, 'waitForReply'),
    writers: [
      'packages/core/src/agent.ts',
      'packages/org-manager/src/agent-delivery.ts',
    ],
  },
  /** 该条是流式对话（`sendMessageStream`），读侧按流式路径处理。 */
  stream: {
    key: 'stream',
    kind: 'flag',
    meaning: '载荷选项：本条是流式对话请求（sendMessageStream），消费侧据此走流式路径。',
    read: item => readBooleanMarker(item, 'stream'),
    writers: [
      'packages/core/src/agent.ts',
    ],
  },
  /** 该条投递被限流（仅提示位；消息照常入队、照常消费）。 */
  throttled: {
    key: 'throttled',
    kind: 'flag',
    meaning: '载荷提示：本条 A2A 投递命中限流窗口（仅提示，消息照常入队与消费）。',
    read: item => readBooleanMarker(item, 'throttled'),
    writers: [
      'packages/org-manager/src/agent-delivery.ts',
    ],
  },
} as const satisfies Record<string, InBandMarkerSpec>;

/** 登记名（键名即标记名）。 */
export type InBandMarkerName = keyof typeof IN_BAND_MARKERS;

/** 所有已登记标记名（错误信息与测试用）。 */
export function registeredInBandMarkers(): InBandMarkerName[] {
  return Object.keys(IN_BAND_MARKERS) as InBandMarkerName[];
}

/**
 * in-band 标记违规：未登记的标记 / 未登记名的读取 / 非布尔值。
 *
 * 刻意做成 fail-closed 的**显式错误**（不是 throw 一个裸 Error，也不能静默）：
 * 错误消息必须告诉调用方「该去哪儿登记、登记什么」，否则下一个人只会把它 catch 掉。
 */
export class UnregisteredInBandMarkerError extends Error {
  readonly origin: 'write' | 'read';
  readonly marker: string;

  constructor(origin: 'write' | 'read', marker: string, detail: string) {
    super(
      `Refusing ${origin === 'write' ? 'to deliver' : 'to interpret'} a payload with an unregistered in-band marker `
      + `\`extra.${marker}\` (${detail}). `
      + `Registered markers: [${registeredInBandMarkers().join(', ')}]. `
      + `Register it in packages/shared/src/types/in-band-markers.ts (IN_BAND_MARKERS) `
      + `with: meaning + the single read predicate + the single writer file. `
      + `In-band markers are boolean keys of payload.extra that change scheduling by their mere presence; `
      + `non-boolean extra keys are data and need no registration.`,
    );
    this.name = 'UnregisteredInBandMarkerError';
    this.origin = origin;
    this.marker = marker;
  }
}

/** 取登记项；名字未登记 → 拒绝（读侧也不许「猜」）。 */
function specOf(name: string): InBandMarkerSpec {
  const spec = (IN_BAND_MARKERS as Record<string, InBandMarkerSpec>)[name];
  if (!spec) throw new UnregisteredInBandMarkerError('read', name, 'this name is not in the registry');
  return spec;
}

/**
 * 读侧的**唯一**入口：这个 item 上的这个标记是否置真。
 *
 * - 名字未登记 → 抛 `UnregisteredInBandMarkerError`（读侧拒绝，不静默返回 false）；
 * - 判定口径固定为 `extra[key] === true`（由表内 `read` 提供，别处不得再写一份）。
 */
export function isInBandMarkerSet(item: InBandMarkerCarrier, name: InBandMarkerName): boolean {
  return specOf(name).read(item);
}

/**
 * SQL 读侧（持久层）用的 JSON 路径，**从登记表派生**。
 *
 * 持久层无法调用 TS 谓词（见 sqlite-storage 里 strict-state 分流的注释：
 * 用 SQL 复制 payload 分支会双源分叉）。这里只派生「键名 → JSON 路径」这一点，
 * 让 SQL 里不再出现手写的标记字面量 —— 改键名只需改登记表。
 */
export function inBandMarkerJsonPath(name: InBandMarkerName): string {
  return `$.extra.${specOf(name).key}`;
}

/**
 * 扫出 `extra` 里**未登记的布尔键**（诊断 / 测试 / 错误消息用）。
 *
 * 只把「值是布尔」的键当标记：字符串、数字、数组、对象都是数据。
 * `undefined` 视为「未设置」（`JSON.stringify` 也会丢掉它），不算违规。
 */
export function unregisteredInBandMarkerKeys(extra: Record<string, unknown> | undefined): string[] {
  if (!extra) return [];
  const registered: Record<string, InBandMarkerSpec> = IN_BAND_MARKERS;
  return Object.keys(extra).filter(key => {
    const value = extra[key];
    if (typeof value !== 'boolean') return false;
    return !registered[key];
  });
}

/**
 * 写侧/读侧的**唯一执行点**：载荷里的布尔标记必须全部登记过。
 *
 * `origin` 只影响错误措辞（写侧=拒绝投递 / 读侧=拒绝解释），判据完全一致。
 *
 * 为什么对「已登记但值非布尔」也拒绝：`actionRequired: 'yes'` 这类脏值会让
 * 写侧（truthy）与读侧（`=== true`）得出相反结论 —— 那就是「一个契约两处实现」的
 * 最坏形态，宁可当场报错，也不接受一个含义不明的开关。
 */
export function assertInBandMarkersDeclared(
  item: InBandMarkerCarrier,
  origin: 'write' | 'read',
): void {
  const extra = extraOf(item);
  if (!extra) return;

  const unregistered = unregisteredInBandMarkerKeys(extra);
  if (unregistered.length > 0) {
    throw new UnregisteredInBandMarkerError(
      origin,
      unregistered[0]!,
      unregistered.length > 1 ? `and ${unregistered.length - 1} more unregistered boolean key(s)` : 'not registered',
    );
  }

  const registered: Record<string, InBandMarkerSpec> = IN_BAND_MARKERS;
  for (const key of Object.keys(extra)) {
    const spec = registered[key];
    if (!spec) continue;
    const value = extra[key];
    if (value === undefined || typeof value === 'boolean') continue;
    throw new UnregisteredInBandMarkerError(
      origin,
      key,
      `registered marker \`${key}\` (${spec.kind}) must be a boolean or undefined, got ${typeof value}`,
    );
  }
}
