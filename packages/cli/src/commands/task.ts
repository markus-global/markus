import type { Command } from 'commander';
import { createClient } from '../api-client.js';
import { table, detail, success, withErrorHandling } from '../output.js';

export function registerTaskCommands(program: Command) {
  const task = program.command('task').description('Manage tasks');

  task.command('list')
    .description('List tasks')
    .option('--status <status>', 'Filter by status')
    .option('--agent <agentId>', 'Filter by assigned agent')
    .option('--project <projectId>', 'Filter by project')
    .option('--requirement <requirementId>', 'Filter by requirement')
    .option('--priority <priority>', 'Filter by priority')
    .option('--search <term>', 'Search by title/description')
    .option('--page <n>', 'Page number', '1')
    .option('--limit <n>', 'Items per page', '20')
    .action(withErrorHandling(async (opts: Record<string, string>) => {
      const client = createClient(program.optsWithGlobals());
      const query: Record<string, string | undefined> = {
        status: opts.status,
        assignedAgentId: opts.agent,
        projectId: opts.project,
        requirementId: opts.requirement,
        priority: opts.priority,
        search: opts.search,
        page: opts.page,
        pageSize: opts.limit,
      };
      const data = await client.get<{ tasks: Record<string, unknown>[]; total: number }>('/tasks', query);
      table(data.tasks, [
        { key: 'id', header: 'ID', width: 28 },
        { key: 'title', header: 'Title', width: 30 },
        { key: 'status', header: 'Status', width: 12 },
        { key: 'priority', header: 'Priority', width: 8 },
        { key: 'assignedAgentId', header: 'Agent', width: 20 },
      ], { title: `Tasks (${data.total} total)` });
    }));

  task.command('show <id>')
    .description('Show task details')
    .action(withErrorHandling(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<Record<string, unknown>>(`/tasks/${id}`);
      detail(data, { title: `Task: ${data.title ?? id}` });
    }));

  task.command('deps <id>')
    .description('Show task dependencies')
    .action(withErrorHandling(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<{ upstream: Record<string, unknown>[]; downstream: Record<string, unknown>[] }>(`/tasks/${id}/dependents`);
      if (data.upstream?.length) {
        table(data.upstream, [
          { key: 'id', header: 'ID', width: 28 },
          { key: 'title', header: 'Title', width: 30 },
          { key: 'status', header: 'Status', width: 12 },
        ], { title: 'Upstream (blocked by)' });
      }
      if (data.downstream?.length) {
        table(data.downstream, [
          { key: 'id', header: 'ID', width: 28 },
          { key: 'title', header: 'Title', width: 30 },
          { key: 'status', header: 'Status', width: 12 },
        ], { title: 'Downstream (blocks)' });
      }
      if (!data.upstream?.length && !data.downstream?.length) {
        success('No dependencies found');
      }
    }));

  task.command('context <id>')
    .description('Show full task context (task + requirement + project + dependencies)')
    .action(withErrorHandling(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<Record<string, unknown>>(`/tasks/${id}/context`);
      detail(data, { title: 'Task Context' });
    }));

  task.command('note <id>')
    .description('Add a note/comment to a task')
    .requiredOption('-t, --text <text>', 'Note text')
    .option('--author <name>', 'Author name')
    .action(withErrorHandling(async (id: string, opts: { text: string; author?: string }) => {
      const client = createClient(program.optsWithGlobals());
      const body: Record<string, unknown> = { content: opts.text };
      if (opts.author) body.authorName = opts.author;
      await client.post(`/tasks/${id}/comments`, body);
      success(`Note added to task ${id}`);
    }));

  task.command('comment <id>')
    .description('Add a comment to a task (alias for note)')
    .requiredOption('-t, --text <text>', 'Comment text')
    .option('--author <name>', 'Author name')
    .action(withErrorHandling(async (id: string, opts: { text: string; author?: string }) => {
      const client = createClient(program.optsWithGlobals());
      const body: Record<string, unknown> = { content: opts.text };
      if (opts.author) body.authorName = opts.author;
      await client.post(`/tasks/${id}/comments`, body);
      success(`Comment added to task ${id}`);
    }));

  task.command('progress <id>')
    .description('Report task progress')
    .requiredOption('-t, --text <text>', 'Progress update text')
    .option('--percent <n>', 'Progress percentage (0-100)')
    .action(withErrorHandling(async (id: string, opts: { text: string; percent?: string }) => {
      const client = createClient(program.optsWithGlobals());
      let content = `[Progress] ${opts.text}`;
      if (opts.percent) content = `[Progress ${opts.percent}%] ${opts.text}`;
      await client.post(`/tasks/${id}/comments`, { content });
      success(`Progress reported for task ${id}`);
    }));
}
