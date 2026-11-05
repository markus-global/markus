/**
 * 取数结果的**唯一三态原语**（loading / ok / error）与**唯一「有没有东西」判据**。
 *
 * ── 为什么存在（这曾是一族生产缺陷）──────────────────────────────────────
 * 前端最常见的谎话是这一句：`try { setItems(await api.list()) } catch { setItems([]) }`。
 * 读失败被写成空数组之后，界面渲染的是「确实没有」——而事实是「我们不知道」。
 * 用户看到的差别是：空列表 + 「还没有任何交付物」这句**断言**。
 *
 * 三种状态必须**同时**可表达，且**不能**靠同一个值（空数组）承载两种含义：
 *   - `loading` —— 还没读到（首帧、切换对象、重试中）；
 *   - `ok`      —— 读到了，`items` 就是事实（`items.length === 0` 才叫「确实没有」）；
 *   - `error`   —— 没读到，`error` 是人话原因；此时 `items` **不是**事实。
 *
 * ── 纪律（改它就是改语义）──────────────────────────────────────────────
 * 1. `SourceState` 只在这里定义一次。`lib/threadTimeline.ts` 从本文件 import 并 re-export，
 *    不再有第二份字面量联合类型。
 * 2. **「有没有东西」只能由 `listView()` 回答**。UI 不得再各自写 `items.length === 0`
 *    —— 那是同一问题的第二份实现，迟早会和这里对不上（`empty` 为真还要求「没在读、没失败」）。
 * 3. 取数失败**只能**经 `readList()` 落成 `state: 'error'`；把失败折成 `items: []` 的写法
 *    会被 `scripts/probe-catch-swallow.mjs` / `probe-catch-setempty.py` 的「取数路径类」命中。
 * 4. 多来源（两条腿各自可能失败）用 `combineSources()` 聚合，不要各写一遍 ||
 *    —— 与时间线视图同一个聚合实现。
 */

/**
 * 来源的读取状态。'error' 与「读到 0 条」是两件不同的事，
 * 绝不允许折叠成一个空数组（这一条就是本模块存在的理由）。
 */
export type SourceState = 'loading' | 'ok' | 'error';

/** 一次取数的完整事实：状态 + 内容 + 失败原因（`error` 只在 `state === 'error'` 时有意义）。 */
export interface Resource<T> {
  readonly state: SourceState;
  /** 已读到的内容。**只有在 `state === 'ok'` 时它才是事实**。 */
  readonly items: readonly T[];
  /** 人话失败原因（仅 `state === 'error'`）。 */
  readonly error: string | null;
}

/**
 * 「这份数据怎么渲染」的唯一答案。
 *
 * `empty` 只有在「没在读、没失败、也没有内容」时才为 true —— 所以调用方
 * 不需要（也不允许）自己再判一次 `items.length === 0`。
 */
export interface ListView<T> {
  /** 仍有取数在飞 */
  readonly loading: boolean;
  /** 读失败（人话原因在 `Resource.error`） */
  readonly error: boolean;
  /** 已读到的行。`error` 为真时它是**上一次**的内容（可能为空），不是事实。 */
  readonly rows: readonly T[];
  /** **唯一**「确实没有」的判据 */
  readonly empty: boolean;
}

/** 异常 → 人话。集中一处，避免每处各写一遍 `e instanceof Error ? … : String(e)`。 */
export function errorMessage(err: unknown, fallback = '读取失败'): string {
  if (err instanceof Error && err.message) return err.message;
  const s = typeof err === 'string' ? err : '';
  return s || fallback;
}

/** 初始态：还没开始读。 */
export function loadingResource<T>(): Resource<T> {
  return { state: 'loading', items: [], error: null };
}

/** 读到的事实（含「确实读到 0 条」）。 */
export function okResource<T>(items: readonly T[]): Resource<T> {
  return { state: 'ok', items, error: null };
}

/** 读失败。`items` 只用于保留上一次的内容（陈旧但非事实），绝不冒充本次结果。 */
export function errorResource<T>(err: unknown, items: readonly T[] = []): Resource<T> {
  return { state: 'error', items, error: errorMessage(err) };
}

/**
 * 取数 → `Resource`。**失败不抛出**，而是落成 `state: 'error'`。
 *
 * 这是把「读失败」从「空集合」里结构性分开的唯一入口：调用方拿到的类型里
 * 没有「失败 = 空」这条通路可走 —— 想渲染空态必须先过 `listView().empty`。
 *
 * `keep`：刷新失败时保留上一次的内容（界面显示陈旧列表 + 错误条，而不是把一个
 * 已知有内容的列表清空成「一个都没有」）。首屏/切对象时不要传。
 */
export async function readList<T>(
  read: () => Promise<readonly T[]>,
  options: { readonly keep?: readonly T[] } = {},
): Promise<Resource<T>> {
  try {
    return okResource(await read());
  } catch (err) {
    return errorResource<T>(err, options.keep ?? []);
  }
}

/** `Resource` → 渲染判据。 */
export function listView<T>(r: Resource<T>): ListView<T> {
  const loading = r.state === 'loading';
  const error = r.state === 'error';
  return { loading, error, rows: r.items, empty: !loading && !error && r.items.length === 0 };
}

/** 多来源聚合：带人话标签的状态列表（标签集中一处，避免各渲染点各写一套）。 */
export interface SourceEntry {
  readonly label: string;
  readonly state: SourceState;
}

export interface CombinedSources {
  /** 任一来源仍在读 → loading；否则任一失败 → error；否则 ok。 */
  readonly state: SourceState;
  readonly loading: boolean;
  /** 读取失败的来源（人话标签，按入参顺序） */
  readonly failures: string[];
  /** 至少一条腿读成功（用于「部分可用」的提示） */
  readonly anyOk: boolean;
}

/**
 * 聚合多来源状态。**同一个实现**服务于：时间线视图（事件/判断/投递）
 * 与「模板库」这类两腿并行的取数（Hub + 本地模板）。
 *
 * 读失败不是「这条腿没有数据」：只要有一条腿失败，聚合态就是 `error`，
 * 界面必须显示「部分内容未知」，而不是把失败腿渲染成空。
 */
export function combineSources(entries: readonly SourceEntry[]): CombinedSources {
  const failures: string[] = [];
  let loading = false;
  let anyOk = false;
  for (const e of entries) {
    if (e.state === 'loading') loading = true;
    else if (e.state === 'error') failures.push(e.label);
    else anyOk = true;
  }
  const state: SourceState = loading ? 'loading' : failures.length > 0 ? 'error' : 'ok';
  return { state, loading, failures, anyOk };
}
