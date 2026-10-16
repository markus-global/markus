/**
 * A task still awaiting approval is not the same thing as a task that was
 * **rejected** — and the card must not present them identically.
 *
 * Reported (2026-10-16): rejecting task G from Feishu worked, but the task card
 * in the Team Chat bubble kept its "pending" look — same colour, same badge, and
 * its Approve / Reject buttons still showing. `TaskApprovalCard`'s
 * `TASK_STATUS_TO_CARD_STATE` simply had no `rejected` (nor `revision`) entry, so
 * a rejected task fell through to the `?? 'pending'` fallback. Its sibling
 * `RequirementApprovalCard` already mapped `rejected`, which is why only tasks
 * looked wrong.
 *
 * These guards pin the three halves that were broken:
 *   1. the server status `rejected` paints the rejected state (not pending);
 *   2. the action buttons are gone — a terminal task cannot be acted on twice;
 *   3. the same holds for the review gate's 打回 (`revision`), which is a
 *      different terminal-ish state again.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  const status = { value: 'pending' as string };
  return {
    status,
    tasksGet: async (id: string) => ({ task: { id, title: 'Ship the widget', status: status.value } }),
  };
});

vi.mock('../src/api.ts', () => ({
  api: { tasks: { get: h.tasksGet } },
  wsClient: { on: () => () => {} },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

import { TaskApprovalCard } from '../src/components/ExecutionTimeline.tsx';

const info = { taskId: 'tsk_card_state', title: 'Ship the widget' };

describe('TaskApprovalCard — a rejected task does not look like a pending one', () => {
  it('paints the rejected state, not the pending fallback', async () => {
    h.status.value = 'rejected';
    render(<TaskApprovalCard info={info} />);

    await waitFor(() => expect(screen.getByText('execution.card.rejected')).toBeTruthy());
    expect(screen.queryByText('execution.card.pendingApproval')).toBeNull();
  });

  it('drops the approve / reject buttons once the task is decided', async () => {
    h.status.value = 'rejected';
    render(<TaskApprovalCard info={info} />);
    await waitFor(() => expect(screen.getByText('execution.card.rejected')).toBeTruthy());

    expect(screen.queryByText('approve')).toBeNull();
    expect(screen.queryByText('reject')).toBeNull();
  });

  it('gives 打回 (revision) its own state, distinct from rejected', async () => {
    h.status.value = 'revision';
    render(<TaskApprovalCard info={info} />);

    await waitFor(() => expect(screen.getByText('execution.card.revision')).toBeTruthy());
    expect(screen.queryByText('execution.card.rejected')).toBeNull();
    expect(screen.queryByText('execution.card.pendingApproval')).toBeNull();
  });

  /**
   * The contrast that makes the bug legible: a *pending* task is the one that
   * offers the buttons. (While pending the card deliberately shows no status
   * word — the buttons carry that meaning — so the assertion is the actions.)
   */
  it('keeps the approve / reject buttons for a genuinely pending task', async () => {
    h.status.value = 'pending';
    render(<TaskApprovalCard info={info} />);

    await waitFor(() => expect(screen.getByText('approve')).toBeTruthy());
    expect(screen.getByText('reject')).toBeTruthy();
    expect(screen.queryByText('execution.card.rejected')).toBeNull();
  });
});
