/**
 * Feishu Interactive Message Card builders.
 * These create card JSON payloads for rich agent interactions.
 */

export interface CardAction {
  tag: 'button';
  text: { tag: 'plain_text'; content: string };
  type: 'primary' | 'default' | 'danger';
  value: Record<string, string>;
}

export function buildStatusCard(opts: {
  agentName: string;
  title: string;
  content: string;
  status: 'success' | 'warning' | 'error' | 'info';
  actions?: Array<{ text: string; value: string; type?: 'primary' | 'default' | 'danger' }>;
}) {
  const colorMap = { success: 'green', warning: 'orange', error: 'red', info: 'blue' };

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: opts.content } },
  ];

  if (opts.actions?.length) {
    elements.push({
      tag: 'action',
      actions: opts.actions.map((a) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.text },
        type: a.type ?? 'default',
        value: { action: a.value, agent: opts.agentName },
      })),
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: colorMap[opts.status] ?? 'blue',
    },
    elements,
  };
}

export function buildTaskCard(opts: {
  agentName: string;
  taskId: string;
  taskTitle: string;
  description: string;
  priority: string;
  status: string;
}) {
  const priorityEmoji: Record<string, string> = {
    urgent: '🔴', high: '🟠', medium: '🔵', low: '⚪',
  };

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 ${opts.taskTitle}` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Priority:** ${priorityEmoji[opts.priority] ?? ''} ${opts.priority}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Status:** ${opts.status}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Agent:** ${opts.agentName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Task ID:** ${opts.taskId}` } },
        ],
      },
      { tag: 'div', text: { tag: 'lark_md', content: opts.description } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Mark Complete' },
            type: 'primary',
            value: { action: 'complete_task', taskId: opts.taskId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Reassign' },
            type: 'default',
            value: { action: 'reassign_task', taskId: opts.taskId },
          },
        ],
      },
    ],
  };
}

export function buildProgressCard(opts: {
  agentName: string;
  title: string;
  steps: Array<{ name: string; done: boolean }>;
  summary?: string;
}) {
  const stepsContent = opts.steps
    .map((s) => `${s.done ? '✅' : '⬜'} ${s.name}`)
    .join('\n');

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: stepsContent } },
  ];

  if (opts.summary) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: opts.summary } });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template: 'blue',
    },
    elements,
  };
}
