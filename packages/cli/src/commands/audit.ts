import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, detail, fail, extractRows } from '../output.js';

export function registerAuditCommands(program: Command) {
  const root = program.command('audit').description('Audit log and usage');

  root
    .command('log')
    .option('--org-id <id>')
    .option('--agent-id <id>')
    .option('--type <t>')
    .option('--limit <n>')
    .option('--since <iso>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<unknown>('/audit', {
          orgId: opts.orgId,
          agentId: opts.agentId,
          type: opts.type,
          limit: opts.limit,
          since: opts.since,
        });
        const rows = extractRows(data);
        table(rows, [
          { key: 'orgId', header: 'orgId', width: 7 },
          { key: 'agentId', header: 'agentId', width: 28 },
          { key: 'type', header: 'type', width: 11 },
          { key: 'action', header: 'action', width: 16 },
          { key: 'durationMs', header: 'durationMs', width: 10 },
          { key: 'success', header: 'success', width: 7 },
          { key: 'id', header: 'id', width: 15 },
          { key: 'timestamp', header: 'timestamp', width: 24 },
        ], { ...out, title: 'Audit log' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('summary')
    .option('--org-id <id>')
    .option('--agent-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/audit/summary', {
          orgId: opts.orgId,
          agentId: opts.agentId,
        });
        detail(data, { ...out, title: 'Audit summary' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('tokens')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<unknown>('/audit/tokens', opts.orgId ? { orgId: opts.orgId } : undefined);
        if (out.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          detail(data as Record<string, unknown>, { title: 'Token audit' });
        } else {
          const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
          const keys = rows[0] ? Object.keys(rows[0]).slice(0, 12) : [];
          table(rows, keys.map(k => ({ key: k, header: k })), { title: 'Token audit' });
        }
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
