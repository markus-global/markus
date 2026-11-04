/**
 * 拉取侧的位点推进 —— **唯一消费入口**。
 *
 * 位点回答的问题是「这条来源的上游读到哪儿了」，它只在**全部消费成功**之后前进。
 * 为什么要把这件事做成一个函数、而不是让每个入口自己 `UPDATE ... SET cursor`：
 *  - 失败时推进位点 = 静默丢事件（上游认为你收过了，你却没收）；
 *  - 乱序推进 = 慢的拉取者覆盖快的（没有 CAS 时结构上完全可能）；
 *  - 每个入口各写一次 = 同一个事实多个写者（A1 那个病的形状）。
 *
 * 所以推进凭证 `CursorAdvance` 带私有 symbol 品牌，**只能**由 `mintCursorAdvance()`
 * 铸造；该函数在 `failed > 0` 时直接抛错。于是「消费失败还推进」不是靠人记得，
 * 而是**拿不到凭证**（拒绝 + 可行动提示）。
 *
 * 与幂等键的分工（不可互替）：
 *  - 位点 → 「不重复拉」：拉取侧、按上游顺序、失败不前进；
 *  - 幂等键 → 「重复投递只留一行」：入口侧、与顺序无关、重试安全。
 * 位点**不**承担去重（回退就会重放，由幂等键兜底）；幂等键**不**推进位点
 * （那会把「已读到」误记成「已处理完」）。
 */
import type { IngressResult } from './event-ingress.js';
import type { RawEvent } from './event-source.js';

declare const CURSOR_ADVANCE: unique symbol;

/**
 * 位点推进凭证。
 *
 * 私有 symbol 品牌让它无法被字面量构造：想拿到它，必须交出「本批消费结果」。
 * 这不是装饰 —— 它是「失败不得推进位点」这条不变量的**类型层执行点**。
 */
export interface CursorAdvance {
  readonly [CURSOR_ADVANCE]: true;
  readonly sourceId: string;
  /** 读取前看到的位点（CAS 期望值） */
  readonly expectedCursor: string | null;
  /** 推进到的位点 */
  readonly cursor: string | null;
  readonly polledAt: number;
  /** 本批成功消费的事件数（观测用） */
  readonly consumed: number;
}

export interface CursorAdvanceEvidence {
  sourceId: string;
  expectedCursor: string | null;
  cursor: string | null;
  polledAt: number;
  consumed: number;
  /** 本批失败条数。> 0 时**拒绝**铸造凭证。 */
  failed: number;
}

/** 铸造位点推进凭证 —— 全仓唯一的铸造者。 */
export function mintCursorAdvance(e: CursorAdvanceEvidence): CursorAdvance {
  if (e.failed > 0) {
    throw new Error(
      `CURSOR_ADVANCE_AFTER_FAILURE: 本批有 ${e.failed} 条消费失败，位点不得推进（source=${e.sourceId}）。` +
        `请重试同一位置：已成功那部分由幂等键去重，不会重复处理。`,
    );
  }
  if (!Number.isFinite(e.polledAt)) {
    throw new Error('CURSOR_ADVANCE_NO_TIME: polledAt 必须是毫秒时间戳');
  }
  return {
    sourceId: e.sourceId,
    expectedCursor: e.expectedCursor,
    cursor: e.cursor,
    polledAt: e.polledAt,
    consumed: e.consumed,
  } as CursorAdvance;
}

/** 消费方需要的来源视图（结构类型：便于真仓储与测试夹具同构） */
export interface PullSource {
  id: string;
  prefix: string;
  cursor: string | null;
  config: Record<string, unknown>;
}

export interface CursorStore {
  getById(id: string): PullSource | null;
  /** 唯一写位点的语句（CAS）；返回 false = 期望位点已不匹配 */
  advanceCursor(a: {
    sourceId: string;
    expectedCursor: string | null;
    cursor: string | null;
    polledAt: number;
  }): boolean;
}

export type ConsumeStatus =
  | 'committed' // 全部成功 → 位点已推进
  | 'not-committed' // 有失败 → 位点原地不动（重试同一位置）
  | 'stale' // 位点已被他人推进（CAS 落空），本次不覆盖
  | 'missing-source'; // 来源不存在

export interface ConsumeResult {
  status: ConsumeStatus;
  /** 提交后（未提交时=当前）的位点 */
  cursor: string | null;
  /** 载荷里的事件数 */
  events: number;
  consumed: number;
  failed: number;
  reason: string;
  /** 逐事件结果（与 `reason` 同一份事实，给调用方与测试用） */
  results?: IngressResult[];
}

export interface ConsumeDeps {
  sources: CursorStore;
  /** **结构类型**：真的 `EventIngress` 天然满足；测试可以注入可编排的夹具。 */
  ingress: { ingest(raw: RawEvent): IngressResult };
  now?: () => number;
}

/**
 * 消费一批事件，并在**全部成功**时推进位点。
 *
 * 空批次也要推进：拉取成功但这一页没有新事件同样是「读过了」，
 * 否则同一页会被永远重拉（这是位点与幂等键分工的边界）。
 */
export function consumeBatch(
  deps: ConsumeDeps,
  args: { sourceId: string; raw: RawEvent; nextCursor: string | null },
): ConsumeResult {
  const polledAt = deps.now ? deps.now() : Date.now();
  const source = deps.sources.getById(args.sourceId);
  if (!source) {
    return {
      status: 'missing-source',
      cursor: null,
      events: 0,
      consumed: 0,
      failed: 0,
      reason: `未登记的来源 ${args.sourceId}：请先在 event_sources 里登记`,
    };
  }

  let res: IngressResult;
  try {
    res = deps.ingress.ingest(args.raw);
  } catch (e) {
    return {
      status: 'not-committed',
      cursor: source.cursor,
      events: 0,
      consumed: 0,
      failed: 1,
      reason: `消费异常，位点保持不动：${(e as Error).message}`,
    };
  }

  const results = res.results ?? [res];
  const failed = results.filter(r => r.failed).length;
  const consumed = Math.max(0, res.events - failed);

  if (failed > 0) {
    return {
      status: 'not-committed',
      cursor: source.cursor,
      events: res.events,
      consumed,
      failed,
      reason: `本批有 ${failed} 条消费失败 → 位点不推进（停在 ${source.cursor ?? 'null'}，重试同一位置）`,
      results,
    };
  }

  const advance = mintCursorAdvance({
    sourceId: source.id,
    expectedCursor: source.cursor,
    cursor: args.nextCursor,
    polledAt,
    consumed,
    failed: 0,
  });

  const committed = deps.sources.advanceCursor({
    sourceId: advance.sourceId,
    expectedCursor: advance.expectedCursor,
    cursor: advance.cursor,
    polledAt: advance.polledAt,
  });

  if (!committed) {
    return {
      status: 'stale',
      cursor: source.cursor,
      events: res.events,
      consumed,
      failed: 0,
      reason: `位点已被并发推进（期望 ${source.cursor ?? 'null'}）→ 本次不覆盖；下一次拉取从最新位点继续`,
      results,
    };
  }

  return {
    status: 'committed',
    cursor: args.nextCursor,
    events: res.events,
    consumed,
    failed: 0,
    reason: `本批 ${res.events} 条全部消费成功 → 位点推进到 ${args.nextCursor ?? 'null'}`,
    results,
  };
}
