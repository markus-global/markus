/**
 * C9-A · 三个 fact 工具的行为契约
 *
 * 重点不是 happy path，而是两件容易退化的接线：
 *   1. `work_unit_ref` 只从 `turnWorkUnitRef()` 来 —— 为空时**工具层就拒绝**，
 *      不进 service（空值在这里是错误，不是默认值）；
 *   2. 工具不自己解析身份、不自己拼 SQL：只把参数整形后交给 port。
 */
import { describe, it, expect, vi } from 'vitest';
import { createFactTools } from '../src/tools/fact-tools.js';
import type { FactService, FactAssertInput, FactSupersedeInput, FactQuery } from '../src/facts/fact-service.js';

function fakeService() {
  const asserted: FactAssertInput[] = [];
  const superseded: FactSupersedeInput[] = [];
  const queries: FactQuery[] = [];
  const svc: FactService = {
    assert: vi.fn((input: FactAssertInput) => {
      asserted.push(input);
      return {
        status: 'asserted' as const,
        fact: {
          id: 'fact_1',
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          predicate: input.predicate,
          value: input.value,
          workUnitRef: input.workUnitRef,
          assertedBy: input.assertedBy,
          sourceRefs: input.sourceRefs,
          confidence: 1,
          createdAt: '2026-11-15T00:00:00.000Z',
        },
      };
    }),
    supersede: vi.fn((input: FactSupersedeInput) => {
      superseded.push(input);
      return { status: 'rejected' as const, code: 'not_found' as const, message: 'fake' };
    }),
    queryActive: vi.fn((q: FactQuery) => {
      queries.push(q);
      return [];
    }),
  };
  return { svc, asserted, superseded, queries };
}

const tools = (svc: FactService, ref: string | null) =>
  createFactTools({ agentId: 'agt_worker', facts: svc, turnWorkUnitRef: () => ref });

const byName = (list: ReturnType<typeof tools>, name: string) => {
  const tool = list.find(t => t.name === name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool;
};

const VALID_ARGS = {
  subject_kind: 'task',
  subject_id: 'tsk_a1',
  predicate: 'task.completion_evidence',
  value: { summary: 'landed', evidence_refs: ['dlv_1'] },
  source_refs: ['dlv_1'],
};

describe('tool surface', () => {
  it('exposes exactly the four agreed tools (three writers/readers + the verifier)', () => {
    const { svc } = fakeService();
    expect(tools(svc, 'task:tsk_a1:r1').map(t => t.name)).toEqual([
      'fact_assert',
      'fact_supersede',
      'fact_query',
      'fact_verify',
    ]);
  });

  it('fact_verify states producer != confirmer in its description', () => {
    const { svc } = fakeService();
    const desc = byName(tools(svc, null), 'fact_verify').description;
    expect(desc).toMatch(/CANNOT verify a fact you asserted/);
    expect(desc).toMatch(/write-once/);
  });

  it('fact_verify refuses an unbound turn with missing_provenance', async () => {
    const { svc } = fakeService();
    const raw = await byName(tools(svc, null), 'fact_verify').execute({
      fact_id: 'fact_1', result: 'pass', evidence_refs: ['cmt_1'],
    });
    expect(JSON.parse(raw).code).toBe('missing_provenance');
  });

  it('states the division of labour in fact_query (memory_search vs facts)', () => {
    const { svc } = fakeService();
    const desc = byName(tools(svc, null), 'fact_query').description;
    expect(desc).toMatch(/memory_search/);
    expect(desc).toMatch(/EXACT/);
  });
});

describe('identity wiring — turnWorkUnitRef is the only source', () => {
  it('passes the turn ref through untouched', async () => {
    const { svc, asserted } = fakeService();
    await byName(tools(svc, 'task:tsk_a1:r3'), 'fact_assert').execute({ ...VALID_ARGS });
    expect(asserted).toHaveLength(1);
    expect(asserted[0].workUnitRef).toBe('task:tsk_a1:r3');
    expect(asserted[0].assertedBy).toBe('agt_worker');
  });

  it('rejects with missing_provenance when the turn has no WorkUnit — before any write', async () => {
    const { svc, asserted } = fakeService();
    const out = JSON.parse(await byName(tools(svc, null), 'fact_assert').execute({ ...VALID_ARGS }));
    expect(out.status).toBe('rejected');
    expect(out.code).toBe('missing_provenance');
    expect(asserted).toHaveLength(0);
  });

  it('treats an empty-string ref as missing too (never a default)', async () => {
    const { svc, asserted } = fakeService();
    const out = JSON.parse(await byName(tools(svc, '   '), 'fact_assert').execute({ ...VALID_ARGS }));
    expect(out.code).toBe('missing_provenance');
    expect(asserted).toHaveLength(0);
  });

  it('applies the same rule to fact_supersede', async () => {
    const { svc, superseded } = fakeService();
    const out = JSON.parse(
      await byName(tools(svc, null), 'fact_supersede').execute({
        ...VALID_ARGS,
        superseded_fact_id: 'fact_0',
        reason: 'r',
      }),
    );
    expect(out.code).toBe('missing_provenance');
    expect(superseded).toHaveLength(0);
  });
});

describe('argument shaping', () => {
  it('rejects a bad subject_kind without calling the service', async () => {
    const { svc, asserted } = fakeService();
    const out = JSON.parse(
      await byName(tools(svc, 'task:tsk_a1:r1'), 'fact_assert').execute({
        ...VALID_ARGS,
        subject_kind: 'banana',
      }),
    );
    expect(out.code).toBe('invalid_subject');
    expect(asserted).toHaveLength(0);
  });

  it('requires superseded_fact_id on fact_supersede', async () => {
    const { svc, superseded } = fakeService();
    const out = JSON.parse(
      await byName(tools(svc, 'task:tsk_a1:r1'), 'fact_supersede').execute({ ...VALID_ARGS, reason: 'r' }),
    );
    expect(out.code).toBe('not_found');
    expect(superseded).toHaveLength(0);
  });

  it('normalizes a verification object and ignores a malformed one', async () => {
    const { svc, asserted } = fakeService();
    const list = tools(svc, 'task:tsk_a1:r1');
    await byName(list, 'fact_assert').execute({
      ...VALID_ARGS,
      verification: { result: 'pass', verified_by: 'agt_v', evidence_refs: ['c1'] },
    });
    expect(asserted[0].verification).toEqual({
      result: 'pass',
      verified_by: 'agt_v',
      evidence_refs: ['c1'],
    });

    await byName(list, 'fact_assert').execute({ ...VALID_ARGS, verification: { result: 'maybe' } });
    expect(asserted[1].verification).toBeUndefined();
  });

  it('drops non-string entries from source_refs instead of trusting the payload', async () => {
    const { svc, asserted } = fakeService();
    await byName(tools(svc, 'task:tsk_a1:r1'), 'fact_assert').execute({
      ...VALID_ARGS,
      source_refs: ['dlv_1', 42, null],
    });
    expect(asserted[0].sourceRefs).toEqual(['dlv_1']);
  });
});

describe('fact_query stays exact', () => {
  it('maps the query fields one-to-one and defaults to active-only', async () => {
    const { svc, queries } = fakeService();
    await byName(tools(svc, 'task:tsk_a1:r1'), 'fact_query').execute({
      subject_kind: 'task',
      subject_id: 'tsk_a1',
      predicate_prefix: 'task.',
    });
    expect(queries[0]).toEqual({
      subjectKind: 'task',
      subjectId: 'tsk_a1',
      predicate: undefined,
      predicatePrefix: 'task.',
      factId: undefined,
      activeOnly: true,
      limit: undefined,
    });
  });

  it('passes active_only:false through (history is readable on demand)', async () => {
    const { svc, queries } = fakeService();
    await byName(tools(svc, 'task:tsk_a1:r1'), 'fact_query').execute({ active_only: false });
    expect(queries[0].activeOnly).toBe(false);
  });
});
