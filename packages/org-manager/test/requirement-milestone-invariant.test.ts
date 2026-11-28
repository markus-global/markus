/**
 * The ONE cross-entity invariant: a requirement's milestone must belong to the requirement's
 * OWN project.
 *
 * These are fail-closed tests: a rejected write must leave the requirement byte-identical
 * (not "throw after mutating"), because the whole point is that a bad reference never lands.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RequirementService } from '../src/requirement-service.js';

const PROJECT_A = 'proj_a';
const PROJECT_B = 'proj_b';

const MILESTONES: Record<string, { id: string; projectId: string; name: string }> = {
  ms_a: { id: 'ms_a', projectId: PROJECT_A, name: 'A · Phase 1' },
  ms_b: { id: 'ms_b', projectId: PROJECT_B, name: 'B · Phase 1' },
};

function makeService() {
  const svc = new RequirementService();
  svc.setProjectService({
    getProject: (id: string) => ([PROJECT_A, PROJECT_B].includes(id) ? { id } : undefined),
  });
  svc.setMilestoneLookup((id: string) => MILESTONES[id] ?? null);
  return svc;
}

function create(svc: RequirementService, projectId: string, milestoneId?: string) {
  return svc.createRequirement({
    orgId: 'default',
    title: 'T',
    description: 'D',
    projectId,
    milestoneId,
    source: 'user',
    createdBy: 'usr_owner',
  });
}

describe('requirement ↔ milestone project coupling', () => {
  let svc: RequirementService;

  beforeEach(() => {
    svc = makeService();
  });

  it('accepts a milestone of the requirement\'s own project', () => {
    const req = create(svc, PROJECT_A, 'ms_a');
    expect(req.projectId).toBe(PROJECT_A);
    expect(req.milestoneId).toBe('ms_a');
  });

  it('refuses to CREATE with a milestone of another project and writes nothing', () => {
    const before = svc.listRequirements({}).length;
    expect(() => create(svc, PROJECT_A, 'ms_b')).toThrow(/belongs to project proj_b/);
    expect(svc.listRequirements({}).length).toBe(before);
  });

  it('refuses an unknown milestone (no orphan reference)', () => {
    expect(() => create(svc, PROJECT_A, 'ms_ghost')).toThrow(/does not exist/);
  });

  it('refuses to MOVE a requirement to another project while it keeps a foreign milestone, and leaves it untouched', () => {
    const req = create(svc, PROJECT_A, 'ms_a');
    const snapshot = { projectId: req.projectId, milestoneId: req.milestoneId };

    expect(() => svc.updateRequirement(req.id, { projectId: PROJECT_B })).toThrow(/belongs to project proj_a/);

    const after = svc.getRequirement(req.id)!;
    expect({ projectId: after.projectId, milestoneId: after.milestoneId }).toEqual(snapshot);
  });

  it('allows the move when the caller also passes a milestone of the new project', () => {
    const req = create(svc, PROJECT_A, 'ms_a');
    const moved = svc.updateRequirement(req.id, { projectId: PROJECT_B, milestoneId: 'ms_b' });
    expect(moved.projectId).toBe(PROJECT_B);
    expect(moved.milestoneId).toBe('ms_b');
  });

  it('allows the move when the caller explicitly detaches (milestoneId: null)', () => {
    const req = create(svc, PROJECT_A, 'ms_a');
    const moved = svc.updateRequirement(req.id, { projectId: PROJECT_B, milestoneId: null });
    expect(moved.projectId).toBe(PROJECT_B);
    expect(moved.milestoneId).toBeUndefined();
  });

  it('detachMilestone clears only that milestone\'s requirements and reports the count', () => {
    const a1 = create(svc, PROJECT_A, 'ms_a');
    const a2 = create(svc, PROJECT_A, 'ms_a');
    const b1 = create(svc, PROJECT_B, 'ms_b');

    expect(svc.detachMilestone('ms_a')).toBe(2);
    expect(svc.getRequirement(a1.id)!.milestoneId).toBeUndefined();
    expect(svc.getRequirement(a2.id)!.milestoneId).toBeUndefined();
    expect(svc.getRequirement(b1.id)!.milestoneId).toBe('ms_b');
  });

  it('filters requirements by milestone server-side', () => {
    const inA = create(svc, PROJECT_A, 'ms_a');
    create(svc, PROJECT_A);
    expect(svc.listRequirements({ milestoneId: 'ms_a' }).map(r => r.id)).toEqual([inA.id]);
  });

  it('fails closed when the milestone lookup is not wired in this process', () => {
    const unwired = new RequirementService();
    unwired.setProjectService({ getProject: () => ({ id: PROJECT_A }) });
    expect(() => create(unwired, PROJECT_A, 'ms_a')).toThrow(/milestone lookup is unavailable/);
  });
});
