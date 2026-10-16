import { describe, it, expect } from 'vitest';
import { buildStatusCard, buildTaskCard, buildProgressCard, buildNotificationCard } from '../src/feishu/cards.js';

describe('buildNotificationCard', () => {
  it('builds a header + markdown body card', () => {
    const card = buildNotificationCard({ title: '审批请求', body: '请批准部署' });
    expect(card.header).toMatchObject({ title: { tag: 'plain_text', content: '审批请求' } });
    const body = (card.elements as any[])[0];
    expect(body).toMatchObject({ tag: 'div', text: { tag: 'lark_md', content: '请批准部署' } });
    // No actions → no action row.
    expect((card.elements as any[]).some((e) => e.tag === 'action')).toBe(false);
  });

  it('renders action buttons whose value carries the signed ref (never the approval id)', () => {
    const card = buildNotificationCard({
      title: '审批请求',
      body: '请批准部署',
      actions: [
        { id: 'approve', label: '批准', style: 'primary', ref: 'signed.ref.1' },
        { id: 'reject', label: '驳回', style: 'danger', ref: 'signed.ref.2' },
      ],
    });
    const actionEl = (card.elements as any[]).find((e) => e.tag === 'action');
    expect(actionEl.actions.map((a: any) => a.value)).toEqual([
      { ref: 'signed.ref.1', action: 'approve' },
      { ref: 'signed.ref.2', action: 'reject' },
    ]);
    expect(actionEl.actions[0].type).toBe('primary');
    expect(actionEl.actions[1].type).toBe('danger');
  });

  it('drops actions without a signed ref (an unresolvable button is worse than none)', () => {
    const card = buildNotificationCard({
      title: 't',
      body: 'b',
      actions: [
        { id: 'approve', label: '批准', ref: 'signed.ref.1' },
        { id: 'noop', label: '无', ref: '' },
      ],
    });
    const actionEl = (card.elements as any[]).find((e) => e.tag === 'action');
    expect(actionEl.actions).toHaveLength(1);
    expect(actionEl.actions[0].value.ref).toBe('signed.ref.1');
  });

  it('shows the origin (agent + team) as a footnote, not inside the body', () => {
    const card = buildNotificationCard({
      title: '审批',
      body: '部署请求',
      origin: { agentName: '运营助手', teamName: '平台开发组' },
    });
    const note = (card.elements as any[]).find((e) => e.tag === 'note');
    expect(note.elements[0].content).toBe('来自 运营助手 · 团队 平台开发组');
    // The body is untouched — the origin has exactly one home in the card.
    const bodyEl = (card.elements as any[]).find((e) => e.tag === 'div');
    expect(bodyEl.text.content).toBe('部署请求');
  });

  it('omits the team from the origin note when the agent has no team', () => {
    const card = buildNotificationCard({ title: 't', body: 'b', origin: { agentName: '运营助手' } });
    const note = (card.elements as any[]).find((e) => e.tag === 'note');
    expect(note.elements[0].content).toBe('来自 运营助手');
  });

  it('adds no origin note when no agent is known', () => {
    const card = buildNotificationCard({ title: 't', body: 'b' });
    expect((card.elements as any[]).find((e) => e.tag === 'note')).toBeUndefined();
  });
});

describe('buildStatusCard', () => {
  it('builds a card with header and content', () => {
    const card = buildStatusCard({
      agentName: 'Secretary',
      title: 'Status Update',
      content: 'All systems go',
      status: 'success',
    });
    expect(card.header.title.content).toBe('Status Update');
    expect(card.header.template).toBe('green');
    expect(card.config.wide_screen_mode).toBe(true);
  });

  it('includes action buttons when provided', () => {
    const card = buildStatusCard({
      agentName: 'Dev',
      title: 'Approve?',
      content: 'Ready to deploy',
      status: 'warning',
      actions: [{ text: 'Approve', value: 'approve', type: 'primary' }],
    });
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    expect(actionEl).toBeDefined();
    expect((actionEl as any).actions[0].value).toEqual({ action: 'approve', agent: 'Dev' });
  });

  it('defaults unknown status color to blue', () => {
    const card = buildStatusCard({
      agentName: 'A',
      title: 'T',
      content: 'C',
      status: 'info',
    });
    expect(card.header.template).toBe('blue');
  });
});

describe('buildTaskCard', () => {
  it('builds task fields and action buttons', () => {
    const card = buildTaskCard({
      agentName: 'Worker',
      taskId: 'tsk_1',
      taskTitle: 'Fix bug',
      description: 'Details here',
      priority: 'high',
      status: 'in_progress',
    });
    expect(card.header.title.content).toContain('Fix bug');
    const fieldsEl = card.elements.find((e: any) => e.fields);
    expect(fieldsEl).toBeDefined();
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    expect((actionEl as any).actions).toHaveLength(2);
  });

  it('handles unknown priority emoji gracefully', () => {
    const card = buildTaskCard({
      agentName: 'A',
      taskId: 't',
      taskTitle: 'T',
      description: 'D',
      priority: 'unknown',
      status: 'pending',
    });
    const fieldsEl = card.elements.find((e: any) => e.fields) as any;
    expect(fieldsEl.fields[0].text.content).toContain('unknown');
  });
});

describe('buildProgressCard', () => {
  it('renders step checklist', () => {
    const card = buildProgressCard({
      agentName: 'A',
      title: 'Progress',
      steps: [
        { name: 'Step 1', done: true },
        { name: 'Step 2', done: false },
      ],
    });
    const content = (card.elements[0] as any).text.content as string;
    expect(content).toContain('✅ Step 1');
    expect(content).toContain('⬜ Step 2');
  });

  it('appends summary when provided', () => {
    const card = buildProgressCard({
      agentName: 'A',
      title: 'Progress',
      steps: [{ name: 'Done', done: true }],
      summary: 'All complete',
    });
    expect(card.elements.length).toBeGreaterThan(2);
    const last = card.elements[card.elements.length - 1] as any;
    expect(last.text.content).toBe('All complete');
  });
});
