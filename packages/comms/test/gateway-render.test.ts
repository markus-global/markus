/**
 * Slice G4 — capability-driven degradation.
 *
 * A notification must never be lost because a platform lacks a feature. The
 * renderer is a total function: interactive where the platform can show buttons,
 * markdown where it can format, plain text otherwise — and the plain-text
 * projection always carries the action labels *and* their signed refs, so a
 * button-less platform shows the same content rather than dropping it.
 */
import { describe, it, expect } from 'vitest';
import { renderOutbound, renderCapabilitiesOf } from '../src/gateway/render.js';
import type { OutboundMessage } from '../src/gateway/outbound.js';

const MSG: OutboundMessage = {
  title: '审批：部署到生产',
  body: 'Agent「Ops」申请部署 v1.2.3。',
  severity: 'action_required',
  actions: [
    { id: 'approve', label: '批准', style: 'primary', ref: 'ref-approve' },
    { id: 'reject', label: '驳回', style: 'danger', ref: 'ref-reject' },
  ],
};

describe('renderOutbound — degrade by capability', () => {
  it('renders an interactive card when the platform supports cards', () => {
    const out = renderOutbound(MSG, { cards: true, markdown: true });
    expect(out.format).toBe('card');
    expect(out.interactive).toBe(true);
    expect(out.actions).toHaveLength(2);
  });

  it('renders markdown when the platform formats but has no buttons', () => {
    const out = renderOutbound(MSG, { markdown: true });
    expect(out.format).toBe('markdown');
    expect(out.interactive).toBe(false);
  });

  it('renders plain text when the platform supports neither', () => {
    const out = renderOutbound(MSG, {});
    expect(out.format).toBe('text');
  });

  it('treats a buttons-only platform as interactive too', () => {
    const out = renderOutbound(MSG, { buttons: true });
    expect(out.format).toBe('card');
    expect(out.interactive).toBe(true);
  });

  it('always carries the action labels and refs in the plain-text projection', () => {
    for (const caps of [{}, { markdown: true }, { cards: true }]) {
      const out = renderOutbound(MSG, caps);
      expect(out.text).toContain('批准');
      expect(out.text).toContain('ref-approve');
      expect(out.text).toContain('驳回');
      expect(out.text).toContain('ref-reject');
      expect(out.text).toContain(MSG.title);
      expect(out.text).toContain(MSG.body);
    }
  });

  it('treats absent capabilities as the safe minimum (text)', () => {
    expect(renderOutbound(MSG).format).toBe('text');
  });
});

describe('renderCapabilitiesOf — derive from a manifest capability block', () => {
  it('maps cards to card + markdown', () => {
    expect(renderCapabilitiesOf({ cards: true })).toEqual({ cards: true, markdown: true });
  });

  it('keeps markdown for a formatting-only platform', () => {
    expect(renderCapabilitiesOf({ cards: false })).toEqual({ cards: false, markdown: true });
  });

  it('returns nothing for an unknown platform', () => {
    expect(renderCapabilitiesOf(undefined)).toEqual({});
  });
});
