/**
 * Behaviour guards for the workflow card (2026-10-27 UX review, second pass).
 *
 * These assert the interaction contract, not the styling: a card that looks
 * right but cannot be opened from the keyboard, or that shows nothing while its
 * detail request is in flight, is the defect this rewrite targeted.
 *
 * Updated after the Owner's second-pass notes:
 *   • the header is an index again (no run counters / progress bar),
 *   • a step is one line and its prompt lives in a modal,
 *   • a run row exposes exactly one affordance (运行详情).
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
    { id: 'research', name: '代码研究', role: 'manager', prompt: '研究一下现有代码结构，列出涉及模块与依赖链。' },
    { id: 'dev', name: '并行开发', role: 'engineer', depends_on: ['research'], prompt: '实现功能主体。' },
    { id: 'review', name: '代码审查', role: 'manager', depends_on: ['research', 'dev'], prompt: '审查改动。' },
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
    onOpenRun: vi.fn(),
    onOpenTask: vi.fn(),
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
    expect(screen.getByTestId('workflow-feature-dev-toggle').className).toContain('min-h-[44px]');
  });

  it('never nests an interactive element inside the summary button', () => {
    const { container } = renderCard({ expanded: true });
    expect(container.querySelectorAll('button button').length).toBe(0);
  });

  it('keeps the collapsed panel out of the tab order', () => {
    renderCard({ expanded: false });
    const panel = screen.getByTestId('workflow-feature-dev-panel');
    expect(panel.closest('[inert]')).not.toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetryDetail).toHaveBeenCalledTimes(1);
  });
});

describe('workflow card — the header stays an index', () => {
  it('does not repeat run progress in the header', () => {
    const { container } = renderCard();
    const header = within(container).getByTestId('workflow-feature-dev-toggle');
    expect(header.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(container.querySelector('[data-testid="workflow-progress"]')).toBeNull();
  });

  it('does keep the latest run status visible', () => {
    renderCard();
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0);
    expect(screen.queryByText('failed')).toBeNull();
  });
});

describe('workflow card — steps are one line, details on demand', () => {
  it('does not print step prompts inline', () => {
    renderCard({ expanded: true });
    expect(screen.queryByText('研究一下现有代码结构，列出涉及模块与依赖链。')).toBeNull();
  });

  it('renders every step in the flow as a clickable row', () => {
    renderCard({ expanded: true });
    const flow = screen.getByTestId('workflow-step-flow');
    expect(within(flow).getByText('代码研究')).toBeTruthy();
    expect(within(flow).getByText('并行开发')).toBeTruthy();
    expect(within(flow).getByText('代码审查')).toBeTruthy();
  });

  it('marks a step with several upstream dependencies', () => {
    renderCard({ expanded: true });
    // 代码审查 depends on research + dev → badge instead of a raw id list
    expect(screen.getByTitle('代码研究、并行开发')).toBeTruthy();
    expect(screen.queryByText(/research/)).toBeNull();
  });

  it('opens the step modal with the full prompt and a task link', () => {
    const onOpenTask = vi.fn();
    renderCard({ expanded: true, onOpenTask });
    fireEvent.click(screen.getByTestId('workflow-step-research'));

    const modal = screen.getByTestId('workflow-step-modal');
    expect(within(modal).getByText('研究一下现有代码结构，列出涉及模块与依赖链。')).toBeTruthy();

    fireEvent.click(within(modal).getByText('查看对应任务'));
    expect(onOpenTask).toHaveBeenCalledWith('t1');
  });

  it('closes the step modal on Escape', () => {
    renderCard({ expanded: true });
    fireEvent.click(screen.getByTestId('workflow-step-research'));
    expect(screen.getByTestId('workflow-step-modal')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('workflow-step-modal')).toBeNull();
  });
});

describe('workflow card — one affordance per run', () => {
  it('shows the run number, status and progress on the run row', () => {
    renderCard({ expanded: true });
    expect(screen.getByText('#7')).toBeTruthy();
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('exposes exactly one control per run: 运行详情', () => {
    const { props } = renderCard({ expanded: true });
    const row = screen.getByText('#7').closest('li')!;
    const buttons = within(row).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('运行详情');

    fireEvent.click(buttons[0]!);
    expect(props.onOpenRun).toHaveBeenCalledWith(run);
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
