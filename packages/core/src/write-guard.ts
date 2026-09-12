/**
 * 单一写门禁（Write Guard）
 * ---------------------------------------------------------------------------
 * 审计 P0-2 / 机制点 G1：此前「写盘」约束只在 `file_write` / `file_edit` /
 * `apply_patch` 三条路径上生效；`shell_execute` 用 `>`/`>>`/`tee`/`sed -i`/`dd of=`
 * 等重定向可写任意路径（含其他 agent 工作区、系统敏感文件），完全绕过门禁。
 * 「File editing discipline」以前只是一句提示词。
 *
 * 这里把判定收口到一处：
 *   - `assertWriteAllowed()`      —— 给定路径 → 是否允许写（denyWritePaths + 敏感文件）
 *   - `extractShellWriteTargets()`—— 静态解析 shell 命令里的**写目标**（不执行命令）
 *   - `assertShellWriteAllowed()` —— shell_execute 专用：解析后逐目标过同一道门
 *
 * 设计取舍：
 *   - 解析是**保守启发式**（不追求完整 shell 语法），但只要命令里出现写重定向/tee/sed -i/dd of=，
 *     其目标就会被检查；漏判（例如 `bash -c "..."` 里再嵌套）是已知残余风险，见文档。
 *   - 只在目标命中 denyWritePaths / 敏感文件时才拒绝 —— 因此即使解析误判，也不会误伤正常写入。
 *   - 边界感知匹配（`p === d || p.startsWith(d + '/')`），避免 `/agents/agt_a` 误伤 `/agents/agt_ab`。
 */
import { resolve, sep } from 'node:path';
import type { PathAccessPolicy } from '@markus/shared';

export interface WriteAllowed {
  allowed: true;
}
export interface WriteDenied {
  allowed: false;
  reason: string;
  /** 触发拒绝的绝对路径 */
  matchedPath: string;
}
export type WriteDecision = WriteAllowed | WriteDenied;

/** 写入时显式拒绝的敏感系统路径（读路径另有 security.ts 的 denylist，此处面向写）。 */
export const SENSITIVE_WRITE_DENY = [
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/.ssh/',
  '/id_rsa',
  '/id_ed25519',
];

/** 路径 p 是否落在目录 d 下（边界感知，避免同前缀目录误伤）。 */
export function isUnderPath(p: string, d: string): boolean {
  if (p === d) return true;
  const base = d.endsWith(sep) ? d : d + sep;
  return p.startsWith(base);
}

/** 判断解析后的绝对路径是否被 denyWritePaths 命中；返回命中的 deny 目录或 undefined。 */
export function matchedDenyWritePath(resolved: string, denyWritePaths?: string[]): string | undefined {
  if (!denyWritePaths?.length) return undefined;
  for (const denied of denyWritePaths) {
    if (isUnderPath(resolved, resolve(denied))) return resolve(denied);
  }
  return undefined;
}

/**
 * 单一写门禁：给一个（原始或已解析的）路径，判定是否允许写。
 * `workspacePath` 提供时，相对路径按其解析（保持与 file 工具历史行为一致）。
 */
export function assertWriteAllowed(
  rawPath: string,
  opts: { workspacePath?: string; policy?: PathAccessPolicy } = {},
): WriteDecision {
  const resolved = opts.workspacePath ? resolve(opts.workspacePath, rawPath) : resolve(rawPath);

  const deniedDir = matchedDenyWritePath(resolved, opts.policy?.denyWritePaths);
  if (deniedDir) {
    return {
      allowed: false,
      matchedPath: resolved,
      reason:
        "Write denied: this path belongs to another agent's workspace. " +
        'Create your own worktree or copy the files to your workspace.',
    };
  }

  for (const sensitive of SENSITIVE_WRITE_DENY) {
    if (resolved.includes(sensitive)) {
      return {
        allowed: false,
        matchedPath: resolved,
        reason: `Write denied: sensitive path (${sensitive})`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 把 shell 命令切成 token（尊重单/双引号与反斜杠转义），并把 `>`/`>>`/`>|`/`|`/`;` 作为独立 token。
 * 仅为解析写目标服务，不追求完整 shell 语义。
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = () => {
    if (started) {
      tokens.push(cur);
      cur = '';
      started = false;
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += command[++i] ?? '';
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '\\') {
      cur += command[++i] ?? '';
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === '>') {
      flush();
      if (command[i + 1] === '>') {
        tokens.push('>>');
        i++;
      } else if (command[i + 1] === '|') {
        tokens.push('>|');
        i++;
      } else {
        tokens.push('>');
      }
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&') {
      flush();
      tokens.push(ch);
      continue;
    }
    cur += ch;
    started = true;
  }
  flush();
  return tokens;
}

const REDIRECT_OPS = new Set(['>', '>>', '>|']);
const SEPARATORS = new Set(['|', ';', '&', '>', '>>', '>|']);

/**
 * 静态解析 shell 命令中「往文件写」的目标路径（不做任何执行）。
 * 覆盖：`>` / `>>` / `>|` 重定向、`tee [-a]`、`sed -i`/`--in-place`、`dd of=`。
 * 跳过 fd 复制（`2>&1`、`>&2`）与 `-` 之类的非文件参数。
 */
export function extractShellWriteTargets(command: string): string[] {
  const tokens = tokenizeCommand(command);
  const targets: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    if (REDIRECT_OPS.has(t)) {
      const next = tokens[i + 1];
      if (next && !next.startsWith('&')) targets.push(next);
      i++;
      continue;
    }

    if (t === 'tee') {
      for (let j = i + 1; j < tokens.length; j++) {
        const a = tokens[j]!;
        if (SEPARATORS.has(a)) break;
        if (a.startsWith('-') || a === '-') continue;
        targets.push(a);
      }
      continue;
    }

    if (t === 'sed') {
      let inPlace = false;
      const positional: string[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        const a = tokens[j]!;
        if (SEPARATORS.has(a)) break;
        if (a === '-i' || a.startsWith('-i.') || a === '--in-place' || a.startsWith('--in-place=')) {
          inPlace = true;
        } else if (!a.startsWith('-')) {
          positional.push(a);
        }
      }
      // sed 的首个位置参数是脚本表达式，之后的才是文件
      if (inPlace) targets.push(...positional.slice(1));
      continue;
    }
  }

  // dd of=<path>（可在任意位置，token 化后为 `dd`/`of=...`）
  const ddOf = /\bof=("[^"]*"|'[^']*'|[^\s|;&>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = ddOf.exec(command)) !== null) {
    targets.push(m[1]!.replace(/^["']|["']$/g, ''));
  }

  return targets;
}

/**
 * shell_execute 专用门禁：解析命令写目标并逐个过 `assertWriteAllowed`。
 * `cwd` 用于解析相对路径（默认取 workspacePath，再退回进程 cwd）。
 */
export function assertShellWriteAllowed(
  command: string,
  opts: { cwd?: string; workspacePath?: string; policy?: PathAccessPolicy } = {},
): WriteDecision {
  const targets = extractShellWriteTargets(command);
  if (targets.length === 0) return { allowed: true };

  const base = opts.cwd ?? opts.workspacePath ?? process.cwd();
  for (const target of targets) {
    const resolved = resolve(base, target);
    const decision = assertWriteAllowed(resolved, { policy: opts.policy });
    if (!decision.allowed) {
      return {
        allowed: false,
        matchedPath: resolved,
        reason: `Shell write target denied (${target}): ${decision.reason}`,
      };
    }
  }
  return { allowed: true };
}
