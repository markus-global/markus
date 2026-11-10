/**
 * Cut-1 golden contract: `routeMailboxItem()` is the single decision point for
 * 「how is this item routed」. These assertions ARE the behaviour contract —
 * they lock today's routing facts so the refactor proves itself behaviour-neutral,
 * and they bite the moment anyone re-scatters a rule outside `route()`.
 */
import { describe, it, expect } from 'vitest';
import {
  routeMailboxItem,
  MAILBOX_TYPE_REGISTRY,
  isStrictStateItem,
  resolveEntityKeys,
  type MailboxItemType,
  type MailboxPayload,
} from '../src/types/mailbox.js';

function lite(sourceType: MailboxItemType, payload: Partial<MailboxPayload> = {}, metadata?: Record<string, unknown>) {
  return {
    sourceType,
    payload: { summary: '', content: '', ...payload } as MailboxPayload,
    metadata,
  };
}

/** The golden table — every field of every type, exactly as the legacy scattered
 *  readers computed it on 2026-11-09. Changing any cell must be a conscious act. */
const GOLDEN: Record<MailboxItemType, {
  priority: number;
  invokesLLM: boolean;
  affinity: readonly string[];
  strictState: boolean;
  triageStaleDrop: boolean;
}> = {
  system_event:         { priority: 1, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: false },
  human_chat:           { priority: 0, invokesLLM: true,  affinity: ['task', 'requirement', 'conversation', 'system'], strictState: false, triageStaleDrop: false },
  task_comment:         { priority: 2, invokesLLM: false, affinity: ['task', 'requirement', 'system'], strictState: false, triageStaleDrop: false },
  mention:              { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'user', 'conversation', 'system'], strictState: false, triageStaleDrop: false },
  session_reply:        { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'conversation', 'system'], strictState: false, triageStaleDrop: false },
  task_status_update:   { priority: 1, invokesLLM: false, affinity: ['task', 'system'], strictState: false, triageStaleDrop: true },
  a2a_message:          { priority: 2, invokesLLM: true,  affinity: ['task', 'requirement', 'channel', 'system'], strictState: false, triageStaleDrop: false },
  review_request:       { priority: 1, invokesLLM: true,  affinity: ['task', 'requirement', 'system'], strictState: true,  triageStaleDrop: false },
  requirement_comment:  { priority: 2, invokesLLM: false, affinity: ['task', 'requirement', 'system'], strictState: false, triageStaleDrop: false },
  requirement_update:   { priority: 1, invokesLLM: false, affinity: ['requirement', 'system'], strictState: false, triageStaleDrop: false },
  daily_report:         { priority: 2, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: true },
  heartbeat:            { priority: 3, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: true },
  memory_consolidation: { priority: 4, invokesLLM: true,  affinity: ['system'], strictState: false, triageStaleDrop: true },
  workflow_update:      { priority: 2, invokesLLM: true,  affinity: ['task', 'requirement', 'system'], strictState: false, triageStaleDrop: false },
  callback_result:      { priority: 1, invokesLLM: true,  affinity: ['conversation', 'system'], strictState: false, triageStaleDrop: true },
};

describe('routeMailboxItem — golden decision table', () => {
  for (const [type, want] of Object.entries(GOLDEN) as [MailboxItemType, typeof GOLDEN[MailboxItemType]][]) {
    it(`${type} routes exactly as the legacy readers did`, () => {
      const r = routeMailboxItem(lite(type));
      expect(r.type).toBe(type);
      expect(r.priority).toBe(want.priority);
      expect(r.invokesLLM).toBe(want.invokesLLM);
      expect(r.affinity).toEqual(want.affinity);
      expect(r.strictState).toBe(want.strictState);
      expect(r.triageStaleDrop).toBe(want.triageStaleDrop);
    });
  }
});

describe('routeMailboxItem — strictState predicates', () => {
  it('triggerExecution is authoritative regardless of type', () => {
    const r = routeMailboxItem(lite('task_status_update', { extra: { triggerExecution: true } }));
    expect(r.strictState).toBe(true);
  });

  it('review_request is authoritative', () => {
    expect(routeMailboxItem(lite('review_request')).strictState).toBe(true);
  });

  it('requirement_update is authoritative only with actionRequired', () => {
    expect(routeMailboxItem(lite('requirement_update', { extra: { actionRequired: true } })).strictState).toBe(true);
    expect(routeMailboxItem(lite('requirement_update')).strictState).toBe(false);
  });

  it('workflow_update is authoritative only with actionRequired', () => {
    expect(routeMailboxItem(lite('workflow_update', { extra: { actionRequired: true } })).strictState).toBe(true);
    expect(routeMailboxItem(lite('workflow_update')).strictState).toBe(false);
  });
});

describe('routeMailboxItem — identity-based idempotency key', () => {
  it('review_request with taskId+round → type:task:round', () => {
    const r = routeMailboxItem(lite('review_request', { taskId: 'tsk_x', extra: { round: 2 } }));
    expect(r.dedupeKey).toBe('review_request:tsk_x:2');
  });

  it('reads round from metadata too', () => {
    const r = routeMailboxItem(lite('review_request', { taskId: 'tsk_x' }, { round: 3 }));
    expect(r.dedupeKey).toBe('review_request:tsk_x:3');
  });

  it('missing taskId or round → no constraint', () => {
    expect(routeMailboxItem(lite('review_request', { taskId: 'tsk_x' })).dedupeKey).toBeUndefined();
    expect(routeMailboxItem(lite('review_request', { extra: { round: 1 } })).dedupeKey).toBeUndefined();
  });

  it('non-deduping types never constrain', () => {
    expect(routeMailboxItem(lite('task_comment', { taskId: 'tsk_x', extra: { round: 1 } })).dedupeKey).toBeUndefined();
  });
});

describe('routeMailboxItem — pure and conservative', () => {
  it('is a pure function (same input → same output)', () => {
    const item = lite('mention', { taskId: 't1' }, { senderId: 'u1' });
    expect(routeMailboxItem(item)).toEqual(routeMailboxItem(item));
  });

  it('unknown type falls back conservatively (no throw, no silent drop)', () => {
    const r = routeMailboxItem({ sourceType: 'bogus_type' as MailboxItemType, payload: { summary: '', content: '' } });
    expect(r.invokesLLM).toBe(true);
    expect(r.priority).toBe(2);
    expect(r.affinity).toEqual(['system']);
    expect(r.strictState).toBe(false);
    expect(r.triageStaleDrop).toBe(false);
    expect(r.dedupeKey).toBeUndefined();
  });
});

describe('consumers must not fork from route()', () => {
  it('registry has no flat policy fields left — policy is nested', () => {
    const d = MAILBOX_TYPE_REGISTRY.human_chat as unknown as Record<string, unknown>;
    expect(d.policy).toBeTruthy();
    expect(d.priority).toBeUndefined();
    expect(d.defaultPriority).toBeUndefined();
    expect(d.invokesLLM).toBeUndefined();
    expect(d.entityScopes).toBeUndefined();
  });

  it('isStrictStateItem agrees with route() for every type', () => {
    for (const type of Object.keys(GOLDEN) as MailboxItemType[]) {
      expect(isStrictStateItem(lite(type))).toBe(routeMailboxItem(lite(type)).strictState);
    }
  });

  it('resolveEntityKeys derives keys only from route().affinity', () => {
    // A payload with every possible entity populated: the keys produced must be
    // exactly the affinity dims route() declares (minus system fallback).
    const item = lite('human_chat', { taskId: 't1', requirementId: 'r1' }, { senderId: 'u1', dbSessionId: 's1' });
    const keys = resolveEntityKeys(item, 'agent1');
    expect(keys).toContain('task:t1');
    expect(keys).toContain('req:r1');
    expect(keys).toContain('conv:s1');
  });
});
