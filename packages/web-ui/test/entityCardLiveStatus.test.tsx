/**
 * A task card in a Team Chat bubble must show the **server's** status, not the
 * snapshot the card happened to see when its message first rendered.
 *
 * Reported symptom (2026-10-16): a task card kept reading "pending" after the
 * task had been **rejected**. Root cause: `EntityCard.tsx` resolved each entity
 * once and cached it for the whole session (`const cache = new Map(...)`, never
 * invalidated), and nothing subscribed to the entity WS stream — so *any* later
 * status change was invisible, rejection being the one the owner happened to look
 * at.
 *
 * The fix is that the cache is now invalidated by the entity events the server
 * already broadcasts, and every mounted card re-reads. These guards pin both
 * halves: the repaint, and that an unrelated entity's event does not repaint it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';

const h = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const status = { value: 'pending' as string };
  const wsOn = (type: string, fn: (e: unknown) => void): (() => void) => {
    const set = handlers.get(type) ?? new Set<(e: unknown) => void>();
    set.add(fn);
    handlers.set(type, set);
    return () => set.delete(fn);
  };
  const tasksGet = async (id: string): Promise<unknown> => ({
    task: { id, title: 'Ship the widget', status: status.value },
  });
  return { handlers, status, wsOn, tasksGet };
});

vi.mock('../src/api.ts', () => ({
  api: {
    tasks: { get: h.tasksGet },
    requirements: { get: async () => undefined },
    projects: { get: async () => undefined },
    deliverables: { get: async () => undefined },
    agents: { get: async () => undefined },
    teams: { list: async () => ({ teams: [] }) },
  },
  wsClient: { on: h.wsOn },
}));

import { EntityCard } from '../src/components/EntityCard.tsx';

function emit(type: string, payload: unknown): void {
  for (const fn of h.handlers.get(type) ?? []) fn({ type, payload });
}

beforeEach(() => {
  h.status.value = 'pending';
});

describe('EntityCard — the bubble card follows the server status', () => {
  it('repaints when the task is rejected (the reported symptom)', async () => {
    const id = 'tsk_live_reject';
    render(<EntityCard id={id} />);
    await waitFor(() => expect(screen.getByText('pending')).toBeTruthy());

    h.status.value = 'rejected';
    act(() => emit('task:update', { taskId: id, status: 'rejected' }));

    await waitFor(() => expect(screen.getByText('rejected')).toBeTruthy());
    expect(screen.queryByText('pending')).toBeNull();
  });

  it('an event for a different entity does not repaint this card', async () => {
    const id = 'tsk_live_isolated';
    render(<EntityCard id={id} />);
    await waitFor(() => expect(screen.getByText('pending')).toBeTruthy());

    h.status.value = 'rejected';
    act(() => emit('task:update', { taskId: 'tsk_somebody_else' }));

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.queryByText('rejected')).toBeNull();
  });

  it('renders the entity title (the card is not just a status pill)', async () => {
    render(<EntityCard id="tsk_live_title" />);
    await waitFor(() => expect(screen.getByText('Ship the widget')).toBeTruthy());
  });
});
