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

/**
 * 终态谓词门禁（P3 / tsk_1e766b22）
 *
 * 这一组测试就是卡面要求的「红/绿双态证据 + 不误伤证据」，只是把一次性验证固化成回归：
 *   - 终态裸比较 → 必须红（漏报等于没门禁）
 *   - 非终态比较（running/in_progress/blocked/review）→ 必须**放行**（误伤等于错门禁）
 *   - isTerminal() / 注释里的示例代码 / 属它域的豁免文件 → 必须放行
 *   - 基线只能缩小：比基线多 → 红；比基线少 → 也红（否则存量永不下降）
 */
describe('architecture-guard · terminal-status-predicate（P3）', () => {
  const PROBE = 'packages/core/src/probe.ts';

  function runWithProbe(source: string, baseline?: unknown): { ok: boolean; out: string } {
    const root = mkdtempSync(join(tmpdir(), 'markus-guard-terminal-'));
    writeFixture(root, PROBE, source);
    if (baseline !== undefined) {
      writeFixture(root, 'scripts/terminal-status-baseline.json', JSON.stringify(baseline));
    }
    const res = runGuard(root);
    rmSync(root, { recursive: true, force: true });
    return res;
  }

  it('终态裸比较（===）→ 门禁失败，并指向 isTerminal', () => {
    const res = runWithProbe("export function f(status: string) { return status === 'completed'; }\n");
    expect(res.ok).toBe(false);
    expect(res.out).toContain('终态谓词门禁失败');
    expect(res.out).toContain('isTerminal(status)');
    expect(res.out).toContain(PROBE);
  });

  it('终态裸比较（!== / 反向书写 / 内联终态数组）→ 全部失败', () => {
    for (const source of [
      "export function f(status: string) { return status !== 'archived'; }\n",
      "export function f(status: string) { return 'rejected' === status; }\n",
      "export function f(status: string) { return ['completed', 'archived'].includes(status); }\n",
    ]) {
      const res = runWithProbe(source);
      expect(res.ok, source).toBe(false);
      expect(res.out).toContain('终态谓词门禁失败');
    }
  });

  it('非终态比较（running / in_progress / blocked / review）→ 放行（不误伤）', () => {
    const res = runWithProbe(
      "export function f(status: string) { return status === 'running' || status === 'in_progress' || status === 'blocked' || status === 'review'; }\n",
    );
    expect(res.ok).toBe(true);
  });

  it('isTerminal() 与注释里的示例代码 → 放行', () => {
    const res = runWithProbe(
      [
        "import { isTerminal } from '@markus/shared';",
        "// 反例（历史写法）：status === 'completed' —— 已收口到 isTerminal()",
        '/* 同样：if (status === "failed") { ... } */',
        'export function f(status: string) { return isTerminal(status); }',
        '',
      ].join('\n'),
    );
    expect(res.ok).toBe(true);
  });

  it('属其它域的豁免文件（mailbox item 状态）→ 放行', () => {
    const root = mkdtempSync(join(tmpdir(), 'markus-guard-terminal-exempt-'));
    writeFixture(root, 'packages/core/src/mailbox.ts', "export function f(status: string) { return status === 'completed'; }\n");
    const res = runGuard(root);
    rmSync(root, { recursive: true, force: true });
    expect(res.ok).toBe(true);
  });

  it('基线棘轮：现状比基线多 → 失败；比基线少 → 也失败（要求删条目）', () => {
    const source = "export function f(status: string) { return status === 'completed'; }\n";
    const okBaseline = { version: 1, files: { [PROBE]: { count: 1, why: '这是测试夹具里登记过的具体状态判断' } } };
    expect(runWithProbe(source, okBaseline).ok).toBe(true);

    const tooTight = { version: 1, files: { [PROBE]: { count: 0, why: '故意写小，验证新增必红' } } };
    const grown = runWithProbe(source, tooTight);
    expect(grown.ok).toBe(false);
    expect(grown.out).toContain('终态谓词门禁失败');

    const tooLoose = { version: 1, files: { [PROBE]: { count: 3, why: '故意写大，验证存量未清理必红' } } };
    const shrank = runWithProbe(source, tooLoose);
    expect(shrank.ok).toBe(false);
    expect(shrank.out).toContain('基线只允许缩小');
  });

  it('基线缺 why → 失败（豁免必须解释它回答的是哪个问题）', () => {
    const res = runWithProbe("export function f(status: string) { return status === 'completed'; }\n", {
      version: 1,
      files: { [PROBE]: { count: 1, why: '' } },
    });
    expect(res.ok).toBe(false);
    expect(res.out).toContain('why');
  });
});
