/**
 * A3 · 全仓扫描：被删除的状态词命名空间不得回来，裸 stage 字面值不得回来。
 *
 * 为什么这里必须是「扫源码」而不是行为测试：i18n key 在 TypeScript 里**没有类型**。
 * `t('common:status.review')` 在键被删掉之后依然编译通过，只是运行期静默回落成
 * 原始英文；`stage === 'idle'` 在值改名之后也照样编译通过（stage 在 web-ui 一侧是
 * `string`），只是永远不成立。这两类错误没有任何运行时症状，只会表现为「某些文案
 * 突然变成英文」或「某个分组永远空着」——只有扫描能提前拦住。
 *
 * 判据（可执行）：这两个模式在 `packages/web-ui/src` 内命中数必须为 0（注释不算）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(abs);
  }
  return out;
}

/** 去掉注释：历史说明里允许出现旧名字（而且应该出现，否则下一个人不知道它被删过）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const abs of walk(srcDir)) {
    const code = stripComments(readFileSync(abs, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${relative(srcDir, abs)}:${i + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

describe('A3 · 死掉的命名空间不得复活', () => {
  it('`common:status.*` 已被拆成 taskStatus / processStatus——代码里不得再引用', () => {
    // 该命名空间混装两件事实（治理态 + 进程态），并让「空闲」同时表示
    // 「agent 进程空闲」与「流空闲」。拆分见 state-machines.md §16.2。
    expect(offenders(/common:status\./)).toEqual([]);
  });

  it('stage 的裸值 `idle` / `working` 已被命名空间化——不得再被当作 stage 比较', () => {
    // 它们现在叫 `none:idle` / `agent:working`，与 AttentionState 的 idle/working
    // 在类型上互斥。裸值比较一旦回来，就说明有人又用「一个字面两个概念」在写判断。
    expect(
      offenders(/stage\s*[!=]==\s*['"](idle|working)['"]/),
    ).toEqual([]);
  });

  it('治理态词表只有一处定义：`common:taskStatus` 在 locale 里存在且在 agent 命名空间里没有副本', () => {
    const locales = join(srcDir, 'locales');
    for (const locale of readdirSync(locales)) {
      const common = JSON.parse(readFileSync(join(locales, locale, 'common.json'), 'utf8')) as Record<string, unknown>;
      const agent = JSON.parse(readFileSync(join(locales, locale, 'agent.json'), 'utf8')) as Record<string, unknown>;
      expect(common['taskStatus'], `${locale}: common:taskStatus 缺失`).toBeTruthy();
      expect(common['processStatus'], `${locale}: common:processStatus 缺失`).toBeTruthy();
      expect(common['status'], `${locale}: 旧的 common:status 命名空间还在`).toBeUndefined();
      // 重复词表曾在这里长出来（review = 评审中 vs 待审核）。
      const profile = (agent['profilePage'] ?? {}) as Record<string, unknown>;
      expect(profile['taskStatus'], `${locale}: agent:profilePage.taskStatus 重复词表还在`).toBeUndefined();
    }
  });

  it('词表只有一处入口：`stateVocabulary.ts` 之外不得自己拼 taskStatus / attention 的 i18n key', () => {
    // 「词表唯一」有两种破法：① 另建一张表（上一条已挡）；② 表还在，但调用点自己拼 key
    // 并自带一份枚举映射——后者不会撞词（最终仍落到同一张表），所以撞词不变量抓不到它，
    // 只能靠扫描。曾经有三处：AgentProfile（attention）、NotificationBell（taskStatus +
    // 自带 camel 映射）、Work（taskStatus + 自带 in_progress→inProgress 映射）。
    const owner = 'lib/stateVocabulary.ts';
    const hits: string[] = [];
    for (const abs of walk(srcDir)) {
      const rel = relative(srcDir, abs).replace(/\\/g, '/');
      if (rel === owner) continue;
      stripComments(readFileSync(abs, 'utf8')).split('\n').forEach((line, i) => {
        if (
          /`(common:taskStatus|agent:profilePage\.mind\.attention)\.\$\{/.test(line) ||
          /['"](common:taskStatus|agent:profilePage\.mind\.attention)\./.test(line)
        ) {
          hits.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
