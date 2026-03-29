import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, success, fail, extractRows } from '../output.js';

export function registerDeliverableCommands(program: Command) {
  const root = program.command('deliverable').description('Manage deliverables');

  root
    .command('list')
    .option('--query <q>')
    .option('--project-id <id>')
    .option('--agent-id <id>')
    .option('--type <t>')
    .option('--status <s>')
    .option('--limit <n>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/deliverables', {
          query: opts.query,
          projectId: opts.projectId,
          agentId: opts.agentId,
          type: opts.type,
          status: opts.status,
          limit: opts.limit,
        });
        const rows = extractRows(data);
        table(rows, [
          { key: 'id', header: 'ID', width: 28 },
          { key: 'type', header: 'Type', width: 10 },
          { key: 'title', header: 'Title', width: 30 },
          { key: 'status', header: 'Status', width: 10 },
          { key: 'agentId', header: 'Agent', width: 28 },
        ], { ...out, title: `Deliverables (${data.total ?? rows.length} total)` });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('create')
    .requiredOption('--type <t>')
    .requiredOption('--title <t>')
    .option('--summary <s>')
    .option('--reference <r>')
    .option('--tags <csv>')
    .option('--task-id <id>')
    .option('--agent-id <id>')
    .option('--project-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      const tags = opts.tags ? String(opts.tags).split(',').map(s => s.trim()).filter(Boolean) : undefined;
      try {
        const body: Record<string, unknown> = {
          type: opts.type,
          title: opts.title,
          ...(opts.summary !== undefined && { summary: opts.summary }),
          ...(opts.reference !== undefined && { reference: opts.reference }),
          ...(tags && { tags }),
          ...(opts.taskId && { taskId: opts.taskId }),
          ...(opts.agentId && { agentId: opts.agentId }),
          ...(opts.projectId && { projectId: opts.projectId }),
        };
        const data = await client.post<Record<string, unknown>>('/deliverables', body);
        success('Deliverable created', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('update <id>')
    .option('--title <t>')
    .option('--summary <s>')
    .option('--reference <r>')
    .option('--tags <csv>')
    .option('--status <s>')
    .option('--type <t>')
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      const tags = opts.tags ? String(opts.tags).split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const body: Record<string, unknown> = {};
      if (opts.title !== undefined) body['title'] = opts.title;
      if (opts.summary !== undefined) body['summary'] = opts.summary;
      if (opts.reference !== undefined) body['reference'] = opts.reference;
      if (tags) body['tags'] = tags;
      if (opts.status !== undefined) body['status'] = opts.status;
      if (opts.type !== undefined) body['type'] = opts.type;
      try {
        const data = await client.put<Record<string, unknown>>(`/deliverables/${id}`, body);
        success('Deliverable updated', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root.command('delete <id>').action(async (id, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.delete<unknown>(`/deliverables/${id}`);
      success('Deliverable deleted', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });
}
