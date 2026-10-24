/**
 * Two ways an agent wastes a whole turn re-reading what it already has:
 *   1. it re-reads an unchanged file to "confirm" it,
 *   2. a big shell output was silently truncated, so it re-runs the command.
 *
 * Both fixes must stay RECOVERABLE: a dedupe that lies (content was compacted
 * away) or a pointer that cannot be read would be worse than the original waste.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReadTool, resetAllFileReadCaches } from '../src/tools/file.js';
import { withSpoolPointer } from '../src/tools/shell-session.js';

let dir: string;
let tool: ReturnType<typeof createFileReadTool>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-read-dedupe-'));
  // ONE instance per agent in production (`createBuiltinTools` runs at agent
  // construction), so the cache lives as long as the agent — not per call.
  tool = createFileReadTool();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = async (args: Record<string, unknown>) =>
  JSON.parse(await tool.execute({ ...args, path: join(dir, 'a.txt') }));

describe('file_read dedupe', () => {
  it('returns the content the first time and a stub the second time', async () => {
    writeFileSync(join(dir, 'a.txt'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));

    const first = await read({});
    expect(first.unchanged).toBeUndefined();
    expect(first.content).toContain('line 20');

    const second = await read({});
    expect(second.unchanged).toBe(true);
    expect(second.content).toBeUndefined();          // the payload is NOT re-sent
    expect(second.preview).toContain('line 1');       // but orientation is kept
  });

  it('re-sends when the file changed on disk', async () => {
    writeFileSync(join(dir, 'a.txt'), 'v1\n');
    await read({});
    writeFileSync(join(dir, 'a.txt'), 'v2\n');

    const again = await read({});
    expect(again.unchanged).toBeUndefined();
    expect(again.content).toContain('v2');
  });

  it('re-sends when a different line window is requested', async () => {
    writeFileSync(join(dir, 'a.txt'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));
    await read({ offset: 1, limit: 5 });

    const other = await read({ offset: 10, limit: 5 });
    expect(other.unchanged).toBeUndefined();
    expect(other.content).toContain('line 10');
  });

  it('force:true always re-sends — the escape hatch after a compaction', async () => {
    writeFileSync(join(dir, 'a.txt'), 'only line');
    await read({});

    const forced = await read({ force: true });
    expect(forced.unchanged).toBeUndefined();
    expect(forced.content).toContain('only line');
  });

  it('tells the agent how to recover if the copy is no longer in context', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x');
    await read({});
    const stub = await read({});
    expect(stub.hint).toContain('force: true');
  });

  it('resetAllFileReadCaches clears the memory after history was rewritten', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x');
    await read({});
    resetAllFileReadCaches();

    const afterReset = await read({});
    expect(afterReset.unchanged).toBeUndefined();
  });
});

describe('withSpoolPointer', () => {
  it('leaves a non-truncated output untouched', () => {
    expect(withSpoolPointer('hello', null, 5)).toBe('hello');
  });

  it('gives back the head, the size, and a readable path', () => {
    const spool = join(dir, 'full.log');
    writeFileSync(spool, 'HEAD-OF-OUTPUT\n' + 'x'.repeat(100_000));

    const out = withSpoolPointer('TAIL-OF-OUTPUT', spool, 100_000);

    expect(out).toContain('HEAD-OF-OUTPUT');          // the head is NOT lost
    expect(out).toContain('TAIL-OF-OUTPUT');          // the tail survives too
    expect(out).toContain(spool);                     // pointer to the full log
    expect(out).toMatch(/instead of re-running/);     // tells it not to re-run
  });

  it('still points at the file when the head cannot be re-read', () => {
    const out = withSpoolPointer('tail', join(dir, 'missing.log'), 90_000);
    expect(out).toContain('missing.log');
    expect(out).toContain('tail');
  });

  it('the file it points at really contains the full output', () => {
    const spool = join(dir, 'full.log');
    const body = 'A'.repeat(200_000);
    writeFileSync(spool, body);
    withSpoolPointer('tail', spool, body.length);
    expect(readFileSync(spool, 'utf8').length).toBe(body.length);
  });
});
