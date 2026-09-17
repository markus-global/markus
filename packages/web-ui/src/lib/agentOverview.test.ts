/**
 * Agent overview derivation rules (docs/PROMPT-ENGINEERING.md §prompt correctness
 * sibling: the panel is a *display* surface, but a wrong number there is a wrong
 * fact to the reader).
 *
 * Every case below corresponds to a defect observed on the live org, not a
 * hypothetical. Pure-function tests only — this package has no jsdom /
 * @testing-library/react, so React rendering is out of scope
 * (see packages/web-ui/src/api.test.ts:3-4).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveTokensToday,
  visibleStorageBuckets,
  storageBucketLabelKey,
  agentStatusPresentation,
  recentActivityRows,
  splitRecentActivity,
  RECENT_ACTIVITY_FETCH_LIMIT,
  OVERVIEW_ACTIVITY_LIMIT,
  OVERVIEW_SECTION_IDS,
  DEFAULT_OVERVIEW_SECTION,
  resolveOverviewSection,
  deliverableClickTarget,
} from './agentOverview.ts';
import zhAgent from '../locales/zh-CN/agent.json';
import enAgent from '../locales/en/agent.json';

describe('resolveTokensToday', () => {
  it('prefers the usage counter over the agent-detail counter', () => {
    // The live failure: the agent detail carried 0 while the persisted daily
    // counter held 104,450,959 for the same day. The panel rendered 0, which is
    // indistinguishable from "this agent did nothing today".
    expect(resolveTokensToday({ tokensUsedToday: 104_450_959 }, 0)).toBe(104_450_959);
  });

  it('falls back to the agent-detail counter when usage has not loaded', () => {
    expect(resolveTokensToday(null, 1234)).toBe(1234);
    expect(resolveTokensToday(undefined, 1234)).toBe(1234);
  });

  it('falls back when the usage payload omits the field', () => {
    expect(resolveTokensToday({ totalTokens: 999 }, 42)).toBe(42);
  });

  it('prefers a real zero from usage over a stale non-zero from the detail', () => {
    // A genuinely idle day must read 0, not yesterday's total. This is why the
    // rule is "usage wins" rather than "use the larger of the two" — the latter
    // would resurrect a stale figure every morning.
    expect(resolveTokensToday({ tokensUsedToday: 0 }, 100_000_000)).toBe(0);
  });

  it('returns 0 rather than NaN or undefined when nothing is known', () => {
    // An unguarded `a ?? b` here used to reach `fmtNum` as undefined and render
    // the literal string "undefined" into the panel.
    expect(resolveTokensToday(null, undefined)).toBe(0);
    expect(resolveTokensToday({}, undefined)).toBe(0);
  });

  it('ignores non-finite values from either source', () => {
    expect(resolveTokensToday({ tokensUsedToday: Number.NaN }, 7)).toBe(7);
    expect(resolveTokensToday({ tokensUsedToday: Number.POSITIVE_INFINITY }, 7)).toBe(7);
    expect(resolveTokensToday(null, Number.NaN)).toBe(0);
  });
});

describe('visibleStorageBuckets', () => {
  it('drops zero-byte buckets', () => {
    // A never-run agent still has an empty role/ — a row of "0 B" informs nobody.
    expect(
      visibleStorageBuckets([
        { name: 'workspace', size: 100 },
        { name: 'role', size: 0 },
      ]),
    ).toEqual([{ name: 'workspace', size: 100 }]);
  });

  it('orders largest first with a deterministic tie-break', () => {
    // Ordering is imposed here rather than inherited from the server so that a
    // server-side ordering change cannot silently reshuffle the panel.
    expect(
      visibleStorageBuckets([
        { name: 'sessions', size: 10 },
        { name: 'workspace', size: 90 },
        { name: 'daily-logs', size: 10 },
      ]).map(b => b.name),
    ).toEqual(['workspace', 'daily-logs', 'sessions']);
  });

  it('passes through buckets the old code never produced', () => {
    // The regression this guards: the panel's sub-items were a hard-coded list
    // of five names, so worktrees/ and subagent-logs/ (22.8 MB and 20.8 MB on
    // one measured agent) were invisible. Buckets are now whatever the walk
    // finds, so nothing can go missing by omission again.
    expect(
      visibleStorageBuckets([
        { name: 'worktrees', size: 22 },
        { name: 'subagent-logs', size: 20 },
      ]).map(b => b.name),
    ).toEqual(['worktrees', 'subagent-logs']);
  });

  it('tolerates a missing or malformed list', () => {
    expect(visibleStorageBuckets(undefined)).toEqual([]);
    expect(visibleStorageBuckets([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [
      { name: 'a', size: 1 },
      { name: 'b', size: 2 },
    ];
    visibleStorageBuckets(input);
    expect(input.map(b => b.name)).toEqual(['a', 'b']);
  });
});

describe('storageBucketLabelKey', () => {
  it('maps known directories to translated labels', () => {
    expect(storageBucketLabelKey('sessions')).toBe(
      'agent:profilePage.overview.storageBuckets.sessions',
    );
  });

  it('returns null for unknown directories so the real name is shown', () => {
    // Falling back to the directory name is the point: mislabelling is what
    // produced "memory 259 MB" for a `sessions/` directory holding 259 MB of
    // session files while the actual memory files were 24 KB + 27 KB.
    expect(storageBucketLabelKey('some-new-dir')).toBeNull();
  });
});

describe('agentStatusPresentation', () => {
  it('does not present a stopped agent as idle', () => {
    // The live failure behind "I clicked Stop and the header still said 空闲".
    // The badge derived its label locally with no `offline` branch, so a stopped
    // agent fell through to the green idle default — a status that also claims
    // the agent is running.
    const stopped = agentStatusPresentation('offline');
    expect(stopped.labelKey).toBe('common:status.offline');
    expect(stopped.running).toBe(false);
    expect(stopped.labelKey).not.toBe(agentStatusPresentation('idle').labelKey);
  });

  it('marks only running states as running', () => {
    expect(agentStatusPresentation('idle').running).toBe(true);
    expect(agentStatusPresentation('working').running).toBe(true);
    expect(agentStatusPresentation('error').running).toBe(true);
    expect(agentStatusPresentation('offline').running).toBe(false);
    expect(agentStatusPresentation('paused').running).toBe(false);
  });

  it('gives every status a label, including paused', () => {
    // The old local label map had no `paused` entry (its dot map did), so a
    // paused agent would have rendered the raw English token "paused" as a label.
    for (const s of ['idle', 'working', 'error', 'offline', 'paused']) {
      expect(agentStatusPresentation(s).labelKey, s).toBeTruthy();
    }
  });

  it('treats a missing or unknown status as not-running, without inventing a label', () => {
    // Claiming "offline" for an unrecognised value would be a different lie;
    // labelKey: null makes the caller render the raw value instead.
    for (const s of [undefined, null, '', 'teleporting']) {
      const p = agentStatusPresentation(s as string | undefined);
      expect(p.labelKey).toBeNull();
      expect(p.running).toBe(false);
    }
  });

  it('keeps the dot/label classes in step with the tone', () => {
    // Guards the "green dot next to 离线" half of the bug: the colour must come
    // from the same table entry as the label.
    expect(agentStatusPresentation('idle').dotClass).not.toBe(agentStatusPresentation('offline').dotClass);
    expect(agentStatusPresentation('idle').textClass).not.toBe(agentStatusPresentation('offline').textClass);
  });
});

describe('recentActivityRows', () => {
  const at = (iso: string, id: string) => ({ id, startedAt: iso });

  it('returns newest first', () => {
    // The endpoint returns `liveActivities()`, which sorts ascending (the
    // server's own getCurrentActivity() reads the last element). Rendering that
    // array directly put the oldest entry at the top of a card titled
    // "最近心跳" — the opposite of the title.
    const rows = recentActivityRows([
      at('2026-09-16T10:00:00Z', 'old'),
      at('2026-09-16T12:00:00Z', 'new'),
      at('2026-09-16T11:00:00Z', 'mid'),
    ]);
    expect(rows.shown.map(r => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('caps the body but reports the untruncated total', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      at(`2026-09-16T${String(i).padStart(2, '0')}:00:00Z`, `a${i}`),
    );
    const rows = recentActivityRows(many);
    expect(rows.shown).toHaveLength(OVERVIEW_ACTIVITY_LIMIT);
    expect(rows.total).toBe(12);
    // The header label says "共 12 次"; the body must show the 5 most recent.
    expect(rows.shown[0]!.id).toBe('a11');
  });

  it('tolerates missing input and a zero limit', () => {
    expect(recentActivityRows(undefined)).toEqual({ shown: [], total: 0 });
    expect(recentActivityRows(null).total).toBe(0);
    expect(recentActivityRows([at('2026-09-16T10:00:00Z', 'x')], 0).shown).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [at('2026-09-16T10:00:00Z', 'old'), at('2026-09-16T12:00:00Z', 'new')];
    recentActivityRows(input);
    expect(input.map(r => r.id)).toEqual(['old', 'new']);
  });
});

// ─── Overview sub-tabs ───────────────────────────────────────────────────────

type LocaleSections = Record<string, { title?: string; hint?: string; empty?: string }>;
const zhSections = zhAgent.profilePage.overview.sections as unknown as LocaleSections;
const enSections = enAgent.profilePage.overview.sections as unknown as LocaleSections;

describe('splitRecentActivity', () => {
  const rec = (type: string, id: string) => ({ id, type, startedAt: '2026-09-16T10:00:00.000Z' });

  it('separates heartbeats from A2A exchanges', () => {
    const out = splitRecentActivity([
      rec('heartbeat', 'h1'),
      rec('a2a', 'a1'),
      rec('heartbeat', 'h2'),
    ]);
    expect(out.heartbeats.map(r => r.id)).toEqual(['h1', 'h2']);
    expect(out.comms.map(r => r.id)).toEqual(['a1']);
  });

  // 这次的缺陷：旧代码把人类会话（type='chat'，label 形如 "Chat with Jason Carter"）
  // 当成 A2A 列在「最近 A2A 通信」标题下，而真正的 a2a 活动被丢掉。两个类型不能互换。
  it('does not count a human chat as an A2A exchange', () => {
    const out = splitRecentActivity([rec('chat', 'c1'), rec('a2a', 'a1')]);
    expect(out.comms.map(r => r.id)).toEqual(['a1']);
  });

  it('ignores activity types the panel does not show', () => {
    const out = splitRecentActivity([rec('task', 't1'), rec('internal', 'i1'), rec('heartbeat', 'h1')]);
    expect(out.heartbeats).toHaveLength(1);
    expect(out.comms).toHaveLength(0);
  });

  // 接口失败或字段缺失时不能抛——否则整个概览 tab 白屏。
  it('tolerates a missing list', () => {
    for (const input of [undefined, null, [] as ReturnType<typeof rec>[]]) {
      expect(splitRecentActivity(input)).toEqual({ heartbeats: [], comms: [] });
    }
  });

  // 窗口必须比展示条数大：否则 caption 里的计数就等于「看得见的行数」，
  // 那个数字又变回一句废话（这正是之前表头写过的问题）。
  it('fetches a window larger than the display limit', () => {
    expect(RECENT_ACTIVITY_FETCH_LIMIT).toBeGreaterThan(OVERVIEW_ACTIVITY_LIMIT);
  });
});

describe('OVERVIEW_SECTION_IDS', () => {
  it('lists each group exactly once', () => {
    expect(new Set(OVERVIEW_SECTION_IDS).size).toBe(OVERVIEW_SECTION_IDS.length);
  });

  it('contains the default section', () => {
    expect(OVERVIEW_SECTION_IDS).toContain(DEFAULT_OVERVIEW_SECTION);
  });

  // 【为什么把默认组锁在第一项】概览打开时先看到什么，是产品决定，不该由
  // 「数组顺序」和「DEFAULT 常量」两份定义各自漂移出来。曾经默认组是第 4 项
  // （`usage` 打头、`DEFAULT` 写死 'usage'），于是任何人调顺序都会让默认高亮
  // 落在中间某一格——只能靠肉眼发现。
  it('defaults to the first group', () => {
    expect(DEFAULT_OVERVIEW_SECTION).toBe(OVERVIEW_SECTION_IDS[0]);
  });

  // 打开概览先看到「这个 agent 是谁」（人设 / 心跳 / 记忆文件）；统计数字退到后面。
  it('leads with files and keeps usage last', () => {
    expect(OVERVIEW_SECTION_IDS[0]).toBe('files');
    expect(OVERVIEW_SECTION_IDS[OVERVIEW_SECTION_IDS.length - 1]).toBe('usage');
  });

  // 两份 locale 的键顺序是给人看的文档（读者会按它推断 UI 顺序）。顺序不一致本身
  // 不会报错，但会让下一个改顺序的人以为漏改了——所以与 UI 顺序显式对齐。
  it('keeps both locale files in the same order as the UI', () => {
    for (const [localeName, sections] of [['zh', zhSections], ['en', enSections]] as const) {
      expect(Object.keys(sections), `${localeName} section order`).toEqual([...OVERVIEW_SECTION_IDS]);
    }
  });

  // The sub-tab bar builds its labels from a **dynamic** key
  // (`sections.${id}.title`). A missing key does not throw — i18next falls back to
  // rendering the raw key, so the user would see a tab literally labelled
  // "sections.usage.title". Nothing else in the build catches that, and it is
  // exactly what happened when the groups became sub-tabs, so it is locked here.
  it('has a title in both locales for every section', () => {
    for (const [localeName, sections] of [['zh', zhSections], ['en', enSections]] as const) {
      for (const id of OVERVIEW_SECTION_IDS) {
        expect(sections[id]?.title, `${localeName}:${id} has no title`).toBeTruthy();
      }
    }
  });
});

describe('resolveOverviewSection', () => {
  it('defaults to the first group', () => {
    expect(resolveOverviewSection()).toBe(DEFAULT_OVERVIEW_SECTION);
    expect(resolveOverviewSection(undefined, undefined)).toBe(DEFAULT_OVERVIEW_SECTION);
  });

  it('honours a known requested section', () => {
    expect(resolveOverviewSection('files')).toBe('files');
  });

  // The mailbox highlight must win: it points at one item that only exists inside
  // 运行与注意力, so landing on any other group hides the thing the link promised.
  it('lets a mailbox highlight win over the requested section', () => {
    expect(resolveOverviewSection('files', 'msg_abc')).toBe('mind');
  });

  // A stale/unknown link must not select a group that has no panel.
  it('ignores an unknown section', () => {
    expect(resolveOverviewSection('nope')).toBe(DEFAULT_OVERVIEW_SECTION);
    expect(resolveOverviewSection('')).toBe(DEFAULT_OVERVIEW_SECTION);
  });

  // `''` is falsy — an empty highlight must not silently select 运行与注意力.
  it('ignores an empty mailbox id', () => {
    expect(resolveOverviewSection('files', '')).toBe('files');
  });
});

describe('deliverableClickTarget', () => {
  // The live defect: the 产出 tab gated on `layout.openRightPanel`, which always
  // exists because it is a context constant. Mobile clicks therefore pushed a tab
  // into a panel that no host renders — the click looked broken. `hostAvailable`
  // is the real gate (`setHostAvailable(isActive && !isMobile)` on the Team page).
  it('routes to the page when no right-panel host exists (mobile)', () => {
    expect(deliverableClickTarget(false)).toBe('page');
    expect(deliverableClickTarget(undefined)).toBe('page');
  });

  it('routes to the right panel when a host exists (desktop)', () => {
    expect(deliverableClickTarget(true)).toBe('right-panel');
  });
});
