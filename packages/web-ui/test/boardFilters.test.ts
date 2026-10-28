/**
 * Guards for board visibility (`src/lib/boardFilters.ts`).
 *
 * The specific defect these protect against: `查看任务` on a workflow run switches
 * to the dependency graph, which filtered tasks with `includeArchived: true`
 * expecting a *finished* run's closed tasks to be included — but the inline
 * implementation ignored that argument, so a completed run opened an empty DAG.
 */
import { describe, it, expect } from 'vitest';
import { filterBoardTasks, isClosedStatus, CLOSED_STATUSES } from '../src/lib/boardFilters';

const tasks = [
  { id: 't1', status: 'completed', projectId: 'p1', assignedAgentId: 'a1', createdBy: 'u1' },
  { id: 't2', status: 'archived', projectId: 'p1', assignedAgentId: 'a1', createdBy: 'u1' },
  { id: 't3', status: 'pending', projectId: 'p2', assignedAgentId: 'a2', createdBy: 'u2' },
  { id: 't4', status: 'rejected', projectId: 'p2', assignedAgentId: 'a2', createdBy: 'u2' },
];

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('closed visibility', () => {
  it('hides closed tasks by default', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: false }))).toEqual(['t1', 't3']);
  });

  it('shows them when the board toggle is on', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: true }))).toHaveLength(4);
  });

  /**
   * The regression: callers that opt out of the toggle (the DAG view, and
   * "open this requirement") must be able to include closed rows. Previously the
   * parameter was accepted and never read.
   */
  it('honours the explicit includeClosed override', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: false, includeClosed: true }))).toHaveLength(4);
  });

  it('classifies closed statuses in one place', () => {
    expect(isClosedStatus('archived')).toBe(true);
    expect(isClosedStatus('cancelled')).toBe(true);
    expect(isClosedStatus('rejected')).toBe(true);
    expect(isClosedStatus('completed')).toBe(false);
    expect([...CLOSED_STATUSES].sort()).toEqual(['archived', 'cancelled', 'rejected']);
  });
});

describe('scope filters', () => {
  it('applies the status filter', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: true, statusFilter: 'pending' }))).toEqual(['t3']);
  });

  it('applies project view scope', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: true, viewMode: 'project', selectedProjectId: 'p1' })))
      .toEqual(['t1', 't2']);
  });

  it('applies multi-project filter', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: true, projectFilter: new Set(['p2']) })))
      .toEqual(['t3', 't4']);
  });

  it('applies agent filter', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: true, agentFilter: new Set(['a1']) })))
      .toEqual(['t1', 't2']);
  });

  it('applies my-tasks-only only when a user id is known', () => {
    expect(ids(filterBoardTasks(tasks, { showClosed: true, myTasksOnly: true, currentUserId: 'u2' })))
      .toEqual(['t3', 't4']);
    expect(ids(filterBoardTasks(tasks, { showClosed: true, myTasksOnly: true }))).toHaveLength(4);
  });

  it('combines closed override with scope filters (the 查看任务 path)', () => {
    const visible = filterBoardTasks(tasks, {
      showClosed: false,
      includeClosed: true,
      viewMode: 'project',
      selectedProjectId: 'p1',
    });
    // a finished run: every task closed, and they must still render
    expect(ids(visible)).toEqual(['t1', 't2']);
  });
});
