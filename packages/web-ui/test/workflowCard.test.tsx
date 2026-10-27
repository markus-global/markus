/**
 * Behaviour guards for the workflow card (2026-10-27 UX review).
 *
 * These assert the *interaction contract*, not the styling: a card that looks
 * right but cannot be opened from the keyboard, or that shows nothing while its
 * detail request is in flight, is exactly the defect this rewrite targeted.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { WorkflowInfo, WorkflowRunInfo, WorkflowTemplateInfo } from '../src/api.ts';

vi.mock('react-i18next', () => {
  // Mirrors i18next's three call shapes the components actually use:
  //   t(key)                      t(key, '默认值')      t(key, '默认 {{x}} 值', { x })
  const t = (key: string, second?: unknown, third?: unknown) => {
    const fallback = typeof second === 'string'
      ? second
      : ((second as { defaultValue?: string } | undefined)?.defaultValue ?? key);
    const opts = (typeof second === 'object' && second !== null ? second : third) as
      | Record<string, unknown>
      | undefined;
    return fallback.replace(/{{(\w+)}}/g, (_m, name: string) => String(opts?.[name] ?? ''));
  };
  return { useTranslation: () => ({ t, i18n: { language: 'zh-CN' } }) };
});

import { WorkflowCard } from '../src/components/WorkflowCard.tsx';

const workflow: WorkflowInfo = {
  name: 'feature-dev',
  displayName: '标准功能开发流程',
  description: '覆盖需求分析、并行开发、代码审查的全流程自动化。',
  version: '1.0.0',
  roles: ['manager', 'engineer'],
  hasSchedule: false,
  stepCount: 3,
};

const detail: WorkflowTemplateInfo = {
  name: 'feature-dev',
  displayName: '标准功能开发流程',
  description: workflow.description,
  version: '1.0.0',
  params: [{ name: 'feature_title', label: '功能标题', type: 'string', required: true }],
  steps: [
    { id: 'research', name: '代码研究', role: 'manager', prompt: 'p'.repeat(200) },
    { id: 'dev', name: '并行开发', role: 'engineer', depends_on: ['research'], prompt: 'short' },
    { id: 'review', name: '代码审查', role: 'manager', depends_on: ['dev'], prompt: 'short' },
  ],
};

const run: WorkflowRunInfo = {
  id: 'run-1',
  teamId: 'team-1',
  workflowName: 'feature-dev',
  runNumber: 7,
  requirementId: 'req-1',
  taskIds: ['t1', 't2', 't3'],
  params: {},
  roleMapping: {},
  status: 'failed',
  triggeredBy: 'manual',
  startedAt: new Date().toISOString(),
};

const runTasks = [
  { id: 't1', title: '[标准功能开发流程] 代码研究', status: 'completed' },
  { id: 't2', title: '[标准功能开发流程] 并行开发', status: 'failed' },
  { id: 't3', title: '[标准功能开发流程] 代码审查', status: 'pending' },
];

function renderCard(overrides: Partial<Parameters<typeof WorkflowCard>[0]> = {}) {
  const props: Parameters<typeof WorkflowCard>[0] = {
    workflow,
    detail,
    detailState: 'ready',
    onRetryDetail: vi.fn(),
    expanded: false,
    onToggle: vi.fn(),
    runs: [run],
    runTasks: { 'run-1': runTasks },
    onRun: vi.fn(),
    onViewTasks: vi.fn(),
    onOpenRun: vi.fn(),
    onPauseResume: vi.fn(),
    onCancelRun: vi.fn(),
    onSendToAgent: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  const utils = render(<WorkflowCard {...props} />);
  return { ...utils, props };
}

describe('workflow card — openable without a mouse', () => {
  it('exposes the summary as a real button with expanded state', () => {
    const { props } = renderCard();
    const toggle = screen.getByTestId('workflow-feature-dev-toggle');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    fireEvent.click(toggle);
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('has a hit area that is at least 44px tall on touch', () => {
    renderCard();
    const toggle = screen.getByTestId('workflow-feature-dev-toggle');
    expect(toggle.className).toContain('min-h-[44px]');
  });

  it('never nests an interactive element inside the summary button', () => {
    // the old card nested the "run" button and a chat deep-link inside the
    // clickable header and patched it with stopPropagation()
    const { container } = renderCard({ expanded: true });
    expect(container.querySelectorAll('button button').length).toBe(0);
  });

  it('keeps the collapsed panel out of the tab order', () => {
    renderCard({ expanded: false });
    const panel = screen.getByTestId('workflow-feature-dev-panel');
    // the panel wrapper (parent) is inert while closed
    const inertWrapper = panel.closest('[inert]');
    expect(inertWrapper).not.toBeNull();
  });
});

describe('workflow card — feedback while loading', () => {
  it('renders a skeleton the moment the panel opens', () => {
    renderCard({ expanded: true, detail: undefined, detailState: 'loading' });
    expect(screen.getByTestId('workflow-detail-skeleton')).toBeTruthy();
  });

  it('offers a retry instead of failing silently', () => {
    const onRetryDetail = vi.fn();
    renderCard({ expanded: true, detail: undefined, detailState: 'error', onRetryDetail });
    const retry = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retry);
    expect(onRetryDetail).toHaveBeenCalledTimes(1);
  });
});

describe('workflow card — answers "how far did it get"', () => {
  it('shows derived progress instead of a bare task count', () => {
    renderCard();
    expect(screen.getByTestId('workflow-progress').textContent).toContain('1/3');
  });

  it('names the failed step on the collapsed card', () => {
    renderCard();
    expect(screen.getByTestId('workflow-failed-step').textContent).toContain('并行开发');
  });

  it('translates the run status instead of printing the raw enum', () => {
    renderCard();
    expect(screen.queryByText('failed')).toBeNull();
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0);
  });

  it('shows dependency names, never raw step ids', () => {
    renderCard({ expanded: true });
    const panel = screen.getByTestId('workflow-feature-dev-panel');
    expect(within(panel).queryByText(/research/)).toBeNull();
    expect(within(panel).getByText(/依赖 代码研究/)).toBeTruthy();
  });

  it('opens the run drawer and the task board from a run row', () => {
    const { props } = renderCard({ expanded: true });
    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(props.onOpenRun).toHaveBeenCalledWith(run);
    fireEvent.click(screen.getByRole('button', { name: '查看任务' }));
    expect(props.onViewTasks).toHaveBeenCalledWith(run);
  });
});

describe('workflow card — management actions are reachable', () => {
  it('exposes edit/duplicate/delete through the actions menu', () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑 YAML' }));
    expect(props.onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作流' }));
    expect(props.onDelete).toHaveBeenCalled();
  });
});
