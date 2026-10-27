/**
 * Behaviour guards for the workflow card.
 *
 * The rule these tests encode is a **domain** rule, not a styling one:
 *
 *   • the card renders a workflow **template** — name, description, steps
 *     (name/role/prompt/dependencies), params, schedule;
 *   • a **run** owns status, progress and tasks, and lives in the runs list /
 *     run drawer.
 *
 * Mixing the two produced the defects the Owner reported on 2026-10-27: the
 * description printed twice, a step modal showing a run's "已完成" badge with a
 * link to "the task it produced" (a template step has no task), and a run row
 * whose only clickable thing was a 28px `…` icon.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { WorkflowInfo, WorkflowRunInfo, WorkflowTemplateInfo } from '../src/api.ts';

vi.mock('react-i18next', () => {
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

const DESCRIPTION = '覆盖需求分析、并行开发、代码审查的全流程自动化。';

const workflow: WorkflowInfo = {
  name: 'feature-dev',
  displayName: '标准功能开发流程',
  description: DESCRIPTION,
  version: '1.0.0',
  roles: ['manager', 'engineer'],
  hasSchedule: false,
  stepCount: 3,
};

const detail: WorkflowTemplateInfo = {
  name: 'feature-dev',
  displayName: '标准功能开发流程',
  description: DESCRIPTION,
  version: '1.0.0',
  params: [{ name: 'feature_title', label: '功能标题', type: 'string', required: true }],
  steps: [
    { id: 'research', name: '代码研究', role: 'manager', prompt: '研究一下现有代码结构。' },
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
  { id: 't1', title: '[标准功能开发流程] 代码研究', status: 'completed', workflowStepId: 'research' },
  { id: 't2', title: '[标准功能开发流程] 并行开发', status: 'failed', workflowStepId: 'dev' },
  { id: 't3', title: '[标准功能开发流程] 代码审查', status: 'pending', workflowStepId: 'review' },
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
    onSaveStep: vi.fn().mockResolvedValue(undefined),
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

describe('workflow card — a template is not a run', () => {
  it('does not print the description twice (header once, panel not at all)', () => {
    renderCard({ expanded: true });
    expect(screen.getAllByText(DESCRIPTION)).toHaveLength(1);
  });

  it('paints no run status onto the step flow', () => {
    renderCard({ expanded: true });
    const flow = screen.getByTestId('workflow-step-flow');
    // run status words belong to the runs list, not to the definition
    expect(within(flow).queryByText('已完成')).toBeNull();
    expect(within(flow).queryByText('失败')).toBeNull();
  });

  it('keeps run status inside the runs list', () => {
    renderCard({ expanded: true });
    const runButton = screen.getByTestId('workflow-run-open-run-1');
    expect(within(runButton).getByText('失败')).toBeTruthy();
  });
});

describe('workflow card — steps', () => {
  it('does not print step prompts inline', () => {
    renderCard({ expanded: true });
    expect(screen.queryByText('研究一下现有代码结构。')).toBeNull();
  });

  it('renders every step in the flow', () => {
    renderCard({ expanded: true });
    const flow = screen.getByTestId('workflow-step-flow');
    expect(within(flow).getByText('代码研究')).toBeTruthy();
    expect(within(flow).getByText('并行开发')).toBeTruthy();
    expect(within(flow).getByText('代码审查')).toBeTruthy();
  });

  it('marks steps that depend on several upstream steps', () => {
    renderCard({ expanded: true });
    expect(screen.getByTitle('代码研究、并行开发')).toBeTruthy();
    expect(screen.queryByText(/research/)).toBeNull();
  });

  it('opens a definition modal: editable prompt, no run status, no task link', () => {
    renderCard({ expanded: true });
    fireEvent.click(screen.getByTestId('workflow-step-research'));

    const modal = screen.getByTestId('workflow-step-modal');
    const prompt = within(modal).getByLabelText('提示词') as HTMLTextAreaElement;
    expect(prompt.value).toBe('研究一下现有代码结构。');

    // instance facts must not leak into the definition view
    expect(within(modal).queryByText('已完成')).toBeNull();
    expect(within(modal).queryByText('查看对应任务')).toBeNull();
  });

  it('saves an edited prompt through onSaveStep', async () => {
    const onSaveStep = vi.fn().mockResolvedValue(undefined);
    renderCard({ expanded: true, onSaveStep });
    fireEvent.click(screen.getByTestId('workflow-step-research'));

    const modal = screen.getByTestId('workflow-step-modal');
    const prompt = within(modal).getByLabelText('提示词') as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: '新的提示词内容' } });
    fireEvent.click(within(modal).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSaveStep).toHaveBeenCalledWith('research', {
      name: '代码研究',
      role: 'manager',
      prompt: '新的提示词内容',
    }));
    await waitFor(() => expect(screen.queryByTestId('workflow-step-modal')).toBeNull());
  });

  it('keeps the save button disabled until something changes', () => {
    renderCard({ expanded: true });
    fireEvent.click(screen.getByTestId('workflow-step-research'));
    const modal = screen.getByTestId('workflow-step-modal');
    expect((within(modal).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('workflow card — one affordance per run', () => {
  it('shows run number, status and progress on the row', () => {
    renderCard({ expanded: true });
    const row = screen.getByTestId('workflow-run-open-run-1');
    expect(within(row).getByText('#7')).toBeTruthy();
    expect(within(row).getByText('1/3')).toBeTruthy();
  });

  it('makes the whole row the click target, not a corner icon', () => {
    const onOpenRun = vi.fn();
    renderCard({ expanded: true, onOpenRun });
    const row = screen.getByTestId('workflow-run-open-run-1');
    // the row IS a button, and it owns the full width
    expect(row.tagName).toBe('BUTTON');
    expect(row.className).toContain('w-full');
    fireEvent.click(within(row).getByText('#7'));
    expect(onOpenRun).toHaveBeenCalledWith(run);
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
