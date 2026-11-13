/**
 * 架构守卫：投递状态机的**唯一落库面**（FSM-2 的结构性执行点）。
 * ---------------------------------------------------------------------------
 * 为什么需要一条源码结构守卫，而不是行为用例就够：
 * 行为用例只能证明「我走过的路径是合法的」，它发现不了**第 15 处新增旁路**——
 * 新写一个 `this.persistence?.updateStatus(id, 'completed')` 不会让任何既有用例变红。
 * C3 第一次提交就是这个形态：矩阵建好了、退信走矩阵，其余 14 处状态迁移仍各写各的。
 *
 * 守卫的规则（不是「禁止某段文本」，而是「只允许两个具名写口」）：
 *   1. 全文件只允许 **2** 处 `persistence.updateStatus(` 落库调用；
 *   2. 这两处必须分别在 `updateSignalStatus()`（迁移，矩阵裁决）与
 *      `updateFields()`（同状态字段写，不迁移）的方法体内；
 *   3. 任何第三处 = 绕过矩阵 = 判红。
 *
 * **门禁本身也有测试**：`findSinks()` 的检测逻辑用合成源码自测（正例 / 反例 / 注释忽略），
 * 否则规则写错（误报或漏报）没人知道 —— 等于没有门禁。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(process.cwd(), 'packages/core/src/mailbox.ts');

/** 类成员声明（2 空格缩进）：把每一行归到它所属的方法名下。 */
const METHOD_DECL = /^ {2}(?:private |public |protected |static )*(?:async )?([A-Za-z_$][\w$]*)\s*[<(]/;

/** 落库调用（不是注释里的说明文字）。 */
const SINK_CALL = /persistence\?\.updateStatus\(|p\.updateStatus\?\.\(/;

export interface Sink {
  method: string;
  lineNo: number;
  text: string;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * 检测器（纯函数，便于自测）。
 *
 * 归属判定用「最近一个 2 空格缩进的成员声明」：本仓 mailbox.ts 的方法体内部全部缩进
 * ≥4 空格，所以这个近似对当前代码是精确的；若哪天类结构变了，下面的自测会先红。
 */
export function findSinks(source: string): Sink[] {
  const lines = source.split('\n');
  const owner = ownersByLine(source);
  return lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => SINK_CALL.test(line) && !isCommentLine(line))
    .map(({ line, i }) => ({ method: owner[i]!, lineNo: i + 1, text: line.trim() }));
}

/** 每一行所属的方法名（最近一个 2 空格缩进的成员声明）。 */
export function ownersByLine(source: string): string[] {
  const owner: string[] = [];
  let current = '<top-level>';
  for (const line of source.split('\n')) {
    const m = METHOD_DECL.exec(line);
    if (m) current = m[1]!;
    owner.push(current);
  }
  return owner;
}

function methodBody(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex(l => new RegExp(`^ {2}(?:private |public )*${name}\\(`).test(l));
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length && !METHOD_DECL.test(lines[end]!)) end++;
  return lines.slice(start, end).join('\n');
}

const ALLOWED = new Set(['updateSignalStatus', 'updateFields']);

/**
 * **投影**方法的白名单：这些名字里允许直接写 `item.status`，但它们不写库。
 *
 * 两类来源，两类理由：
 *  - `projectBounced`：行**从未落库**（幂等抑制），改的是返回值；
 *  - `projectClaimed` / `projectRequeued`：**原子端口已在 DB 完成迁移**
 *    （`claimItem` / `requeueItem` 的 SQL 本身就是矩阵边），这里只把内存副本对齐。
 *
 * 守卫要求这三个名字必须存在且各自只做内存对齐（下一个用例断言它们不调 persistence）。
 */
const PROJECTIONS = new Set(['projectBounced', 'projectClaimed', 'projectRequeued']);

describe('架构守卫 · 检测器自测（门禁本身必须可被判错）', () => {
  it('两个具名写口 → 全部合法', () => {
    const src = [
      'class X {',
      '  private updateSignalStatus(',
      '    this.persistence?.updateStatus(a, b);',
      '  }',
      '  private updateFields(i, f) {',
      '    this.persistence?.updateStatus(i.id, i.status, f);',
      '  }',
      '}',
    ].join('\n');
    const sinks = findSinks(src);
    expect(sinks).toHaveLength(2);
    expect(sinks.every(s => ALLOWED.has(s.method))).toBe(true);
  });

  it('新增第三处旁路 → 被归到别的方法名下（判红依据）', () => {
    const src = [
      'class X {',
      '  private updateSignalStatus(',
      '    this.persistence?.updateStatus(a, b);',
      '  }',
      '  private updateFields(i, f) {',
      '    this.persistence?.updateStatus(i.id, i.status, f);',
      '  }',
      '  private complete(id) {',
      "    this.persistence?.updateStatus(id, 'completed');",
      '  }',
      '}',
    ].join('\n');
    const sinks = findSinks(src);
    expect(sinks).toHaveLength(3);
    const illegal = sinks.filter(s => !ALLOWED.has(s.method));
    expect(illegal.map(s => s.method)).toEqual(['complete']);
  });

  it('注释里出现同名调用 → 不误报', () => {
    const src = [
      'class X {',
      '  private foo() {',
      '    // 旧实现是 p.updateStatus?.(id, "queued")，已废弃',
      '  }',
      '}',
    ].join('\n');
    expect(findSinks(src)).toEqual([]);
  });
});

describe('架构守卫 · mailbox.ts 实际形态', () => {
  const source = readFileSync(SRC, 'utf-8');
  const sinks = findSinks(source);

  it('全文件恰好 2 处 persistence.updateStatus 落库调用', () => {
    // 数量本身也是契约：0 处意味着写口被搬走或删空，>2 意味着有人开了后门。
    expect(sinks.map(s => `${s.lineNo}:${s.method}`)).toHaveLength(2);
  });

  it('两处分别落在 updateSignalStatus()（迁移）与 updateFields()（同状态字段写）', () => {
    expect(sinks.map(s => s.method).sort()).toEqual(['updateFields', 'updateSignalStatus']);
  });

  it('不存在第三处旁路', () => {
    const illegal = sinks.filter(s => !ALLOWED.has(s.method));
    expect(illegal.map(s => `${s.lineNo} in ${s.method}`)).toEqual([]);
  });

  it('updateSignalStatus 内必须先过 canTransitionSignal（矩阵是判据，不是装饰）', () => {
    const body = methodBody(source, 'updateSignalStatus');
    expect(body).toContain('canTransitionSignal');
    // 不可拆的三件事：矩阵校验 / 退信必带原因 / 归集必带桶，都在同一个执行点里
    expect(body).toContain('isBounceReason');
    expect(body).toContain('bounceTarget');
  });

  it('updateFields 不接收状态参数（结构上不可能迁移）', () => {
    const lines = source.split('\n');
    const decl = lines.find(l => /^ {2}private updateFields\(/.test(l));
    expect(decl).toBeDefined();
    expect(decl!).not.toMatch(/MailboxItemStatus/);
    // 落库时状态取自 item（原样写回），不是调用方传进来的目标态
    const idx = lines.indexOf(decl!);
    expect(lines[idx + 1]).toContain('item.status');
  });

  it('投影方法只改内存副本，不写库（否则它就是第三个写口）', () => {
    for (const name of PROJECTIONS) {
      const body = methodBody(source, name);
      expect(body, `${name} 必须存在`).not.toBe('');
      expect(body, `${name} 不得调用 persistence`).not.toContain('persistence');
    }
  });

  it('所有状态直写都在具名写法里（迁移 / 投影），无其它旁路', () => {
    // 内存副本的 status 只允许在两个地方被赋值：
    //  - `updateSignalStatus`：矩阵裁决通过后设 `next.status = to`（真迁移）；
    //  - `projectBounced`：**未落库**行的返回值投影（不迁移任何已存在行）。
    // 其余任何 `item.status = '<终态>'` 都是绕过执行点的第三类旁路。
    const owner = ownersByLine(source);
    const ASSIGN = /\.status\s*=\s*'(completed|merged|bounced|catch_all|deferred|queued|processing)'/;
    const directWrites = source
      .split('\n')
      .map((l, i) => ({ l: l.trim(), i: i + 1, owner: owner[i]! }))
      .filter(({ l }) => !isCommentLine(l) && ASSIGN.test(l))
      .filter(({ owner: o }) => !PROJECTIONS.has(o) && o !== 'updateSignalStatus');
    expect(directWrites.map(w => `${w.i} in ${w.owner}: ${w.l}`)).toEqual([]);
  });
});
