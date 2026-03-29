import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, success, fail, extractRows } from '../output.js';

export function registerKeyCommands(program: Command) {
  const root = program.command('key').description('API keys');

  root
    .command('list')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/keys', opts.orgId ? { orgId: opts.orgId } : undefined);
        const rows = extractRows(data);
        table(rows, [
          { key: 'id', header: 'ID', width: 28 },
          { key: 'name', header: 'Name', width: 20 },
          { key: 'createdAt', header: 'Created', width: 24 },
        ], { ...out, title: 'Keys' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('create')
    .option('--name <n>')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<Record<string, unknown>>('/keys', {
          ...(opts.name && { name: opts.name }),
          ...(opts.orgId && { orgId: opts.orgId }),
        });
        success('API key created', data, out);
        if (!out.json && data) {
          const t = data['token'] ?? data['key'] ?? data['apiKey'];
          if (t) console.log(`Token: ${t}`);
        }
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
      const data = await client.delete<unknown>(`/keys/${encodeURIComponent(id)}`);
      success('Key deleted', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });
}
