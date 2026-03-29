import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, success, fail, extractRows } from '../output.js';

export function registerUserCommands(program: Command) {
  const root = program.command('user').description('Human users');

  root
    .command('list')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/users', opts.orgId ? { orgId: opts.orgId } : undefined);
        const rows = extractRows(data);
        table(rows, [
          { key: 'id', header: 'ID', width: 28 },
          { key: 'name', header: 'Name', width: 20 },
          { key: 'role', header: 'Role', width: 14 },
          { key: 'email', header: 'Email', width: 24 },
        ], { ...out, title: 'Users' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('add')
    .requiredOption('--name <n>')
    .option('--role <r>')
    .option('--email <e>')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>('/users', {
          name: opts.name,
          ...(opts.role && { role: opts.role }),
          ...(opts.email && { email: opts.email }),
          ...(opts.orgId && { orgId: opts.orgId }),
        });
        success('User added', data, out);
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
      const data = await client.delete<unknown>(`/users/${encodeURIComponent(id)}`);
      success('User deleted', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });
}
