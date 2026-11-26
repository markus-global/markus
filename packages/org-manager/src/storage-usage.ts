/**
 * Storage accounting for the agent overview / system storage panels.
 *
 * ## Why this module exists
 *
 * The agent storage panel used to be assembled inline in `api-server.ts` from
 * five hand-written `dirSize(...)` calls. Measured against a live agent
 * directory that produced three defects at once:
 *
 * 1. **The label drifted from the content.** The `memory` sub-item was
 *    `dirSize(sessions/)` plus a couple of small files. `sessions/` holds
 *    serialized conversation sessions, not memory, so the panel reported
 *    "memory 259 MB" for an agent whose `knowledge.md` is 24 KB and whose
 *    `MEMORY.md` is 27 KB — i.e. ~99.98% of those bytes are not memory.
 *
 * 2. **`size` was not a total.** It was the sum of the five hand-picked
 *    sub-items, so anything not in that list silently vanished from the
 *    headline figure: `worktrees/` (22.8 MB), `subagent-logs/` (20.8 MB) and
 *    stray files in the agent home. Measured: 703 MB displayed vs 903 MB real
 *    — 22% missing, presented as "存储" (the agent's storage).
 *
 * 3. **A depth-limited estimate was presented as an exact figure.** Each walk
 *    was capped and never recorded that the cap had bitten. For the same agent,
 *    `workspace/` displayed 109 MB against 309 MB on disk, because repositories
 *    and `node_modules` nest deeper than the cap.
 *
 * Bucketing a *single* traversal by top-level entry fixes all three by
 * construction: bucket names are real directory names (so no label can drift
 * from its content), `total` is the sum of everything actually visited, and
 * `depthLimited` records that the cap bit instead of hiding it.
 *
 * ## Cost, and why the depth bound exists
 *
 * An unbounded walk of the live org (106 agents) exceeds 60 s. Callers must
 * therefore cap depth and cache results — see the TTL cache in `api-server.ts`.
 * Do not raise the cap without re-measuring on a real data directory.
 *
 * The cap is why `total` is a **lower bound**, not a size, and why
 * `depthLimited` is reported rather than swallowed.
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** One top-level entry of the walked directory and the bytes attributed to it. */
export interface DirUsageBucket {
  name: string;
  size: number;
}

export interface BucketedDirUsage {
  /**
   * Bytes of every entry visited, i.e. the sum of `buckets`. Complete in
   * breadth (every top-level entry is represented) but bounded in depth by
   * `maxDepth`.
   */
  total: number;
  /** Top-level entries, largest first. Zero-byte entries are dropped. */
  buckets: DirUsageBucket[];
  /**
   * True when at least one directory sat at the depth cap and was therefore not
   * descended into. The figure is then a lower bound, not an exact size —
   * surface this to the user rather than presenting the number as exact.
   */
  depthLimited: boolean;
  /** Symlinks encountered and deliberately not followed. */
  symlinksSkipped: number;
}

export interface BucketedDirUsageOptions {
  /**
   * Maximum directory depth to descend. The walked directory is depth 0; its
   * direct children are depth 1. A *file* at any depth <= maxDepth counts; a
   * *directory* at depth >= maxDepth is not descended into.
   *
   * Default 4 is not arbitrary: the code this module replaces called
   * `dirSize(subdir)` with the subdirectory itself at depth 0, so equivalent
   * coverage requires one extra level when walking from the agent directory
   * instead. Verified against a live agent — at `maxDepth: 4` the `workspace`
   * bucket measures 109.0 MB, exactly the figure the old code displayed, whereas
   * `maxDepth: 3` would have measured 102.8 MB and quietly made the number
   * worse than the bug it was replacing.
   */
  maxDepth?: number;
}

/** Directory entries we never count: transient OS metadata, not agent storage. */
const IGNORED_ENTRIES = new Set(['.DS_Store']);

/**
 * Walk `dir` once and attribute every byte to its top-level entry.
 *
 * Symlinks are never followed. Two reasons, both about correctness rather than
 * speed: a symlinked directory can point at another agent's tree (so the bytes
 * would be counted twice, once per agent) and can form a cycle. Skipping them
 * keeps "how much disk does *this* agent use" answerable; the target is counted
 * where it physically lives. `symlinksSkipped` reports the count so a caller can
 * tell that something was left out on purpose.
 */
export async function bucketedDirUsage(
  dir: string,
  options: BucketedDirUsageOptions = {},
): Promise<BucketedDirUsage> {
  const maxDepth = options.maxDepth ?? 4;

  let topLevel: string[];
  try {
    topLevel = await readdir(dir);
  } catch {
    // Missing or unreadable directory == no storage to report. Not an error:
    // agents that have never run have no workspace/ yet.
    return { total: 0, buckets: [], depthLimited: false, symlinksSkipped: 0 };
  }

  // Children are walked concurrently and each subtree returns its own counters.
  // The previous version was synchronous *and* mutated a shared `result` object,
  // so a real org (100+ agents, measured at >60 s) held the Node event loop for
  // the entire scan — every other request in the app stalled behind it.
  const walked = await Promise.all(
    topLevel
      .filter(name => !IGNORED_ENTRIES.has(name))
      .map(async name => ({ name, ...(await walkInto(join(dir, name), maxDepth, 1)) })),
  );

  const result: BucketedDirUsage = { total: 0, buckets: [], depthLimited: false, symlinksSkipped: 0 };
  for (const child of walked) {
    if (child.size > 0) result.buckets.push({ name: child.name, size: child.size });
    result.total += child.size;
    if (child.depthLimited) result.depthLimited = true;
    result.symlinksSkipped += child.symlinksSkipped;
  }

  result.buckets.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  return result;
}

/**
 * Total bytes under `dir`, bounded by `maxDepth`.
 *
 * Thin wrapper over `bucketedDirUsage` so there is exactly **one** walk
 * implementation. Three hand-written copies of this loop had already drifted
 * apart before (see the module header), and each new copy is another place for
 * the symlink and depth rules to be forgotten.
 */
export async function dirSizeAsync(dir: string, maxDepth = 3): Promise<number> {
  return (await bucketedDirUsage(dir, { maxDepth })).total;
}

/**
 * Accumulate the bytes under one top-level entry.
 *
 * `depth` is the depth of `path` itself (top-level children are depth 1). A
 * directory at `depth >= maxDepth` sets `depthLimited` and is not entered, so
 * the caller knows its number is a lower bound.
 */
async function walkInto(
  path: string,
  maxDepth: number,
  depth: number,
): Promise<{ size: number; depthLimited: boolean; symlinksSkipped: number }> {
  // lstat, not stat: `stat` follows symlinks, which would make the
  // `isSymbolicLink()` guard below dead code and re-open both the double-count
  // and the cycle problems this module is meant to avoid.
  let st;
  try {
    st = await lstat(path);
  } catch {
    return { size: 0, depthLimited: false, symlinksSkipped: 0 };
  }

  if (st.isSymbolicLink()) return { size: 0, depthLimited: false, symlinksSkipped: 1 };

  if (st.isFile()) return { size: st.size, depthLimited: false, symlinksSkipped: 0 };

  if (!st.isDirectory()) return { size: 0, depthLimited: false, symlinksSkipped: 0 };

  if (depth >= maxDepth) return { size: 0, depthLimited: true, symlinksSkipped: 0 };

  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return { size: 0, depthLimited: false, symlinksSkipped: 0 };
  }

  const children = await Promise.all(
    entries
      .filter(name => !IGNORED_ENTRIES.has(name))
      .map(name => walkInto(join(path, name), maxDepth, depth + 1)),
  );

  let size = 0;
  let depthLimited = false;
  let symlinksSkipped = 0;
  for (const child of children) {
    size += child.size;
    if (child.depthLimited) depthLimited = true;
    symlinksSkipped += child.symlinksSkipped;
  }
  return { size, depthLimited, symlinksSkipped };
}
