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

// ── Agent Response Cards (Phase 2: Streaming Status) ───────────────────

export type AgentCardPhase = 'thinking' | 'tool_calling' | 'responding' | 'done' | 'error';

export interface ToolCallEntry {
  name: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

/**
 * Build an interactive card showing agent processing status.
 * This card is sent once and then updated in-place as the agent progresses.
 */
export function buildAgentResponseCard(opts: {
  agentName: string;
  phase: AgentCardPhase;
  toolCalls?: ToolCallEntry[];
  content?: string;
  errorMessage?: string;
  elapsedMs?: number;
}) {
  const { agentName, phase, toolCalls, content, errorMessage, elapsedMs } = opts;

  const headerMap: Record<AgentCardPhase, { title: string; template: string }> = {
    thinking:     { title: `💭 ${agentName} 正在思考...`, template: 'blue' },
    tool_calling: { title: `🔧 ${agentName} 正在执行...`, template: 'blue' },
    responding:   { title: `✍️ ${agentName} 正在回复...`, template: 'blue' },
    done:         { title: `✅ ${agentName}`, template: 'green' },
    error:        { title: `❌ ${agentName} 处理失败`, template: 'red' },
  };

  const header = headerMap[phase];
  const elements: unknown[] = [];

  if (toolCalls?.length) {
    const toolLines = toolCalls.map(tc => {
      if (tc.status === 'running') return `⏳ 正在调用 \`${tc.name}\`...`;
      if (tc.status === 'error') return `❌ \`${tc.name}\` 失败`;
      const dur = tc.durationMs != null ? ` (${tc.durationMs}ms)` : '';
      return `✅ \`${tc.name}\` 完成${dur}`;
    }).join('\n');
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: toolLines } });
  }

  if (phase === 'thinking' && !toolCalls?.length && !content) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '正在分析您的消息...' } });
  }

  if (content) {
    if (toolCalls?.length) {
      elements.push({ tag: 'hr' });
    }
    elements.push({ tag: 'div', text: { tag: 'lark_md', content } });
  }

  if (errorMessage) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**错误:** ${errorMessage}` } });
  }

  if (phase === 'done' && elapsedMs != null) {
    const seconds = (elapsedMs / 1000).toFixed(1);
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `耗时 ${seconds}s` }],
    });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '...' } });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: header.title },
      template: header.template,
    },
    elements,
  };
}
