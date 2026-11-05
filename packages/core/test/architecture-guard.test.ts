/**
 * architecture-guard 自测（P1-6 / D-MB-10）
 * ---------------------------------------------------------------------------
 * 门禁本身也必须有测试：否则规则写错（误报/漏报）没人知道，等于没有门禁。
 * 这里用 `MARKUS_GUARD_ROOT` 指向临时夹具目录，直接跑 `scripts/architecture-guard.mjs`，
 * 断言：
 *   1) 违规夹具（agent 私有 bus 事件被订阅但未登记白名单）→ 门禁失败(event-reachability)；
 *   2) 登记后 → 门禁通过；
 *   3) shell 工具未接入写门禁 → 门禁失败(write-gate)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const GUARD = resolve(process.cwd(), 'scripts/architecture-guard.mjs');

function writeFixture(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function runGuard(root: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', [GUARD], {
      env: { ...process.env, MARKUS_GUARD_ROOT: root },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-guard-fixture-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('architecture-guard · event-reachability（P1-6）', () => {
  it('agent 私有 bus 事件被外部订阅但未登记白名单 → 门禁失败', () => {
    const root = mkdtempSync(join(tmpdir(), 'markus-guard-neg-'));
    writeFixture(
      root,
      'packages/core/src/agent-manager.ts',
      "export const AGENT_FORWARDED_EVENTS = ['agent:started'] as const;\n",
    );
    writeFixture(
      root,
      'packages/core/src/agent.ts',
      "export function f(bus: { emit: (e: string, p: unknown) => void }) { bus.emit('agent:incomplete', {}); }\n",
    );
    writeFixture(
      root,
      'packages/cli/src/start.ts',
      "export function g(bus: { on: (e: string, fn: () => void) => void }) { bus.on('agent:incomplete', () => {}); }\n",
    );

    const res = runGuard(root);
    expect(res.ok).toBe(false);
    expect(res.out).toContain('event-reachability');
    expect(res.out).toContain('agent:incomplete');
    rmSync(root, { recursive: true, force: true });
  });

  it('事件登记进白名单后 → 门禁通过', () => {
    const root = mkdtempSync(join(tmpdir(), 'markus-guard-pos-'));
    writeFixture(
      root,
      'packages/core/src/agent-manager.ts',
      "export const AGENT_FORWARDED_EVENTS = ['agent:started', 'agent:incomplete'] as const;\n",
    );
    writeFixture(
      root,
      'packages/core/src/agent.ts',
      "export function f(bus: { emit: (e: string, p: unknown) => void }) { bus.emit('agent:incomplete', {}); }\n",
    );
    writeFixture(
      root,
      'packages/cli/src/start.ts',
      "export function g(bus: { on: (e: string, fn: () => void) => void }) { bus.on('agent:incomplete', () => {}); }\n",
    );

    const res = runGuard(root);
    expect(res.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('通用 EventEmitter 事件（error/close）不误报', () => {
    const root = mkdtempSync(join(tmpdir(), 'markus-guard-generic-'));
    writeFixture(
      root,
      'packages/core/src/agent-manager.ts',
      "export const AGENT_FORWARDED_EVENTS = ['agent:started'] as const;\n",
    );
    writeFixture(
      root,
      'packages/core/src/agent.ts',
      "export function f(p: { emit: (e: string, x?: unknown) => void }) { p.emit('error', new Error('x')); }\n",
    );
    writeFixture(
      root,
      'packages/cli/src/start.ts',
      "export function g(p: { on: (e: string, fn: () => void) => void }) { p.on('error', () => {}); }\n",
    );

    const res = runGuard(root);
    expect(res.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('architecture-guard · write-gate（P1-6 / G1）', () => {
  it('shell 工具未接入 assertShellWriteAllowed → 门禁失败', () => {
    const root = mkdtempSync(join(tmpdir(), 'markus-guard-write-'));
    writeFixture(
      root,
      'packages/core/src/tools/shell.ts',
      'export function createShellTool() { return { name: "shell_execute" }; }\n',
    );

    const res = runGuard(root);
    expect(res.ok).toBe(false);
    expect(res.out).toContain('write-gate');
    rmSync(root, { recursive: true, force: true });
  });

  it('shell 工具接入写门禁后 → 通过', () => {
    const root = mkdtempSync(join(tmpdir(), 'markus-guard-write-pos-'));
    writeFixture(
      root,
      'packages/core/src/tools/shell.ts',
      'export function createShellTool() { const c = assertShellWriteAllowed(cmd); return c; }\n',
    );

    const res = runGuard(root);
    expect(res.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
