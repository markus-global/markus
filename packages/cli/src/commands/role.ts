import type { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, detail, fail, extractRows } from '../output.js';

export function registerRoleCommands(program: Command) {
  const root = program.command('role').description('Role templates');

  root.command('list').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/roles');
      const rows = extractRows(data);
      table(rows, [
        { key: 'name', header: 'Name', width: 24 },
        { key: 'description', header: 'Description', width: 40 },
        { key: 'source', header: 'Source', width: 12 },
      ], { ...out, title: 'Roles' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('get <name>').action(async (name, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>(`/roles/${encodeURIComponent(name)}`);
      detail(data, { ...out, title: `Role ${name}` });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });
}
