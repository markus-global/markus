import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildProbeSpawnSpec, probeDatabaseHealthInChild } from '../src/health-probe.js';

const dirs: string[] = [];
function tmpDb(name = 'p.db'): string {
  const d = mkdtempSync(join(tmpdir(), 'markus-probe-'));
  dirs.push(d);
  return join(d, name);
}
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('probe spawn spec', () => {
  it('runs the probe through ELECTRON_RUN_AS_NODE', () => {
    const spec = buildProbeSpawnSpec('/tmp/x.db', '/Applications/Markus.app/Contents/MacOS/Markus');
    // 打包后的 Electron 里 process.execPath 是主程序，不是 node；不带这个变量
    // 它会把 `-e` 当 GUI 启动 —— 零输出、退出码 0 —— 探针永远 unknown。
    expect(spec.options.env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(spec.command).toBe('/Applications/Markus.app/Contents/MacOS/Markus');
    expect(spec.args[0]).toBe('-e');
    expect(spec.args[spec.args.length - 1]).toBe('/tmp/x.db');
  });

  it('keeps the caller env intact', () => {
    const spec = buildProbeSpawnSpec('/tmp/x.db', '/usr/bin/node', { PATH: '/usr/bin', FOO: 'bar' });
    expect(spec.options.env['PATH']).toBe('/usr/bin');
    expect(spec.options.env['FOO']).toBe('bar');
    expect(spec.options.env['ELECTRON_RUN_AS_NODE']).toBe('1');
  });
});

describe('probe verdicts', () => {
  it('reports ok for a healthy database', async () => {
    const p = tmpDb();
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    db.close();

    const r = await probeDatabaseHealthInChild(p, 20_000);
    expect(r.status).toBe('ok');
  });

  it('reports a verdict (not silence) for a file that is not a database', async () => {
    const p = tmpDb('junk.db');
    writeFileSync(p, 'this is definitely not a sqlite file'.repeat(200));

    const r = await probeDatabaseHealthInChild(p, 20_000);
    // 关键不是 ok/corrupt 的具体归属，而是**它必须给出结论**：
    // 'no output' 会让调用方以为"探针不可用"，从而永久跳过修复。
    expect(r.status).not.toBe('unknown');
    expect(String(r.detail ?? '') + r.status).toMatch(/corrupt|ERR|malformed|not a database/i);
  });
});
