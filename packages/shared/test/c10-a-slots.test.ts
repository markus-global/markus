/**
 * C10-A — shared contract slots: the single org-slug validator and the
 * four-field nullable envelope `auth` slot.
 * Card: tsk_80517bb773ae1f41145ba8f3.
 * Design SSOT: docs/design/c10-a-identity-columns-2026-11-22.md (§D1, §D4).
 */
import { describe, it, expect } from 'vitest';
import { checkOrgSlug, formatAddress } from '../src/address.js';
import {
  buildDeliveryEnvelope,
  parseEnvelope,
  agentAddressRef,
  type EnvelopeAuth,
} from '../src/mail.js';

describe('C10-A checkOrgSlug: one rule set, shared with the address format', () => {
  it('accepts legal slugs', () => {
    for (const good of ['acme', 'org-default', 'a', 'a1', 'my-org-2']) {
      expect(checkOrgSlug(good).ok, `slug ${good} must be accepted`).toBe(true);
    }
  });

  it('rejects illegal / reserved slugs with a reason and an actionable hint', () => {
    for (const bad of ['Acme', 'a_b', 'www', '', 'a--b', '-lead', 'trail-', 'x'.repeat(31), 'markus']) {
      const res = checkOrgSlug(bad);
      expect(res.ok, `slug ${JSON.stringify(bad)} must be rejected`).toBe(false);
      if (!res.ok) {
        expect(['invalid_label', 'reserved_word']).toContain(res.reason);
        expect(res.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it('is exactly the org-segment rule of formatAddress (no second rule set)', () => {
    const labels = [
      'acme', 'Acme', 'a_b', 'www', '', 'a--b', '-lead', 'trail-',
      'x'.repeat(30), 'x'.repeat(31), 'markus', 'org-default', 'default',
    ];
    for (const label of labels) {
      const viaFormat = formatAddress('local', label);
      const viaCheck = checkOrgSlug(label);
      expect(viaCheck.ok, `parity broken for ${JSON.stringify(label)}`).toBe(viaFormat.ok);
      if (!viaFormat.ok && !viaCheck.ok) expect(viaCheck.reason).toBe(viaFormat.reason);
    }
  });
});

describe('C10-A envelope auth slot: four nullable fields, no writer yet', () => {
  it('EnvelopeAuth carries spf / dkim / dmarc / verified, all nullable', () => {
    // Compile-time shape assertion: all four fields accept null.
    const nullAuth: EnvelopeAuth = { spf: null, dkim: null, dmarc: null, verified: null };
    expect(Object.keys(nullAuth).sort()).toEqual(['dkim', 'dmarc', 'spf', 'verified']);
    const mixed: EnvelopeAuth = { spf: 'pass', dkim: 'fail', dmarc: 'none', verified: true };
    expect(mixed.verified).toBe(true);
  });

  it('buildDeliveryEnvelope still writes auth: null (values only once an adapter verifies)', () => {
    const env = buildDeliveryEnvelope({
      from: agentAddressRef('agt_a'),
      to: agentAddressRef('agt_b'),
      messageId: 'mbx_test',
      signalClass: 'a2a',
    });
    expect(env.auth).toBeNull();
  });

  it('parseEnvelope round-trips a populated auth slot without inventing values', () => {
    const env = buildDeliveryEnvelope({
      from: agentAddressRef('agt_a'),
      to: agentAddressRef('agt_b'),
      messageId: 'mbx_test',
      signalClass: 'a2a',
    });
    const auth: EnvelopeAuth = { spf: 'pass', dkim: null, dmarc: 'none', verified: false };
    const parsed = parseEnvelope(JSON.stringify({ ...env, auth }));
    expect(parsed?.auth).toEqual(auth);
    // Legacy envelope without auth stays null — no fabricated verification.
    const legacy = parseEnvelope(JSON.stringify(env));
    expect(legacy?.auth).toBeNull();
  });
});