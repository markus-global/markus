/**
 * Slice G4 — the outbound shape and the signed action reference.
 *
 * An approval button must never carry the internal approval id in the clear: the
 * outbound side signs a tiny payload, the inbound side verifies it. These tests
 * pin that round trip and, just as importantly, that a forged or tampered token
 * fails verification instead of resolving to the wrong approval.
 */
import { describe, it, expect } from 'vitest';
import {
  signActionRef,
  verifyActionRef,
  severityOfNotification,
} from '../src/gateway/outbound.js';

const SECRET = 'unit-test-secret';

describe('signActionRef / verifyActionRef', () => {
  it('round-trips a payload', () => {
    const token = signActionRef({ approvalId: 'apr_1', action: 'approve' }, SECRET);
    expect(verifyActionRef(token, SECRET)).toEqual({ approvalId: 'apr_1', action: 'approve' });
  });

  it('never exposes the internal approval id in the clear', () => {
    const token = signActionRef({ approvalId: 'apr_secret_id', action: 'approve' }, SECRET);
    expect(token).not.toContain('apr_secret_id');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signActionRef({ approvalId: 'apr_1', action: 'approve' }, SECRET);
    expect(verifyActionRef(token, 'other-secret')).toBeUndefined();
  });

  it('rejects a tampered payload even with the signature shape intact', () => {
    const token = signActionRef({ approvalId: 'apr_1', action: 'approve' }, SECRET);
    const [payload, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ approvalId: 'apr_2', action: 'approve' }),
    ).toString('base64url');
    expect(verifyActionRef(`${forgedPayload}.${sig}`, SECRET)).toBeUndefined();
    expect(payload).toBeDefined();
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyActionRef('not-a-token', SECRET)).toBeUndefined();
    expect(verifyActionRef('', SECRET)).toBeUndefined();
  });
});

describe('severityOfNotification', () => {
  it('treats approvals and failures as action_required', () => {
    expect(severityOfNotification({ type: 'approval_request' })).toBe('action_required');
    expect(severityOfNotification({ type: 'task_failed' })).toBe('action_required');
  });

  it('escalates urgent priority to action_required', () => {
    expect(severityOfNotification({ type: 'system', priority: 'urgent' })).toBe('action_required');
  });

  it('treats routine notifications as info', () => {
    expect(severityOfNotification({ type: 'task_completed', priority: 'normal' })).toBe('info');
    expect(severityOfNotification({ type: 'agent_report' })).toBe('info');
  });
});
