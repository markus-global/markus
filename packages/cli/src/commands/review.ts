import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, detail, success, fail, extractRows } from '../output.js';

export function registerReviewCommands(program: Command) {
  const root = program.command('review').description('Code / task reviews');

  root
    .command('run')
    .requiredOption('--task-id <id>')
    .option('--agent-id <id>')
    .option('--description <d>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<Record<string, unknown>>('/reviews', {
          taskId: opts.taskId,
          ...(opts.agentId && { agentId: opts.agentId }),
          ...(opts.description && { description: opts.description }),
        });
        success('Review started', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('list')
    .option('--task-id <id>')
    .option('--limit <n>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/reviews', {
          taskId: opts.taskId,
          limit: opts.limit,
        });
        const rows = extractRows(data);
        table(rows, [
          { key: 'id', header: 'ID', width: 28 },
          { key: 'taskId', header: 'Task', width: 28 },
          { key: 'status', header: 'Status', width: 10 },
          { key: 'verdict', header: 'Verdict', width: 10 },
          { key: 'createdAt', header: 'Created', width: 24 },
        ], { ...out, title: 'Reviews' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root.command('get <id>').action(async (id, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>(`/reviews/${id}`);
      detail(data, { ...out, title: `Review ${id}` });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });
}
