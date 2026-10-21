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
  // 只对形如 {"$blob":...} 的极小字符串做解析，避免给每行付 JSON.parse 的成本
  if (json.length > 200 || json.charCodeAt(0) !== 123 /* { */) return json;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (isBlobRef(parsed)) {
      const text = store.getText(parsed.$blob);
      return text ?? json; // 文件丢了就保留指针，至少不伪造内容
    }
  } catch { /* 不是 JSON —— 原样返回 */ }
  return json;
}
