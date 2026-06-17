import { describe, it, expect } from 'vitest';
import { buildStatusCard, buildTaskCard, buildProgressCard } from '../src/feishu/cards.js';

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
