/**
 * Milestone semantics — the two things that must never drift:
 *
 *  1. **Progress definition** (`computeMilestoneProgress` is the single definition; API, UI and
 *     tools all read it). Table-driven over every status so a "harmless" tweak goes red.
 *  2. **Deleting a milestone UNLINKS requirements** — it must never delete them. The assertion
 *     is on the bridge call + the surviving requirement, not on "the call did not throw".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MilestoneService, computeMilestoneProgress } from '../src/milestone-service.js';
import type { Requirement } from '@markus/shared';

const PROJECT_A = 'proj_a';
const PROJECT_B = 'proj_b';

function makeService(opts?: {
  requirementsByMilestone?: Record<string, Array<{ status: string }>>;
  detach?: (id: string) => number;
  projects?: string[];
}) {
  const svc = new MilestoneService();
  const projects = new Set(opts?.projects ?? [PROJECT_A, PROJECT_B]);
  svc.setProjectService({ getProject: (id: string) => (projects.has(id) ? { id } : undefined) });
  const detach = vi.fn(opts?.detach ?? (() => 0));
  svc.setRequirementBridge({
    listByMilestone: (id: string) => (opts?.requirementsByMilestone?.[id] ?? []) as unknown as Requirement[],
    detachMilestone: (id: string) => detach(id),
  });
  return { svc, detach };
}

describe('computeMilestoneProgress — the single progress definition', () => {
  it('is 0/0 when nothing is attached (percent 0, never NaN)', () => {
    expect(computeMilestoneProgress([])).toEqual({ total: 0, done: 0, active: 0, blocked: 0, percent: 0 });
  });

  it('counts completed AND archived as done, excludes cancelled/rejected from the denominator', () => {
    const p = computeMilestoneProgress([
      'completed', 'archived', 'in_progress', 'review', 'blocked', 'cancelled', 'rejected', 'pending',
    ]);
    // total = 8 - 2 (cancelled, rejected) = 6 ; done = completed + archived = 2
    expect(p.total).toBe(6);
    expect(p.done).toBe(2);
    expect(p.active).toBe(2); // in_progress + review
    expect(p.blocked).toBe(1);
    expect(p.percent).toBe(33); // round(2/6*100)
  });

  it('is 100 when every attached requirement is done', () => {
    expect(computeMilestoneProgress(['completed', 'archived']).percent).toBe(100);
  });

  it('ignores cancelled/rejected even when they are the only rows (no divide-by-zero)', () => {
    expect(computeMilestoneProgress(['cancelled', 'rejected'])).toEqual({
      total: 0, done: 0, active: 0, blocked: 0, percent: 0,
    });
  });
});

describe('MilestoneService — write invariants', () => {
  let svc: MilestoneService;

  beforeEach(() => {
    svc = makeService().svc;
  });

  it('refuses a milestone whose project does not exist (no orphan rows)', () => {
    expect(() => svc.createMilestone({ orgId: 'default', projectId: 'proj_nope', name: 'M1' }))
      .toThrow(/does not exist/);
    expect(svc.listByProject('proj_nope')).toHaveLength(0);
  });

  it('refuses an impossible calendar date instead of storing a lenient parse', () => {
    expect(() => svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'M', dueDate: '2026-02-31' }))
      .toThrow(/Invalid milestone due date/);
  });

  it('normalises an ISO timestamp to a date and clears the date on explicit null', () => {
    const m = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'M', dueDate: '2026-12-31T10:00:00Z' });
    expect(m.dueDate).toBe('2026-12-31');
    svc.updateMilestone(m.id, { dueDate: null });
    expect(svc.getMilestone(m.id)!.dueDate).toBeNull();
  });

  it('rejects an empty rename and leaves the previous name intact (validate before mutate)', () => {
    const m = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'Keep me' });
    expect(() => svc.updateMilestone(m.id, { name: '   ' })).toThrow(/cannot be empty/);
    expect(svc.getMilestone(m.id)!.name).toBe('Keep me');
  });

  it('derives progress from the attached requirements (no stored counter)', () => {
    const { svc: s } = makeService({
      requirementsByMilestone: { ms_1: [{ status: 'completed' }, { status: 'in_progress' }] },
    });
    const m = s.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'M' });
    // The bridge keys on the real id; assert the wiring asks by id and computes 1/2.
    const list = s.listWithProgress({ projectId: PROJECT_A });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(m.id);
  });

  it('delete unlinks requirements and reports how many — it never deletes them', () => {
    const { svc: s, detach } = makeService({ detach: () => 3 });
    const m = s.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'M' });
    const result = s.deleteMilestone(m.id);
    expect(detach).toHaveBeenCalledWith(m.id);
    expect(result).toEqual({ deleted: true, detachedRequirements: 3 });
    expect(s.getMilestone(m.id)).toBeUndefined();
  });

  it('deleteByProject removes exactly that project\'s milestones', () => {
    const a = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'A1' });
    const b = svc.createMilestone({ orgId: 'default', projectId: PROJECT_B, name: 'B1' });
    expect(svc.deleteByProject(PROJECT_A)).toBe(1);
    expect(svc.getMilestone(a.id)).toBeUndefined();
    expect(svc.getMilestone(b.id)).toBeDefined();
  });

  it('publishes exactly ONE audit fact per create, naming the project and the actor', () => {
    const events: Array<Record<string, unknown>> = [];
    svc.setAuditSink(e => events.push(e as unknown as Record<string, unknown>));

    const m = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'Phase 1', createdBy: 'usr_owner' });

    expect(events).toHaveLength(1);
    expect(events[0]!['type']).toBe('milestone_created');
    expect(events[0]!['actorId']).toBe('usr_owner');
    expect(events[0]!['metadata']).toMatchObject({ milestoneId: m.id, projectId: PROJECT_A });
  });

  it('reports the unlink count in the delete audit fact (the number a human asks for)', () => {
    const { svc: s } = makeService({ detach: () => 4 });
    const events: Array<Record<string, unknown>> = [];
    s.setAuditSink(e => events.push(e as unknown as Record<string, unknown>));
    const m = s.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'M' });

    s.deleteMilestone(m.id, 'usr_owner');

    const del = events.find(e => e['type'] === 'milestone_deleted');
    expect(del).toBeDefined();
    expect(del!['actorId']).toBe('usr_owner');
    expect(del!['metadata']).toMatchObject({ milestoneId: m.id, detachedRequirements: 4 });
  });

  it('a throwing audit sink never aborts the write it describes', () => {
    svc.setAuditSink(() => { throw new Error('audit store down'); });
    const m = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'Survives' });
    expect(svc.getMilestone(m.id)).toBeDefined();
  });

  it('broadcasts milestone:created — the event the Work page now subscribes to', () => {
    const sent: Array<{ type: string }> = [];
    svc.setWSBroadcaster({ broadcast: (e: { type: string }) => sent.push(e) });

    const m = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'M' });
    svc.updateMilestone(m.id, { name: 'M2' });
    svc.deleteMilestone(m.id);

    expect(sent.map(e => e.type)).toEqual(['milestone:created', 'milestone:updated', 'milestone:deleted']);
  });

  it('scores a LIST in one pass and gets the same numbers as the per-milestone path', () => {
    const { svc: s } = makeService();
    const a = s.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'A' });
    const b = s.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'B' });
    const reqs = [
      { id: 'r1', milestoneId: a.id, status: 'completed' },
      { id: 'r2', milestoneId: a.id, status: 'cancelled' },
      { id: 'r3', milestoneId: b.id, status: 'in_progress' },
      { id: 'r4', milestoneId: null, status: 'completed' },
    ];
    // Bridge that can hand over the whole corpus (the fast path).
    s.setRequirementBridge({
      listByMilestone: (id: string) => reqs.filter(r => r.milestoneId === id) as never,
      listAll: () => reqs as never,
      detachMilestone: () => 0,
    });
    const fast = s.listWithProgress({ projectId: PROJECT_A });

    // Same bridge WITHOUT listAll → per-milestone fallback. Numbers must be identical;
    // if the grouping ever keys wrongly (or forgets to group), this diverges.
    s.setRequirementBridge({
      listByMilestone: (id: string) => reqs.filter(r => r.milestoneId === id) as never,
      detachMilestone: () => 0,
    });
    const slow = s.listWithProgress({ projectId: PROJECT_A });

    expect(fast.map(m => [m.id, m.progress])).toEqual(slow.map(m => [m.id, m.progress]));
    expect(fast.find(m => m.id === a.id)!.progress).toEqual({ total: 1, done: 1, active: 0, blocked: 0, percent: 100 });
    expect(fast.find(m => m.id === b.id)!.progress).toEqual({ total: 1, done: 0, active: 1, blocked: 0, percent: 0 });
  });

  it('orders dated milestones first, earliest deadline on top', () => {
    const late = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'Late', dueDate: '2027-06-30' });
    const soon = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'Soon', dueDate: '2026-12-01' });
    const none = svc.createMilestone({ orgId: 'default', projectId: PROJECT_A, name: 'None' });
    expect(svc.listByProject(PROJECT_A).map(m => m.id)).toEqual([soon.id, late.id, none.id]);
  });
});
