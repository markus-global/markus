/**
 * 单一写门禁测试（审计 P0-2 / 机制点 G1）
 * ---------------------------------------------------------------------------
 * 锁死两件事：
 *   1) 解析器能识别 `>` / `>>` / `tee` / `sed -i` / `dd of=` 的**写目标**，且不误判
 *      引号内的 `>`、fd 复制（`2>&1` / `>&2`）。
 *   2) 这些写目标会真的过同一道门：命中 denyWritePaths（其他 agent 工作区）或敏感
 *      文件即**拒绝**——这正是以前 shell 能绕过的路径。
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  assertWriteAllowed,
  assertShellWriteAllowed,
  extractShellWriteTargets,
  isUnderPath,
  matchedDenyWritePath,
} from '../src/write-guard.js';

const WORKSPACE = '/tmp/ws-self';
const OTHER_AGENT = '/tmp/agents/agt_other';

describe('extractShellWriteTargets 静态解析写目标', () => {
  it('识别 > 与 >> 重定向', () => {
    expect(extractShellWriteTargets('echo hi > /tmp/out.txt')).toEqual(['/tmp/out.txt']);
    expect(extractShellWriteTargets('echo hi >> out.txt')).toEqual(['out.txt']);
  });

  it('识别 tee（含 -a）', () => {
    expect(extractShellWriteTargets('cat a | tee out.log')).toEqual(['out.log']);
    expect(extractShellWriteTargets('cat a | tee -a out.log')).toEqual(['out.log']);
  });

  it('识别 sed -i 的文件参数（跳过脚本表达式）', () => {
    expect(extractShellWriteTargets("sed -i 's/a/b/' file.txt")).toEqual(['file.txt']);
    expect(extractShellWriteTargets('sed --in-place=s.bak -e "s/a/b/" file.txt')).toEqual(['file.txt']);
  });

  it('识别 dd of=', () => {
    expect(extractShellWriteTargets('dd if=/dev/zero of=/tmp/x bs=1')).toEqual(['/tmp/x']);
  });

  it('不把 fd 复制当文件目标（2>&1 / >&2）', () => {
    expect(extractShellWriteTargets('echo hi 2>&1')).toEqual([]);
    expect(extractShellWriteTargets('echo hi >&2')).toEqual([]);
  });

  it('不把引号内的 > 当重定向', () => {
    expect(extractShellWriteTargets('echo "a > b"')).toEqual([]);
    expect(extractShellWriteTargets("echo 'x >> y'")).toEqual([]);
  });

  it('普通命令无写目标', () => {
    expect(extractShellWriteTargets('npm run test')).toEqual([]);
    expect(extractShellWriteTargets('git status')).toEqual([]);
  });
});

describe('assertWriteAllowed 单一写门禁', () => {
  it('允许写自己的工作区', () => {
    const d = assertWriteAllowed(join(WORKSPACE, 'a.txt'));
    expect(d.allowed).toBe(true);
  });

  it('拒绝写其他 agent 工作区（denyWritePaths）', () => {
    const d = assertWriteAllowed(join(OTHER_AGENT, 'secret.txt'), {
      policy: { denyWritePaths: [OTHER_AGENT] },
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain("another agent's workspace");
  });

  it('拒绝写敏感系统文件', () => {
    const d = assertWriteAllowed('/etc/passwd');
    expect(d.allowed).toBe(false);
    const ssh = assertWriteAllowed(join('/home/u', '.ssh', 'id_rsa'));
    expect(ssh.allowed).toBe(false);
  });

  it('边界感知：同前缀的兄弟目录不被误伤', () => {
    expect(isUnderPath('/x/agt_ab/f', '/x/agt_a')).toBe(false);
    expect(isUnderPath('/x/agt_a/f', '/x/agt_a')).toBe(true);
    expect(matchedDenyWritePath('/x/agt_ab/f', ['/x/agt_a'])).toBeUndefined();
    expect(matchedDenyWritePath('/x/agt_a/f', ['/x/agt_a'])).toBe('/x/agt_a');
  });
});

describe('assertShellWriteAllowed 反向测试：shell 重定向必须受同一门禁', () => {
  const policy = { denyWritePaths: [OTHER_AGENT] };

  it('拒绝：> 重定向到其他 agent 工作区', () => {
    const d = assertShellWriteAllowed(`echo pwned > ${join(OTHER_AGENT, 'x.txt')}`, { policy });
    expect(d.allowed).toBe(false);
  });

  it('拒绝：>> 重定向到其他 agent 工作区', () => {
    const d = assertShellWriteAllowed(`echo pwned >> ${join(OTHER_AGENT, 'x.txt')}`, { policy });
    expect(d.allowed).toBe(false);
  });

  it('拒绝：tee 写入其他 agent 工作区', () => {
    const d = assertShellWriteAllowed(`cat /etc/hosts | tee ${join(OTHER_AGENT, 'x.txt')}`, { policy });
    expect(d.allowed).toBe(false);
  });

  it('拒绝：sed -i 改写其他 agent 工作区文件', () => {
    const d = assertShellWriteAllowed(`sed -i 's/a/b/' ${join(OTHER_AGENT, 'x.txt')}`, { policy });
    expect(d.allowed).toBe(false);
  });

  it('拒绝：dd of= 写入其他 agent 工作区', () => {
    const d = assertShellWriteAllowed(`dd if=/dev/zero of=${join(OTHER_AGENT, 'x.bin')}`, { policy });
    expect(d.allowed).toBe(false);
  });

  it('拒绝：重定向到敏感系统文件', () => {
    const d = assertShellWriteAllowed('echo x > /etc/passwd', { policy });
    expect(d.allowed).toBe(false);
  });

  it('允许：写自己的工作区（不误伤正常命令）', () => {
    const d = assertShellWriteAllowed(`echo hi > ${join(WORKSPACE, 'ok.txt')}`, {
      cwd: WORKSPACE,
      policy,
    });
    expect(d.allowed).toBe(true);
  });

  it('允许：无写目标的普通命令', () => {
    expect(assertShellWriteAllowed('npm run build', { policy }).allowed).toBe(true);
    expect(assertShellWriteAllowed('git status', { policy }).allowed).toBe(true);
  });

  it('相对路径按 cwd 解析后再判定', () => {
    const d = assertShellWriteAllowed('echo hi > x.txt', { cwd: OTHER_AGENT, policy });
    expect(d.allowed).toBe(false);
  });
});
