import { describe, expect, it, vi } from 'vitest';
import { reopenHistoryEntry } from './historyReopen.ts';
import type { BrowserHistoryEntry } from './browserHistory.ts';
import type { DeliverableInfo } from '../api.ts';
import type { RightPanelPayload } from '../contexts/LayoutContext.tsx';

function deliverable(over: Partial<DeliverableInfo> = {}): DeliverableInfo {
  return {
    id: 'dlv_1',
    type: 'file',
    title: 'Quarterly report',
    summary: 'Numbers',
    reference: '/out/q3.md',
    tags: [],
    status: 'active',
    accessCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function entry(over: Partial<BrowserHistoryEntry>): BrowserHistoryEntry {
  return { kind: 'url', target: 'https://a.example.com', visitedAt: 1, visitCount: 1, ...over };
}

/**
 * One dispatch table for both history consumers (address bar + panel chrome):
 * `kind` alone decides which opener runs.
 */
describe('reopenHistoryEntry', () => {
  it('opens a browser tab for a url row', async () => {
    const openPanel = vi.fn<(p: RightPanelPayload) => void>();
    const outcome = await reopenHistoryEntry(
      entry({ kind: 'url', target: 'https://a.example.com', title: 'A' }),
      { openPanel },
    );
    expect(outcome).toBe('opened');
    expect(openPanel).toHaveBeenCalledWith({ kind: 'url', url: 'https://a.example.com', title: 'A' });
  });

  it('previews a local file row in the panel', async () => {
    const openPanel = vi.fn<(p: RightPanelPayload) => void>();
    const outcome = await reopenHistoryEntry(
      entry({ kind: 'file', target: '/Users/me/report.md', title: 'report.md' }),
      { openPanel },
    );
    expect(outcome).toBe('opened');
    expect(openPanel).toHaveBeenCalledWith({
      kind: 'file',
      path: '/Users/me/report.md',
      title: 'report.md',
    });
  });

  it('re-fetches a deliverable row instead of replaying a stored snapshot', async () => {
    const openPanel = vi.fn<(p: RightPanelPayload) => void>();
    const fresh = deliverable({ title: 'Renamed since the visit' });
    const getDeliverable = vi.fn().mockResolvedValue({ deliverable: fresh });

    const outcome = await reopenHistoryEntry(
      entry({ kind: 'deliverable', target: 'dlv_1', title: 'Old title', location: '/out/q3.md' }),
      { openPanel, getDeliverable },
    );

    expect(outcome).toBe('opened');
    expect(getDeliverable).toHaveBeenCalledWith('dlv_1');
    expect(openPanel).toHaveBeenCalledWith({ kind: 'deliverable', deliverable: fresh });
  });

  it('falls back to the recorded reference when the deliverable id no longer resolves', async () => {
    const openPanel = vi.fn<(p: RightPanelPayload) => void>();
    const getDeliverable = vi.fn().mockRejectedValue(new Error('404'));

    const outcome = await reopenHistoryEntry(
      entry({ kind: 'deliverable', target: 'dlv_gone', title: 'Gone', location: '/out/gone.md' }),
      { openPanel, getDeliverable },
    );

    expect(outcome).toBe('opened');
    expect(openPanel).toHaveBeenCalledWith({ kind: 'file', path: '/out/gone.md', title: 'Gone' });
  });

  it('skips a stale deliverable with nothing to fall back to', async () => {
    const openPanel = vi.fn<(p: RightPanelPayload) => void>();
    const getDeliverable = vi.fn().mockRejectedValue(new Error('404'));

    const outcome = await reopenHistoryEntry(
      entry({ kind: 'deliverable', target: 'dlv_gone' }),
      { openPanel, getDeliverable },
    );

    expect(outcome).toBe('skipped');
    expect(openPanel).not.toHaveBeenCalled();
  });

  it('skips everything when no panel host is available', async () => {
    const getDeliverable = vi.fn();
    const outcome = await reopenHistoryEntry(
      entry({ kind: 'file', target: '/a.md' }),
      { openPanel: null, getDeliverable },
    );
    expect(outcome).toBe('skipped');
    expect(getDeliverable).not.toHaveBeenCalled();
  });
});
