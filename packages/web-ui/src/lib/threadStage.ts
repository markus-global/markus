/**
 * 「这条流此刻在等谁」在前端只有这一个词表（C9-C）。
 *
 * 这个概念的**派生**只有一个写者：`@markus/core` 的 `deriveStage()`。前端不重算，
 * 只把服务端给的闭集值翻译成人话。所以本文件只做三件事：
 *
 *  1. 闭集的运行时守卫（值过 JSON 之后可能是任何字符串）；
 *  2. 每个 stage 的文案键 + 语气（颜色和字必须同处一处，否则会出现「灰色：需要你」）；
 *  3. 证据指针的分类（哪个 id 能点进交付物、哪个是本页评论）。
 *
 * 历史教训：`stateVocabulary.ts` 头注释曾声称阶段词表在 `threadPresentation.ts` 的
 * `STAGE_LABEL`，那个文件早已删除——悬空引用比没有引用更坏。现在词表在这里，
 * 且本文件的名称就是它唯一的入口。
 */
import type { Tone } from './tone.ts';

/** 与 `packages/core/src/facts/derive-stage.ts` 的 `THREAD_STAGES` 逐字对应。 */
export const THREAD_STAGES = [
  'waiting_human',
  'running',
  'needs_evidence',
  'in_verification',
  'done',
  'blocked_deps',
  'failed',
] as const;

export type ThreadStage = (typeof THREAD_STAGES)[number];

/** 服务端值过 JSON 之后的唯一收口点：不认识的一律当 `undefined`（不编造状态）。 */
export function asThreadStage(value: unknown): ThreadStage | undefined {
  return typeof value === 'string' && (THREAD_STAGES as readonly string[]).includes(value)
    ? (value as ThreadStage)
    : undefined;
}

/**
 * 词表键（`common:threadStage.*`）。
 *
 * `failed` 用 `ended`（已终止 / Given up）而不是「失败」：治理态里已有
 * `taskStatus.failed`，「失败」同屏出现会让两个概念共用一个字面 —— 跨词表字面互斥
 * 由 `threadStage.test.ts` 用 `crossVocabularyCollisions()` 断言。
 */
export const THREAD_STAGE_KEY: Readonly<Record<ThreadStage, string>> = {
  waiting_human: 'waitingHuman',
  running: 'running',
  needs_evidence: 'needsEvidence',
  in_verification: 'inVerification',
  done: 'done',
  blocked_deps: 'blockedDeps',
  failed: 'ended',
};

/**
 * 语气（颜色）——**直接复用 `tone.ts` 的语义色调**，不新造一套颜色词。
 *
 * 每个 stage 只挑一个已有的含义（`tone.ts` 头注释里的六行表），因为它们本来就说清了
 * 「你的动作」：
 *  · `attention`（在等你）—— 只有 `waiting_human` 配；
 *  · `active`（正在推进）—— `running`；
 *  · `blocked`（卡住了，要看）—— `needs_evidence`；
 *  · `neutral`（不用管）—— `blocked_deps`（引擎自恢复）/ `in_verification`；
 *  · `success` —— `done`；`danger` —— `failed`。
 */
export const THREAD_STAGE_TONE: Readonly<Record<ThreadStage, Tone>> = {
  waiting_human: 'attention',
  running: 'active',
  needs_evidence: 'blocked',
  in_verification: 'neutral',
  done: 'success',
  blocked_deps: 'neutral',
  failed: 'danger',
};

export function threadStageLabel(
  stage: ThreadStage | undefined,
  t: (key: string) => string,
): string | undefined {
  if (!stage) return undefined;
  return t(`common:threadStage.${THREAD_STAGE_KEY[stage]}`);
}

/** 证据折叠区里的一行（服务端 `toEvidenceView()` 的投影，不在这里重算派生）。 */
export interface ThreadEvidence {
  factId: string;
  predicate: string;
  value: unknown;
  assertedBy: string;
  sourceRefs: string[];
  verification: { result: 'pass' | 'fail'; verifiedBy: string } | null;
  createdAt: string;
}

/** 证据指针的类型：决定点击后是「在本页展开」还是「跳到交付物」。 */
export type SourceRefKind = 'deliverable' | 'comment' | 'inPlace';

/**
 * 判别位 → locale 键名的**唯一映射**。
 *
 * 为什么值不直接当键用：判别位若用连字符拼（`in` + 连字符 + `place`）、locale 键写成
 * `inPlace`，拼出来就是一个不存在的键，而 i18next 遇到不存在的键不会报错、会把键原样
 * 上屏——用户看到的就是一整条 `threadStage.evidence.refKind.…` 裸键。这类 bug 不会被类型检查发现，
 * 也不会被「断言中文标签」的用例发现（那只覆盖了写对的那两类）。
 *
 * 所以：判别位和键名分开写，映射表用 `Record<SourceRefKind, string>` 的**全量**类型，
 * 少一个键就编译不过；组件只许通过这张表拼键（`SOURCE_REF_KEY[kind]`）。
 */
export const SOURCE_REF_KEY: Readonly<Record<SourceRefKind, string>> = {
  deliverable: 'deliverable',
  comment: 'comment',
  inPlace: 'inPlace',
};

export function sourceRefKind(ref: string): SourceRefKind {
  if (ref.startsWith('dlv_')) return 'deliverable';
  if (ref.startsWith('cmt_') || ref.startsWith('comment_')) return 'comment';
  return 'inPlace';
}

/**
 * 证据指针的人话：`commit:33cf01ef` → { kind:'commit', short:'33cf01ef' }。
 *
 * 为什么需要：旧渲染只给类型标签，一条证据挂 5 个指针就成了 5 个一模一样的
 * 「原始记录」—— 用户既分不清也无法选择。类型 + 值片段才能在不动指针的前提下
 * 把人在意的东西（哪个提交、哪条实测、哪张卡）放到面上。
 *
 * 未知格式走 `other` 并保留完整 ref：不倒空、不编造，宁可让人看到原文。
 */
export type RefPointerKind = 'commit' | 'probe' | 'task' | 'deliverable' | 'comment' | 'record' | 'transcript' | 'other';

export interface RefPointer {
  kind: RefPointerKind;
  /** 要拼在类型后面的值片段；空串表示该类型后不需要值。 */
  short: string;
}

export function sourceRefPointer(ref: string): RefPointer {
  const idx = ref.indexOf(':');
  const scheme = idx > 0 ? ref.slice(0, idx) : '';
  const rest = idx > 0 ? ref.slice(idx + 1) : ref;
  switch (scheme) {
    case 'commit': return { kind: 'commit', short: rest.slice(0, 8) };
    case 'probe': return { kind: 'probe', short: '' };
    case 'task': return { kind: 'task', short: '' };
    case 'deliverable': return { kind: 'deliverable', short: '' };
    case 'comment': return { kind: 'comment', short: '' };
    case 'fact': return { kind: 'record', short: rest.replace(/^fact_/, '').slice(0, 8) };
    case 'transcript': return { kind: 'transcript', short: '' };
    default:
      // `dlv_xxx` / `cmt_xxx` 是裸 id（无 scheme 前缀），沿用 sourceRefKind 的判别。
      if (ref.startsWith('dlv_')) return { kind: 'deliverable', short: '' };
      if (ref.startsWith('cmt_') || ref.startsWith('comment_')) return { kind: 'comment', short: '' };
      // 未知格式：类型标「其他」+ 截短存储（完整 ref 在 title 里）——
      // 真机上曾把整串 `fact:fact_c91b4622a6782a5e3a205cf5` 摊在按钮上，比不给还差。
      return { kind: 'other', short: ref.length > 18 ? `${ref.slice(0, 18)}…` : ref };
  }
}

/**
 * 「凭什么说做完了」——从事实值里取人话摘要。
 *
 * 只读 `summary`（`task.completion_evidence` 的约定字段）；没有 `summary` 就明确说
 * 「没有摘要」，**绝不**把整个 value 序列化到界面：把 facts 的原文倒给用户，等于让
 * 用户自己解释 JSON，这是「平台替 agent 决定内容」的反面版本（内容泄漏给不该看的层）。
 */
export function evidenceSummary(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const summary = (value as Record<string, unknown>)['summary'];
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : undefined;
}
