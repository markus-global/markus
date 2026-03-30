import type { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, detail, success, fail, extractRows } from '../output.js';

export function registerTemplateCommands(program: Command) {
  const root = program.command('template').description('Templates');

  root
    .command('list')
    .option('--source <s>')
    .option('--category <c>')
    .option('--query <q>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/templates', {
          source: opts.source,
          category: opts.category,
          query: opts.query,
        });
        const rows = extractRows(data);
        table(rows, [
          { key: 'name', header: 'Name', width: 24 },
          { key: 'type', header: 'Type', width: 10 },
          { key: 'category', header: 'Category', width: 12 },
          { key: 'source', header: 'Source', width: 12 },
          { key: 'description', header: 'Description', width: 30 },
        ], { ...out, title: `Templates (${data.total ?? rows.length})` });
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
      const data = await client.get<Record<string, unknown>>(`/templates/${encodeURIComponent(id)}`);
      detail(data, { ...out, title: `Template ${id}` });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root
    .command('instantiate')
    .requiredOption('--template-id <id>')
    .requiredOption('--name <n>')
    .option('--org-id <id>')
    .option('--team-id <id>')
    .option('--agent-role <r>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>('/templates/instantiate', {
          templateId: opts.templateId,
          name: opts.name,
          ...(opts.orgId && { orgId: opts.orgId }),
          ...(opts.teamId && { teamId: opts.teamId }),
          ...(opts.agentRole && { agentRole: opts.agentRole }),
        });
        success('Template instantiated', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
