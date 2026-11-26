/**
 * 状态词表的 **locale 覆盖守卫**（Owner 2026-11-19 报：状态历史 / 需求状态切换里
 * 出现英文原值 `blocked`）。
 *
 * 根因：一个状态能被流转菜单切到（REQ_ALLOWED_TRANSITIONS 的目标集），却没有对应的
 * 翻译词条 → i18n 退回 key 本身（英文枚举值）。本测试把「菜单可达的状态集」与
 * 「三语词条」钉在一起：任一可达状态缺词条、或词条等于原始枚举值（=没翻译），即红。
 *
 * 徽章显示集已在 Work.tsx 里改为从同一份流转矩阵派生（REQ_DISPLAY_STATUSES），
 * 所以「有徽章」与「有词条」两侧都收敛到唯一来源，不再各自漂移。
 *
 * locale JSON 用**编译期 import**（resolveJsonModule），不用 import.meta.url + fs：
 * happy-dom 下 import.meta.url 是 http URL，fileURLToPath 会得到 `/packages/...`
 * 开头的假路径（已知坑④）。
 */
import { describe, it, expect } from 'vitest';
import { REQ_ALLOWED_TRANSITIONS, TASK_ALLOWED_TRANSITIONS } from '../constants/allowedTransitions.ts';
import zhWork from '../locales/zh-CN/work.json';
import enWork from '../locales/en/work.json';
import esWork from '../locales/es/work.json';

/** 流转矩阵里所有**可作为目标**的状态（= 切换菜单可能展示的全部值）。 */
const reachableTargets = (m: Record<string, ReadonlySet<string>>): string[] =>
  [...new Set(Object.values(m).flatMap(set => [...set]))];

type WorkBundle = { status: { task: Record<string, string>; requirement: Record<string, string> } };
const LOCALES: ReadonlyArray<readonly [string, WorkBundle]> = [
  ['zh-CN', zhWork],
  ['en', enWork],
  ['es', esWork],
];

describe('status label locale coverage — every switcher-reachable status is translated', () => {
  for (const [locale, work] of LOCALES) {
    it(`requirement: all reachable statuses have a translated label (${locale})`, () => {
      const labels = work.status.requirement;
      for (const s of reachableTargets(REQ_ALLOWED_TRANSITIONS)) {
        expect(labels[s], `work:status.requirement.${s} missing in ${locale}`).toBeTruthy();
        expect(labels[s], `work:status.requirement.${s} equals raw enum (untranslated) in ${locale}`).not.toBe(s);
      }
    });

    it(`task: all reachable statuses have a translated label (${locale})`, () => {
      const labels = work.status.task;
      for (const s of reachableTargets(TASK_ALLOWED_TRANSITIONS)) {
        expect(labels[s], `work:status.task.${s} missing in ${locale}`).toBeTruthy();
        expect(labels[s], `work:status.task.${s} equals raw enum (untranslated) in ${locale}`).not.toBe(s);
      }
    });
  }
});
