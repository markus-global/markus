import { describe, it, expect } from 'vitest';
import { leanMessageMetadata, RESULT_KEEP_WHOLE_TOOLS } from '../src/message-lean.js';

/**
 * Chat history payload trim.
 *
 * Measured on a real production DB: 13.5k messages carried 6.9 MB of prose and
 * 304 MB of `metadata.segments` (44x) — 126 MB tool results, 104 MB intermediate
 * text. These tests pin the three rules that make the lean view safe:
 *   1. the final answer always survives (it is what the bubble renders),
 *   2. approval-decision JSON always survives (inline cards parse it),
 *   3. everything clipped is MARKED so the client can fetch the detail instead
 *      of silently rendering a lie.
 */

const CAP = 300;

function toolSeg(name: string, result: string, args: unknown = { file_path: '/x' }) {
  return { type: 'tool', tool: name, status: 'done', result, arguments: args, durationMs: 12, createdAt: '2026-01-01T00:00:00.000Z' };
}

function textSeg(content: string, thinking?: string) {
  return { type: 'text', content, ...(thinking ? { thinking } : {}), createdAt: '2026-01-01T00:00:00.000Z' };
}

describe('leanMessageMetadata', () => {
  it('keeps metadata that has no segments untouched', () => {
    const meta = { isError: true, taskId: 'tsk_1' };
    const out = leanMessageMetadata(meta);
    expect(out.truncated).toBe(false);
    expect(out.metadata).toEqual(meta);
  });

  it('returns null for missing metadata', () => {
    expect(leanMessageMetadata(null)).toEqual({ metadata: null, truncated: false });
    expect(leanMessageMetadata(undefined)).toEqual({ metadata: null, truncated: false });
  });

  it('drops intermediate text bodies but keeps the FINAL text segment whole', () => {
    const finalAnswer = 'FINAL: ' + 'y'.repeat(4000);
    const meta = { segments: [
      textSeg('intermediate narration step 1'),
      toolSeg('file_read', 'r'.repeat(50000)),
      textSeg(finalAnswer),
    ] };

    const out = leanMessageMetadata(meta);
    const segs = out.metadata!.segments as Array<Record<string, unknown>>;

    // intermediate text: body dropped, size recorded
    expect(segs[0]!['content']).toBe('');
    expect(segs[0]!['contentTruncated']).toBe(true);
    expect(segs[0]!['contentSize']).toBe(29);

    // final text: intact — this is the visible answer block
    expect(segs[2]!['content']).toBe(finalAnswer);
    expect(segs[2]!['contentTruncated']).toBeUndefined();

    expect(out.truncated).toBe(true);
    expect(out.metadata!['segmentsTruncated']).toBe(true);
  });

  it('drops tool arguments and non-approval results, recording their sizes', () => {
    const meta = { segments: [toolSeg('file_read', 'r'.repeat(50000))] };
    const out = leanMessageMetadata(meta);
    const seg = (out.metadata!.segments as Array<Record<string, unknown>>)[0]!;

    expect(seg['arguments']).toBeUndefined();
    expect(seg['argumentsDropped']).toBe(true);
    expect(seg['result']).toBe('');
    expect(seg['resultTruncated']).toBe(true);
    expect(seg['resultSize']).toBe(50000);
    // skeleton the collapsed row renders from survives
    expect(seg['tool']).toBe('file_read');
    expect(seg['status']).toBe('done');
    expect(seg['durationMs']).toBe(12);
    expect(out.truncated).toBe(true);
  });

  it.each([...RESULT_KEEP_WHOLE_TOOLS])('keeps the result of approval tool %s whole', (tool) => {
    const approvalJson = JSON.stringify({
      status: 'success',
      requirement: { id: 'req_1', status: 'pending', title: 't', description: 'd', priority: 'high' },
      task: { id: 'tsk_1', title: 't', description: 'd', assignedAgentId: 'agt_1', priority: 'high' },
      padding: 'z'.repeat(3000),
    });
    const meta = { segments: [toolSeg(tool, approvalJson)] };
    const out = leanMessageMetadata(meta);
    const seg = (out.metadata!.segments as Array<Record<string, unknown>>)[0]!;

    // Clipping this would make a pending approval silently disappear from chat.
    expect(seg['result']).toBe(approvalJson);
    expect(seg['resultTruncated']).toBeUndefined();
    expect(JSON.parse(seg['result'] as string).task.id).toBe('tsk_1');
  });

  it('caps thinking instead of removing it (the collapsed row counts thinking blocks)', () => {
    const meta = { segments: [textSeg('', 'T'.repeat(5000))] };
    const out = leanMessageMetadata(meta);
    const seg = (out.metadata!.segments as Array<Record<string, unknown>>)[0]!;

    expect((seg['thinking'] as string).length).toBe(200);
    expect(seg['thinkingTruncated']).toBe(true);
    expect(seg['thinking']!.length).toBeGreaterThan(0);
  });

  it('drops sub-agent progress logs', () => {
    const seg = { ...toolSeg('spawn_subagent', 'ok'), subagentLogs: [{ text: 'x'.repeat(100) }] };
    const out = leanMessageMetadata({ segments: [seg] });
    const leaned = (out.metadata!.segments as Array<Record<string, unknown>>)[0]!;

    expect(leaned['subagentLogs']).toBeUndefined();
    expect(leaned['subagentLogsDropped']).toBe(true);
  });

  it('preserves non-segment flags the UI needs eagerly', () => {
    const meta = {
      isError: true, emptyReply: true, taskId: 'tsk_1', activityLog: true, hasMore: false,
      segments: [toolSeg('file_read', 'r'.repeat(5000))],
    };
    const out = leanMessageMetadata(meta);
    expect(out.metadata!['isError']).toBe(true);
    expect(out.metadata!['emptyReply']).toBe(true);
    expect(out.metadata!['taskId']).toBe('tsk_1');
    expect(out.metadata!['activityLog']).toBe(true);
  });

  it('does not mutate the input (storage keeps full fidelity)', () => {
    const result = 'r'.repeat(5000);
    const meta = { segments: [toolSeg('file_read', result)] };
    leanMessageMetadata(meta);
    expect((meta.segments[0] as Record<string, unknown>)['result']).toBe(result);
  });

  it('shrinks a realistic long tool-loop message by an order of magnitude', () => {
    const segments = [];
    for (let i = 0; i < 25; i++) {
      segments.push(textSeg(`step ${i} narration ${'n'.repeat(200)}`, 'th'.repeat(100)));
      segments.push(toolSeg('file_read', 'x'.repeat(20000), { file_path: '/a/b', offset: 1, limit: 2000, padding: 'p'.repeat(500) }));
    }
    segments.push(textSeg('the final answer'));
    const original = JSON.stringify({ segments });

    const out = leanMessageMetadata({ segments });
    const leaned = JSON.stringify(out.metadata);

    expect(leaned.length * 20).toBeLessThan(original.length);
    expect(out.truncated).toBe(true);
  });

  it('never exceeds the caps for non-final text, thinking and error', () => {
    const meta = { segments: [
      textSeg('a'.repeat(10000)),          // intermediate (a later text exists) -> dropped
      toolSeg('read', 'r'.repeat(10), {}),
      { type: 'tool', tool: 'boom', status: 'error', error: 'e'.repeat(10000) },
      textSeg('final answer'),             // visible answer -> exempt by design
    ] };
    const out = leanMessageMetadata(meta);
    const segs = out.metadata!.segments as Array<Record<string, unknown>>[];

    for (const s of segs) {
      if (typeof s['content'] === 'string') expect(s['content'].length).toBeLessThanOrEqual(CAP);
      if (typeof s['thinking'] === 'string') expect(s['thinking'].length).toBeLessThanOrEqual(200);
      if (typeof s['error'] === 'string') expect(s['error'].length).toBeLessThanOrEqual(200);
    }
  });

  it('keeps a long single-text message whole (it is the only answer block)', () => {
    const answer = 'a'.repeat(10000);
    const out = leanMessageMetadata({ segments: [textSeg(answer)] });
    const seg = (out.metadata!.segments as Array<Record<string, unknown>>)[0]!;

    expect(seg['content']).toBe(answer);
    expect(out.truncated).toBe(false);
  });
});
