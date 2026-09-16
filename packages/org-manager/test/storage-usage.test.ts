/**
 * Storage accounting for the agent overview panel.
 *
 * These tests pin the three defects the module replaced, each measured on a live
 * agent directory before the change:
 *
 * 1. a sub-item labelled `memory` that actually held `sessions/` (259.4 MB of
 *    session files against 24 KB of real memory files),
 * 2. a headline `size` that was only the sum of five hand-picked sub-items
 *    (703.2 MB shown, 902.9 MB on disk — 22% missing), and
 * 3. a depth-limited walk reported as an exact figure (`workspace/` 109 MB shown
 *    vs 309 MB real).
 *
 * Fixtures are real temp directories rather than a mocked `fs`, because the point
 * of the module is how it walks a real tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bucketedDirUsage } from '../src/storage-usage.js';

let root: string;

beforeEach(() => {
  // realpathSync: on macOS `tmpdir()` is /var/…, a symlink to /private/var/…,
  // which would make every path in the fixture a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'storage-usage-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file of exactly `bytes` size, creating parent directories. */
function writeFile(relPath: string, bytes: number): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes, 'x'));
}

describe('bucketedDirUsage — totals', () => {
  it('total is the sum of every bucket, not a hand-picked subset', () => {
    writeFile('workspace/a.bin', 300);
    writeFile('sessions/b.bin', 200);
    writeFile('worktrees/c.bin', 100);
    writeFile('subagent-logs/d.bin', 50);

    const usage = bucketedDirUsage(root);

    expect(usage.total).toBe(650);
    expect(usage.buckets.reduce((s, b) => s + b.size, 0)).toBe(usage.total);
    // The regression: worktrees/ and subagent-logs/ were not in the hard-coded
    // five-item list and so vanished from the headline figure entirely.
    expect(usage.buckets.map(b => b.name).sort()).toEqual([
      'sessions',
      'subagent-logs',
      'workspace',
      'worktrees',
    ]);
  });

  it('counts stray files in the agent home, not just directories', () => {
    // A 163 MB knowledge.md.bak sits in a real agent home. The old headline
    // figure could not see it, because it only summed five named subdirectories.
    writeFile('knowledge.md.bak', 500);
    writeFile('workspace/a.bin', 10);

    const usage = bucketedDirUsage(root);

    expect(usage.total).toBe(510);
    expect(usage.buckets.find(b => b.name === 'knowledge.md.bak')?.size).toBe(500);
  });

  it('reports an empty directory as empty rather than throwing', () => {
    expect(bucketedDirUsage(root)).toEqual({
      total: 0,
      buckets: [],
      depthLimited: false,
      symlinksSkipped: 0,
    });
  });

  it('reports a missing directory as empty (agents that never ran have no workspace/)', () => {
    expect(bucketedDirUsage(join(root, 'does-not-exist')).total).toBe(0);
  });
});

describe('bucketedDirUsage — bucket names are real directory names', () => {
  it('never relabels a bucket', () => {
    // The defect: `memory` was a hand-written label for what the code actually
    // measured — `dirSize(sessions/)` plus two small files. A consumer could not
    // tell from the payload that the label was wrong. Buckets now carry the
    // entry name they were measured from, so a label cannot drift from content.
    writeFile('sessions/one.bin', 100);
    writeFile('knowledge.md', 20);

    const usage = bucketedDirUsage(root);

    expect(usage.buckets.map(b => b.name)).not.toContain('memory');
    expect(usage.buckets.find(b => b.name === 'sessions')?.size).toBe(100);
    expect(usage.buckets.find(b => b.name === 'knowledge.md')?.size).toBe(20);
  });

  it('sorts largest first with a stable tie-break', () => {
    writeFile('aaa/test.bin', 10);
    writeFile('zzz/test.bin', 10);
    writeFile('mmm/test.bin', 99);

    expect(bucketedDirUsage(root).buckets.map(b => b.name)).toEqual(['mmm', 'aaa', 'zzz']);
  });
});

describe('bucketedDirUsage — depth bound is reported, not hidden', () => {
  it('flags depthLimited instead of passing off a bounded walk as exact', () => {
    // workspace/repo/src/index.ts is a file at depth 4: with maxDepth 3 the `src`
    // directory (depth 3) is pruned. Old code silently dropped those bytes,
    // which is how workspace/ displayed 109 MB against 309 MB on disk.
    writeFile('workspace/repo/src/index.ts', 100);

    const shallow = bucketedDirUsage(root, { maxDepth: 3 });
    expect(shallow.total).toBe(0);
    expect(shallow.depthLimited).toBe(true);

    const deep = bucketedDirUsage(root, { maxDepth: 12 });
    expect(deep.depthLimited).toBe(false);
    expect(deep.total).toBe(100);
  });

  it('counts a file at the cap but prunes a directory at the cap', () => {
    // Getting this backwards would make every repository look empty: `repo` is a
    // directory at depth 2 (descended) and `nested` a directory at depth 3 (the
    // cap, pruned), while `c.bin` is a file at depth 3 and is a leaf, so it counts.
    writeFile('workspace/repo/c.bin', 42);
    writeFile('workspace/repo/nested/deep.bin', 7);

    const usage = bucketedDirUsage(root, { maxDepth: 3 });

    expect(usage.total).toBe(42);
    expect(usage.depthLimited).toBe(true);
  });

  it('defaults to a depth that does not regress the number it replaces', () => {
    // The default cap is 4, not 3, because the replaced code walked each
    // subdirectory from that subdirectory as depth 0. Verified on a live agent:
    // maxDepth 4 measures the `workspace` bucket at 109.0 MB — the exact figure
    // the old code displayed — while maxDepth 3 measures 102.8 MB and would have
    // quietly made the number worse than the bug it replaced.
    writeFile('workspace/repo/src/index.ts', 100);

    expect(bucketedDirUsage(root).depthLimited).toBe(false);
    expect(bucketedDirUsage(root).total).toBe(100);
  });

  it('does not flag depthLimited when nothing was pruned', () => {
    writeFile('workspace/a.bin', 5);
    expect(bucketedDirUsage(root).depthLimited).toBe(false);
  });
});

describe('bucketedDirUsage — symlinks', () => {
  it('does not follow a symlinked directory (double counting, then cycles)', () => {
    // The bug this prevents: statSync follows symlinks, so a symlinked dir was
    // walked — counting another agent's bytes against this agent, and looping
    // forever on a cycle.
    writeFile('workspace/real.bin', 100);
    writeFile('other/foreign.bin', 400);
    symlinkSync(join(root, 'other'), join(root, 'workspace', 'link-out'));
    symlinkSync(root, join(root, 'workspace', 'link-self'));

    const usage = bucketedDirUsage(root, { maxDepth: 10 });

    // 100 (workspace/real.bin) + 400 (other/foreign.bin). Neither the 400 gets
    // pulled in a second time through workspace/link-out, nor does link-self
    // recurse.
    expect(usage.total).toBe(500);
    expect(usage.symlinksSkipped).toBeGreaterThanOrEqual(2);
  });

  it('ignores .DS_Store', () => {
    writeFile('.DS_Store', 999);
    writeFile('workspace/a.bin', 10);

    const usage = bucketedDirUsage(root);

    expect(usage.total).toBe(10);
    expect(usage.buckets.map(b => b.name)).not.toContain('.DS_Store');
  });
});
