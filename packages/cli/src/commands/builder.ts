import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, detail, success, fail, extractRows } from '../output.js';

function seg(s: string) {
  return encodeURIComponent(s);
}

export function registerBuilderCommands(program: Command) {
  const root = program.command('builder').description('Builder artifacts');

  root.command('list').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/builder/artifacts');
      const rows = extractRows(data);
      table(rows, [
        { key: 'name', header: 'Name', width: 24 },
        { key: 'type', header: 'Type', width: 10 },
        { key: 'version', header: 'Version', width: 8 },
        { key: 'description', header: 'Description', width: 40 },
      ], { ...out, title: 'Artifacts' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('get <type> <name>').action(async (type, name, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>(`/builder/artifacts/${seg(type)}/${seg(name)}`);
      detail(data, { ...out, title: `${type}/${name}` });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('install <type> <name>').action(async (type, name, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.post<unknown>(`/builder/artifacts/${seg(type)}/${seg(name)}/install`);
      success('Installed', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('uninstall <type> <name>').action(async (type, name, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.post<unknown>(`/builder/artifacts/${seg(type)}/${seg(name)}/uninstall`);
      success('Uninstalled', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('delete <type> <name>').action(async (type, name, _opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.delete<unknown>(`/builder/artifacts/${seg(type)}/${seg(name)}`);
      success('Deleted', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });
}
