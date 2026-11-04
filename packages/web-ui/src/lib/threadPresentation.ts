/**
 * Thread / stage / 路由决定的**唯一展示层实现**。
 *
 * 为什么必须收敛到一个文件：
 * 同一个 stage 曾有两套说法在线上同时存在——概览说「等你回话」，Thread 视图说
 * 「等你回答」；「等你解锁 / 等你解阻」同理。用户看到的是一套分裂的词汇表，而这
 * 不是潜在风险，是当下就在发生的显示错误，只是没人同时打开两个页面比对过。
 *
 * 判据：**同一个事实允许有几个渲染点，但只能有一个词汇表。**
 * 任何地方再写 `const STAGE_LABEL = {...}` 或 `function relTime()`，就是第二个写者。
 * `scripts/architecture-guard.mjs` 会拦住它（E2.1）。
 */
/**
 * 七个 stage 的展示。
 *
 * 键用 string 而非 `ThreadStage`：web-ui 不依赖 `@markus/shared`，强行引入会多一条
 * 跨包构建依赖。代价是丢掉「漏一个 stage 就编译报错」的保证，所以用测试补上：
 * `threadPresentation.test.ts` 断言七个 stage 一个不少。
 */

export interface StagePresentation {
  /** 给用户看的一句话 */
  label: string;
  /** 配色：只承载「要不要我动手」 */
  cls: string;
  /** hover 解释，说明这个 stage 到底在等什么 */
  hint: string;
}

/**
 * 七个 stage 的展示。键是闭集（ThreadStage），不是任意字符串——
 * 这样漏一个 stage 编译器就会报错，而不是运行时静默回退成「无待办」。
 *
 * **文案纪律（A3）**：每个标签都必须自带主语，且不得与另外两个「状态」词表
 * （治理态 `TaskStatus`、运行时注意力 `AttentionState`、进程态）出现相同字面。
 * 判据是可执行的：`stateVocabulary.test.ts` 把四张词表两两比对，撞词即红。
 * 曾经这里写着「进行中」（与治理态 `in_progress` 同字）和「空闲」（与进程态同字），
 * 用户在同一屏看到两个「进行中」，一个说任务、一个说流。
 */
export const STAGE_LABEL: Record<string, StagePresentation> = {
  'person:approval': { label: '等你批准', cls: 'bg-amber-500/15 text-amber-600', hint: '有东西卡在审批上' },
  'person:answer': { label: '等你回答', cls: 'bg-sky-500/15 text-sky-600', hint: '有提问没被回答' },
  'person:review': { label: '等你验收', cls: 'bg-violet-500/15 text-violet-600', hint: '已提交，等人确认' },
  'person:blocked': { label: '等你解阻', cls: 'bg-rose-500/15 text-rose-600', hint: '报了阻塞' },
  'system:queued': { label: '排队等资源', cls: 'bg-surface-overlay text-fg-secondary', hint: '等资源 / 等前置' },
  'agent:working': { label: 'Agent 处理中', cls: 'bg-emerald-500/15 text-emerald-600', hint: '分配在跑，没人在等你' },
  'none:idle': { label: '无待办', cls: 'bg-surface-overlay text-fg-tertiary', hint: '回合已结束，等新事件' },
};

/**
 * 流的**分组**头（ThreadView 的三个筛选组）。
 *
 * 单独一张表而不是就地写字面值：分组是 stage 的聚合，曾经在 ThreadView 里
 * 硬编码「进行中」「空闲」两个词，与治理态/进程态撞字面，且改 stage 词表时必须
 * 记得改第二处。这里是它唯一的写者，并同样受 `stateVocabulary.test.ts` 的互斥断言约束。
 */
export const THREAD_GROUP_LABEL = {
  waiting: '等你处理',
  active: '系统或 Agent 在推进',
  idle: '已收尾',
} as const;

/** 未知 stage 回退到「无待办」而不是抛错：展示层不该因为后端多一个 stage 就白屏。 */
export function stageLabel(stage: string | null | undefined): StagePresentation {
  if (!stage) return STAGE_LABEL['none:idle']!;
  return STAGE_LABEL[stage] ?? STAGE_LABEL['none:idle']!;
}

/** 颜色只承载「要不要我动手」：在等人的高亮，其余中性。 */
export function stageTone(stage: string | null | undefined): string {
  return stage?.startsWith('person:')
    ? 'bg-amber-500/15 text-amber-600'
    : 'bg-surface-overlay text-fg-secondary';
}

/** 路由处置的展示名。键与 `Disposition['action']`（shared/types/thread.ts）对应。 */
export const ACTION_LABEL: Record<string, string> = {
  accept: '接单',
  attach: '归入既有流',
  dispatch: '直接派发',
  stop: '停止',
  ignore: '忽略',
  defer: '延后',
};

export const actionLabel = (action: string | null | undefined): string =>
  (action && ACTION_LABEL[action]) || action || '—';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * 时间戳 → 「3 分钟前」。用于「这条等了多久」这类**指向过去某刻**的表达。
 *
 * 入参统一是 epoch ms。ISO 字符串请在边界处归一化（`toEpochMs`），
 * 否则 `Date.now() - '2026-11-02T…'` 会得到 NaN——那个 bug 曾经真实发生过。
 */
export function formatRelative(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  const d = Math.floor(diff / DAY);
  return d === 1 ? '昨天' : `${d} 天前`;
}

/**
 * 时长 → 「3 分钟」。用于「已等待」这类**纯区间**表达（不带「前」）。
 *
 * NaN 时回「时长未知」而不是「NaN 天」：把内部类型混乱泄露给用户比不显示更糟。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '时长未知';
  const d = Math.max(0, ms);
  if (d < MINUTE) return '不到 1 分钟';
  if (d < HOUR) return `${Math.floor(d / MINUTE)} 分钟`;
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时`;
  return `${Math.floor(d / DAY)} 天`;
}

/**
 * ISO 字符串 → epoch ms。**边界归一化**，让下游只面对一种类型。
 * 解析失败返回 NaN，交给 formatRelative/formatDuration 的防御分支。
 */
export function toEpochMs(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

/** ISO 或 epoch 都可的相对时间。只在确实会拿到两种形态的边界使用。 */
export function formatRelativeAny(value: string | number | null | undefined): string {
  return formatRelative(toEpochMs(value));
}

// ─────────────────────────────────────────────────────────────
// 「这是什么」—— 把机器标识翻译成人话
// ─────────────────────────────────────────────────────────────

/**
 * 流的种类。人看到的是「任务 / 需求 / 会话」，不是 `tsk_` 前缀。
 *
 * 为什么需要它：`tsk_d0dd96f6b846b0c3e51b52f6` 曾经铺在列表最显眼处。
 * 人的心智模型是「GEO 可见度基线快照」这张卡，不是它的 id。
 * id 是给机器用的，界面上它只配当**副标题里的定位符**。
 */
export function refKindLabel(ref: string | null | undefined): string {
  if (!ref) return '流';
  if (ref.startsWith('tsk_')) return '任务';
  if (ref.startsWith('req_')) return '需求';
  if (ref.startsWith('cs_')) return '会话';
  if (ref.startsWith('a2a_')) return 'Agent 对话';
  if (ref.startsWith('thr_')) return '流';
  const i = ref.indexOf(':');
  return i > 0 ? ref.slice(0, i) : '流';
}

/**
 * 机器 id 的短形态：`tsk_d0dd96f6b846…` → `tsk_d0dd96`。
 *
 * 外部资源键（`gh:owner/repo`）原样返回 —— 它本身就是可读的，截断反而伤信息。
 * 只截那些**对人类无意义、但对排障有用的**前缀 id。
 */
export function shortRef(ref: string | null | undefined): string {
  if (!ref) return '';
  if (ref.includes(':')) return ref;
  const m = /^([a-z]+)_(.{6})/.exec(ref);
  return m ? `${m[1]}_${m[2]}` : ref;
}

/** 「这是什么 · 定位符」——列表副标题与详情页共用的一个短语。 */
export function refDisplay(ref: string | null | undefined): string {
  const kind = refKindLabel(ref);
  const short = shortRef(ref);
  // 外部键已经带类型（gh:…），不重复成「gh · gh:owner/repo」
  return ref?.includes(':') ? short : `${kind} · ${short}`;
}

/**
 * 时间短语按 stage 变 —— 这是「已等」被用错场景的修法。
 *
 * 「已等 13 分钟」只在**在等人/等资源**时成立；
 * 对一个「空闲」的流说「已等」，读者会去找它在等谁，而答案是没有人。
 * 所以：
 *   在等人 / 排队 → 已等 X（真的有人在等）
 *   进行中        → 已进行 X
 *   空闲          → 最后活动 X 前
 */
export function waitPhrase(stage: string | null | undefined, elapsedMs: number): string {
  if (stage?.startsWith('person:')) return `已等 ${formatDuration(elapsedMs)}`;
  if (stage === 'system:queued') return `排队 ${formatDuration(elapsedMs)}`;
  if (stage === 'agent:working') return `已进行 ${formatDuration(elapsedMs)}`;
  return `最后活动 ${formatDuration(elapsedMs)}前`;
}

/**
 * 「本会接 / 本不会接 / 没问过」的唯一判据（三态）。
 *
 * **踩过的坑（2026-11-02）**：这个语义在 UI 里写反过两次 ——
 * `wouldAccept` 的含义是「如果放行，他会接」，所以「本可接单」= `true`。
 * 两处 UI 都写成 `=== false`，于是 observe 的记录**永远进不了观察模式筛选**，
 * 那句提示也永远不显示。语义反了不会报错，只会安静地少显示东西。
 *
 * **第二个坑（2026-11-03，B3）**：它被当成布尔，而库里其实有三态。
 * `null` = 这次处置**没问过**这个问题（dispatch / attach / stop），
 * 被读成 `false` 后，UI 对着「没问过」的行说「当时判定不该来」。
 * 所以判据必须三态，且**只能在这里**从字段映射成结论。
 */
export type WouldAcceptVerdict = 'accept' | 'reject' | 'not-asked';

export function wouldAcceptVerdict(d: { wouldAccept?: boolean | null }): WouldAcceptVerdict {
  if (d.wouldAccept === true) return 'accept';
  if (d.wouldAccept === false) return 'reject';
  return 'not-asked';
}
