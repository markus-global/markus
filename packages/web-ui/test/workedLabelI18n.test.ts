/**
 * 「已工作 N 秒」文案的国际化回归护栏。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────────
 * 这一行曾原样显示成 `execution.workedForMinutes`。根因**不在语言包** ——
 * en / zh-CN / es 三份 common.json 都有这个 key（下面有 parity 断言钉住）。
 * 真正的根因在 react-i18next 的绑定规则（useTranslation.js:76）：
 *
 *     getFixedT(lng, nsMode === 'fallback' ? namespaces : namespaces[0])
 *
 * 即 `useTranslation(['team','common'])` 里的 `t` **只查 namespaces[0] = 'team'**，
 * 于是只在 common 里的 `execution.*` 找不到 → i18next 回退到 key 本身。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────────────
 * 原来这份断言长在 ChatComponents.test.ts 里，用的是「回显 key」的假 `t`，断言的
 * 就是 key 字符串本身 —— 无论语言包里有没有这个 key，测试都是绿的。这个文件改用
 * **真实语言包 + 复刻真实的绑定公式**，正是为了堵住那个盲区：
 * 如果谁把 formatWorkedFor 里的 `common:` 前缀去掉，或用回团队命名的 ns，
 * 这里的第一个用例会立刻红。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';

import enCommon from '../src/locales/en/common.json';
import zhCommon from '../src/locales/zh-CN/common.json';
import esCommon from '../src/locales/es/common.json';
import appI18n from '../src/i18n';

type FormatWorkedFor = (ms: number, t: unknown) => string;

/** 复刻 react-i18next 的绑定公式，才能重现线上条件（默认 nsMode='default'）。 */
const bindLikeReactI18next = (
  i18n: typeof i18next,
  lng: string,
  namespaces: string[],
  nsMode: string,
) => i18n.getFixedT(lng, nsMode === 'fallback' ? namespaces : namespaces[0]) as never;

describe('formatWorkedFor — 真实语言包解析（防「渲染成 key」）', () => {
  let formatWorkedFor: FormatWorkedFor;
  let i18n: typeof i18next;

  beforeAll(async () => {
    ({ formatWorkedFor } = (await import('../src/pages/ChatComponents.tsx')) as unknown as {
      formatWorkedFor: FormatWorkedFor;
    });
    i18n = i18next.createInstance();
    await i18n.init({
      resources: {
        en: { common: enCommon },
        'zh-CN': { common: zhCommon },
        es: { common: esCommon },
      },
      lng: 'zh-CN',
      fallbackLng: 'en',
      defaultNS: 'common',
      ns: ['team', 'common'],
      interpolation: { escapeValue: false },
      initImmediate: false,
    });
  });

  it('线上实际条件（t 只绑到 team，即旧 bug 的触发条件）下，也必须翻译出来', () => {
    // 这正是 AgentMessageBody 的 useTranslation(['team','common']) 在 nsMode='default'
    // 下产生的东西 —— 旧代码就是被这个 t 喂进来的。
    const teamBoundT = bindLikeReactI18next(i18n, 'zh-CN', ['team', 'common'], 'default');
    expect(formatWorkedFor(45_400, teamBoundT)).toBe('已工作 45 秒');
    expect(formatWorkedFor(133_000, teamBoundT)).toBe('已工作 2 分 13 秒');
  });

  it('无前缀时确实会烂掉 —— 这就是当初线上看到 execution.workedForMinutes 的机制', () => {
    const teamBoundT = i18n.getFixedT('zh-CN', 'team');
    // 没有 `common:` 前缀 → 只能在 team 里找 → 找不到 → 原样返回 key。
    expect(teamBoundT('execution.workedForMinutes')).toBe('execution.workedForMinutes');
    // 有前缀 → 强制进 common → 正常。
    expect(teamBoundT('common:execution.workedForMinutes', { minutes: 2, seconds: 13 }))
      .toBe('已工作 2 分 13 秒');
  });

  it('三个语言都出人话，且绝不出现 key 字符串', () => {
    const cases: Array<[string, string, string]> = [
      ['en', 'Worked for 45s', 'Worked for 2m 13s'],
      ['zh-CN', '已工作 45 秒', '已工作 2 分 13 秒'],
      ['es', 'Trabajó 45 s', 'Trabajó 2 min 13 s'],
    ];
    for (const [lng, short, long] of cases) {
      const t = i18n.getFixedT(lng, 'team');
      expect(formatWorkedFor(45_400, t)).toBe(short);
      expect(formatWorkedFor(133_000, t)).toBe(long);
      expect(formatWorkedFor(133_000, t)).not.toContain('workedFor');
    }
  });

  it('秒级不写「0 分」；分钟级保留余秒', () => {
    const t = i18n.getFixedT('zh-CN', 'team');
    expect(formatWorkedFor(59_400, t)).toBe('已工作 59 秒');
    expect(formatWorkedFor(60_000, t)).toBe('已工作 1 分 0 秒');
  });
});

describe('i18n 配置 — nsMode 必须是 fallback', () => {
  it('应用实例开启了 react.nsMode=fallback（数组 ns 才真正成为回退链）', () => {
    // 关掉它，所有 useTranslation(['a','b']) 里第二个 ns 的 key 都会渲成 key 字符串。
    expect((appI18n.options as { react?: { nsMode?: string } }).react?.nsMode).toBe('fallback');
  });
});

describe('语言包完整性 — common.json 三语 key 对齐', () => {
  const flat = (o: Record<string, unknown>, p = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]);

  it('en / zh-CN / es 的 key 集合完全一致（缺一个就会退化成英文，或直接漏字）', () => {
    const en = new Set(flat(enCommon as Record<string, unknown>));
    for (const [lng, pack] of [['zh-CN', zhCommon], ['es', esCommon]] as const) {
      const keys = new Set(flat(pack as Record<string, unknown>));
      const missing = [...en].filter(k => !keys.has(k));
      const extra = [...keys].filter(k => !en.has(k));
      expect({ lng, missing, extra }).toEqual({ lng, missing: [], extra: [] });
    }
  });

  it('「已工作」两个 key 在三个语言里都在', () => {
    for (const pack of [enCommon, zhCommon, esCommon] as Array<Record<string, unknown>>) {
      const execution = pack.execution as Record<string, unknown>;
      expect(execution.workedForSeconds).toBeTypeOf('string');
      expect(execution.workedForMinutes).toBeTypeOf('string');
    }
  });
});
