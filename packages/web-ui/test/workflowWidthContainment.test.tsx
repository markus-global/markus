/**
 * Width containment for the Work → workflows view (card 9, Owner 2026-11-05).
 *
 * The bug: at a 375px viewport the cards were 393px wide and sat 36px past the
 * right edge, so the panel became a horizontal scroller and the right-hand
 * content was cut off. Two structural causes, both expressible as DOM facts:
 *
 *   1. **Implicit grid track.** `grid gap-4` with no explicit `grid-cols-*`
 *      creates one `auto` column, which is sized by the widest item's
 *      *max-content* width ⇒ the track is as wide as the broadest card, and
 *      `max-w-4xl` only caps the maximum.
 *   2. **A row of unbreakable tokens.** The "recent runs" row was `flex` with
 *      every child `shrink-0` and a `flex-1` spacer: its min-content width is
 *      the sum of all chips, so it cannot shrink and pushes the card, the
 *      track, and the panel wider than the screen.
 *
 * ── What this file can and cannot prove ─────────────────────────────────────
 * This suite runs in happy-dom, which has **no layout engine** — a
 * `scrollWidth` assertion here would only echo back numbers we invented. So it
 * asserts the *structural contract* that makes overflow impossible, and the
 * real numbers (375/390/430/1280, collapsed/expanded/drawer) come from
 * `repro/measure-workflow-overflow.mjs`, which drives real Chrome over CDP:
 *
 *   node repro/measure-workflow-overflow.mjs \
 *     http://localhost:8062/repro/workflows-overflow.html 375,390,430,1280
 *
 * Measured before the fix: panel 411px at a 375px viewport (+36px). After:
 * 375/375, cards 341px, drawer 374/374, desktop unchanged at 896/894.
 *
 * The assertions below are nonetheless the ones that bite in CI: drop
 * `grid-cols-1`, `min-w-0`, or `flex-wrap` and this file goes red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import zhWork from '../src/locales/zh-CN/work.json';
import zhCommon from '../src/locales/zh-CN/common.json';
import { WorkflowsPanel } from '../src/pages/Work.tsx';
import type { AgentInfo, HumanUserInfo, ProjectInfo } from '../src/api.ts';

const TEAM = 'team_width_test';

const STEPS = Array.from({ length: 6 }, (_, i) => ({
  id: `step-${i + 1}`,
  name: '收集本周竞品动态与社区反馈（含一手来源核对）',
  role: 'research-assistant',
  depends_on: i === 0 ? [] : [`step-${i}`],
  prompt: '…',
}));

const WORKFLOWS = Array.from({ length: 3 }, (_, w) => ({
  name: `workflow-${w + 1}`,
  displayName: '每周竞品与社区动态综述',
  description: '汇总本周竞品发布、社区讨论与技术趋势，产出可直接分发的综述稿',
  version: '2.4.1',
  roles: ['research-assistant', 'content-writer'],
  hasSchedule: true,
  schedule: { cron: '0 9 * * 1' },
  stepCount: 6,
}));

const RUNS = Array.from({ length: 3 }, (_, i) => ({
  id: `run-${i + 1}`,
  teamId: TEAM,
  workflowName: WORKFLOWS[0]!.name,
  runNumber: 12 - i,
  requirementId: `req-${i + 1}`,
  taskIds: [`tsk-${i}-1`, `tsk-${i}-2`],
  params: {},
  roleMapping: { 'research-assistant': 'agt_1' },
  // Mixed statuses: the widest realistic combination of chips in one row.
  status: ['running', 'completed', 'failed'][i]!,
  triggeredBy: i === 0 ? 'schedule' : 'manual',
  startedAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (path === '/api/teams') return jsonResponse({ teams: [{ id: TEAM, orgId: 'default', name: 'Team' }] });
  if (new RegExp(`^/api/teams/${TEAM}/workflows/[^/?]+/runs`).test(path)) return jsonResponse({ runs: RUNS });
  if (new RegExp(`^/api/teams/${TEAM}/workflows/([^/?]+)$`).test(path)) {
    const name = decodeURIComponent(RegExp.$1);
    return jsonResponse({
      template: { ...WORKFLOWS[0], name, steps: STEPS },
      yaml: `name: ${name}\nsteps: []\n`,
    });
  }
  if (path.startsWith(`/api/teams/${TEAM}/workflows`)) return jsonResponse({ workflows: WORKFLOWS });
  if (path.startsWith('/api/tasks')) return jsonResponse({ tasks: [], total: 0 });
  return jsonResponse({});
});

/** class → token list. Tailwind utilities are class *facts*, and that is all a
 *  layout-free DOM can verify. */
const tokens = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const hasToken = (el: Element, token: string): boolean => tokens(el).includes(token);
const childElements = (el: Element): Element[] => Array.from(el.children);

interface Violation {
  rule: string;
  element: string;
}

/** The two rules from the header, applied to a rendered subtree. */
function widthContainmentViolations(root: HTMLElement): Violation[] {
  const violations: Violation[] = [];
  const name = (el: Element): string =>
    el.getAttribute('data-testid') ?? `${el.tagName.toLowerCase()}.${tokens(el).slice(0, 4).join('.')}`;

  for (const el of Array.from(root.querySelectorAll('*'))) {
    const kids = childElements(el);

    // Rule 1 — a grid with several items must declare its tracks. Without an
    // explicit `grid-cols-*` the implicit track is `auto`, i.e. max-content.
    if (hasToken(el, 'grid') && kids.length >= 2 && !tokens(el).some((t) => t.startsWith('grid-cols-'))) {
      violations.push({ rule: 'grid without explicit tracks', element: name(el) });
    }

    // Rule 2 — a non-wrapping row made only of `shrink-0` children cannot
    // shrink: its min-content width is the sum of the children.
    const isRow = hasToken(el, 'flex') && !hasToken(el, 'flex-col') && !hasToken(el, 'flex-wrap');
    if (isRow && kids.length >= 2 && kids.every((kid) => hasToken(kid, 'shrink-0'))) {
      violations.push({ rule: 'unshrinkable row (all children shrink-0)', element: name(el) });
    }
  }

  // Rule 3 — every item of a track-declaring grid must be allowed to shrink.
  for (const grid of Array.from(root.querySelectorAll('*'))) {
    if (!tokens(grid).some((t) => t.startsWith('grid-cols-'))) continue;
    for (const item of childElements(grid)) {
      if (!hasToken(item, 'min-w-0')) {
        violations.push({ rule: 'grid item without min-w-0', element: name(item) });
      }
    }
  }

  return violations;
}

describe('Work → workflows: width containment contract', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchStub);
    await i18next.init({
      lng: 'zh-CN',
      fallbackLng: 'zh-CN',
      ns: ['work', 'common'],
      defaultNS: 'common',
      resources: { 'zh-CN': { work: zhWork, common: zhCommon } },
      interpolation: { escapeValue: false },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchStub.mockClear();
    // Storage is optional in this environment (the panel already treats it that way).
    try { localStorage?.clear?.(); } catch { /* no storage */ }
  });

  function renderPanel() {
    const agents = [{ id: 'agt_1', name: '研究员', teamId: TEAM, agentRole: 'member' }] as unknown as AgentInfo[];
    const users = [{ id: 'usr_1', name: 'Owner', username: 'owner' }] as unknown as HumanUserInfo[];
    const projects = [{ id: 'proj_1', name: 'Project', description: '', status: 'active' }] as unknown as ProjectInfo[];
    return render(
      <I18nextProvider i18n={i18next}>
        <WorkflowsPanel teamId={TEAM} defaultTeamId={TEAM} projectId={null} agents={agents} users={users} projects={projects} />
      </I18nextProvider>,
    );
  }

  it('renders cards inside a declared single-column track, and every card may shrink', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="workflow-card-"]').length).toBe(3));

    const list = container.querySelector('[data-testid="workflows-list"]')!;
    expect(list).toBeTruthy();
    // Rule 1 at the source of the measured overflow.
    expect(tokens(list)).toContain('grid-cols-1');
    expect(tokens(list)).toContain('min-w-0');

    for (const card of Array.from(container.querySelectorAll('[data-testid^="workflow-card-"]'))) {
      expect(hasToken(card, 'min-w-0')).toBe(true);
    }

    expect(widthContainmentViolations(container)).toEqual([]);
  });

  it('keeps the whole panel free of unshrinkable rows once a card is expanded', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="workflow-card-"]').length).toBe(3));

    // Expands the widest state: step flow + params + run rows + drawer trigger.
    container.querySelector('[data-testid="workflow-workflow-1-toggle"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="workflow-run-open-"]').length).toBe(3));

    const runRows = Array.from(container.querySelectorAll('[data-testid^="workflow-run-open-"]'));
    for (const row of runRows) {
      // The row that caused the bug: it must be allowed to wrap, and it must no
      // longer rely on a `flex-1` spacer that only "worked" at wide widths.
      expect(hasToken(row, 'flex-wrap')).toBe(true);
      expect(hasToken(row, 'justify-between')).toBe(false);
      expect(row.querySelector('.flex-1')).toBeNull();
    }

    expect(widthContainmentViolations(container)).toEqual([]);
  });
});
