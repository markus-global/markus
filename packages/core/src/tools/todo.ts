import type { AgentToolHandler } from '../agent.js';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

const agentTodos = new Map<string, TodoItem[]>();

function getList(agentId: string): TodoItem[] {
  if (!agentTodos.has(agentId)) agentTodos.set(agentId, []);
  return agentTodos.get(agentId)!;
}

export function createTodoWriteTool(agentId: string): AgentToolHandler {
  return {
    name: 'todo_write',
    description: 'Create or update a task list to track your progress on complex multi-step work. Use this to plan before coding and update status as you work.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Array of TODO items with id, content, and status',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            },
            required: ['id', 'content', 'status'],
          },
        },
        merge: {
          type: 'boolean',
          description: 'If true, merge with existing todos. If false, replace all.',
        },
      },
      required: ['todos'],
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const items = args['todos'] as TodoItem[];
      const merge = (args['merge'] as boolean) ?? true;
      const list = getList(agentId);

      if (!merge) {
        list.length = 0;
        list.push(...items);
      } else {
        for (const item of items) {
          const idx = list.findIndex((t) => t.id === item.id);
          if (idx >= 0) {
            list[idx] = { ...list[idx], ...item };
          } else {
            list.push(item);
          }
        }
      }

      return JSON.stringify({
        status: 'success',
        count: list.length,
        summary: list.map((t) => `[${t.status}] ${t.id}: ${t.content}`).join('\n'),
      });
    },
  };
}

export function createTodoReadTool(agentId: string): AgentToolHandler {
  return {
    name: 'todo_read',
    description: 'Read the current task list to check progress and decide what to work on next.',
    inputSchema: {
      type: 'object',
      properties: {},
    },

    async execute(): Promise<string> {
      const list = getList(agentId);
      if (list.length === 0) {
        return JSON.stringify({ status: 'success', message: 'No todos yet', todos: [] });
      }
      return JSON.stringify({
        status: 'success',
        todos: list,
        summary: {
          total: list.length,
          pending: list.filter((t) => t.status === 'pending').length,
          in_progress: list.filter((t) => t.status === 'in_progress').length,
          completed: list.filter((t) => t.status === 'completed').length,
        },
      });
    },
  };
}
