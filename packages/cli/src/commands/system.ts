import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { detail, success, fail } from '../output.js';

export function registerSystemCommands(program: Command): Command {
  const root = program.command('system').description('System control and governance');

  root.command('status').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const status = await client.get<unknown>('/system/status');
      const health = await client.get<unknown>('/health');
      if (out.json) {
        console.log(JSON.stringify({ status, health }, null, 2));
        return;
      }
      detail(status as Record<string, unknown>, { title: 'System status' });
      detail(health as Record<string, unknown>, { title: 'Health' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root
    .command('pause-all')
    .option('--reason <r>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>('/system/pause-all', opts.reason ? { reason: opts.reason } : {});
        success('All agents paused', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root.command('resume-all').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.post<unknown>('/system/resume-all');
      success('All agents resumed', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('emergency-stop').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.post<unknown>('/system/emergency-stop');
      success('Emergency stop executed', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('storage').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/system/storage');
      detail(data, { ...out, title: 'Storage' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('orphans').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<unknown>('/system/storage/orphans');
      if (out.json) console.log(JSON.stringify(data, null, 2));
      else detail(data as Record<string, unknown>, { title: 'Orphans' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root
    .command('announce')
    .option('--type <t>')
    .requiredOption('--title <t>')
    .requiredOption('--content <c>')
    .option('--priority <p>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>('/system/announcements', {
          title: opts.title,
          content: opts.content,
          ...(opts.type && { type: opts.type }),
          ...(opts.priority && { priority: opts.priority }),
        });
        success('Announcement sent', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('policy')
    .option('--set', 'PUT policy JSON from --body')
    .option('--body <json>', 'JSON body (required with --set)')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        if (opts.set) {
          if (!opts.body) fail('--body is required with --set');
          let parsed: unknown;
          try {
            parsed = JSON.parse(opts.body);
          } catch {
            fail('Invalid JSON in --body');
          }
          const data = await client.put<unknown>('/governance/policy', parsed);
          success('Policy updated', data, out);
        } else {
          const data = await client.get<Record<string, unknown>>('/governance/policy');
          detail(data, { ...out, title: 'Governance policy' });
        }
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  return root;
}
