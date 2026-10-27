/**
 * 内容寻址的大字段外置存储（M1 + M2 + M4 共用的唯一机制）。
 *
 * 为什么是「一个机制」而不是三个补丁
 * ─────────────────────────────────
 * 实测这台机器的库：`agent_activity_logs` 3.2 GB 在 metadata、`task_logs` 457 MB
 * 在 metadata、`mailbox_items` 里一条 `task_status_update` 平均 189 KB（因为把整份
 * 任务正文复制进了队列）、`chat_messages.metadata` 里塞着 base64 图片（最大单行
 * 2.39 MB）。四处的病因完全一样：**把大载荷塞进行里**。
 *
 * 所以只做一件事：超过阈值的载荷写到内容寻址的文件里，行里只留
 * `{"$blob":"<sha256>","$bytes":N}`。读取时**透明还原**，所以上层代码看到的
 * 数据形状完全不变 —— 不需要改任何读路径、不需要改前端。
 *
 * 顺带得到去重：同一份内容出现 N 次只占一份磁盘。
 *
 * 不变量
 * ──────
 *  B1 写入幂等：同内容重复 put 不产生第二个文件
 *  B2 还原透明：resolve(project(x)) 与 x 等价（字符串与对象都成立）
 *  B3 失败不静默：文件写不进去就不写投影，宁可让行变大也不丢数据
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BlobRef {
  $blob: string;
  $bytes: number;
}

const BLOB_KEY = '$blob';
const BYTES_KEY = '$bytes';

export function defaultBlobRoot(): string {
  return join(homedir(), '.markus', 'blobs');
}

/** `{"$blob": ...}` 形状判定 —— 唯一执行点，别在别处再写一遍。 */
export function isBlobRef(value: unknown): value is BlobRef {
  return !!value
    && typeof value === 'object'
    && typeof (value as Record<string, unknown>)[BLOB_KEY] === 'string'
    && typeof (value as Record<string, unknown>)[BYTES_KEY] === 'number';
}

export class BlobStore {
  constructor(private readonly root: string = defaultBlobRoot()) {}

  private pathFor(sha: string): string {
    // 两级分片，避免单目录几十万文件
    return join(this.root, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  /** B1: same content ⇒ same file, written at most once. */
  put(data: string | Buffer): BlobRef {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const sha = createHash('sha256').update(buf).digest('hex');
    const path = this.pathFor(sha);
    if (!existsSync(path)) {
      mkdirSync(join(this.root, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, buf);
      renameSync(tmp, path); // 原子落盘，避免读到半截文件
    }
    return { [BLOB_KEY]: sha, [BYTES_KEY]: buf.length } as BlobRef;
  }

  get(sha: string): Buffer | null {
    const path = this.pathFor(sha);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  getText(sha: string): string | null {
    const buf = this.get(sha);
    return buf ? buf.toString('utf8') : null;
  }

  has(sha: string): boolean {
    return existsSync(this.pathFor(sha));
  }
}

/**
 * 把「超大 JSON 字符串」投影成指针。返回**要存进库的字符串**。
 *
 * 阈值以下原样返回（绝大多数行不受影响，避免给小载荷套壳）。
 * 写文件失败时原样返回（B3：宁可大，不丢数据）。
 */
export function projectJsonForStorage(json: string, store: BlobStore, thresholdBytes: number): string {
  if (!json || json.length <= thresholdBytes) return json;
  try {
    const ref = store.put(json);
    return JSON.stringify(ref);
  } catch {
    return json;
  }
}

/** 读取方向的透明还原：指针 → 原始 JSON 字符串。 */
export function resolveJsonFromStorage(json: string | null | undefined, store: BlobStore): string {
  if (!json) return json ?? '';
  if (json.charCodeAt(0) !== 123 /* { */) return json;
  // 快速否决：绝大多数字段不含指针，避免为每行付 JSON.parse 的代价。
  //
  // 判据必须是**结构**（含 "$blob" 键），不能是长度。用 `length > 200` 当门槛是把
  // “纯指针很短”这个经验假设当成了不变量：指针一旦与其它字段并存（混合体），
  // 就会漏判 —— 实测真实事故：某行 metadata 是
  // `{"$blob":"...","$bytes":119048,"segments":[1 段]}`，119KB 被外层长度
  // 挡在门外，前端只看到那 1 段残片，完整 63 段（32 次工具调用）明明就在 blob 里。
  if (!json.includes('"$blob"')) return json;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json;
    const ref = parsed as Record<string, unknown>;
    const sha = ref[BLOB_KEY];
    if (typeof sha !== 'string') return json;
    const text = store.getText(sha);
    if (text == null) return json; // 文件丢了就原样返回，至少不伪造内容
    // 纯指针：blob 正文就是完整答案。
    if (isBlobRef(parsed) && Object.keys(ref).length === 2) return text;
    // 混合体（指针 + 外层残留字段）：blob 正文是**权威**，外层非 `$` 字段只补缺不覆盖。
    //
    // 前提（这个函数能成立的全部依据，写在这里以免下一个人靠猜）：
    //   外层那些非 `$` 字段是 `projectJsonForStorage` 在**外置那一刻**降级留下的残片，
    //   而 blob 正文是同一时刻写入的**完整快照**。所以对任何一个两边都有的键，
    //   blob 侧不旧于外层侧——不是因为「blob 天然更新」，而是因为**两者同源、
    //   外层是被截断的那一份**。
    //
    // 这个前提会在什么情况下**不再成立**：若有哪一天出现一个写入方，先写指针、
    // 之后又单独修改外层的某个字段（两个写者、两次写），那外层就可能反而更新，
    // 而这里会把它埋掉。真出现那种场景，不能靠调这里的顺序解决，必须给混合体
    // 加一个单调的 `$updatedAt` 做仲裁（谁新用谁）。在此之前，任何新增写入路径
    // 都必须遵守：**指针与它的外层兄弟字段只能同一次写入**。
    //
    // 为什么不用 `Object.assign(merged, ref)`（外层覆盖）：外层那 1 段正是降级
    // 产物，覆盖会把完整数据又降回残片——实测事故里 63 段被 1 段盖掉。
    try {
      const base = JSON.parse(text) as unknown;
      if (base && typeof base === 'object' && !Array.isArray(base)) {
        const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
        for (const [k, v] of Object.entries(ref)) {
          if (k === BLOB_KEY || k === BYTES_KEY) continue;
          if (!(k in merged)) merged[k] = v;
        }
        return JSON.stringify(merged);
      }
    } catch { /* blob 不是 JSON 对象 —— 用原文 */ }
    return text;
  } catch { /* 不是 JSON —— 原样返回 */ }
  return json;
}
