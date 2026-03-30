import type { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, success, fail, extractRows } from '../output.js';

function parseApproved(v: string): boolean {
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  fail('--approved must be true or false');
}

export function registerApprovalCommands(program: Command) {
  const root = program.command('approval').description('Approvals');

  root
    .command('list')
    .option('--status <s>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/approvals', opts.status ? { status: opts.status } : undefined);
        const rows = extractRows(data);
        table(rows, [
          { key: 'id', header: 'ID', width: 28 },
          { key: 'type', header: 'Type', width: 14 },
          { key: 'status', header: 'Status', width: 10 },
          { key: 'description', header: 'Description', width: 30 },
        ], { ...out, title: 'Approvals' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('respond <id>')
    .requiredOption('--approved <bool>', 'true or false')
    .option('--responded-by <id>')
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      const approved = parseApproved(opts.approved);
      try {
        const data = await client.post<unknown>(`/approvals/${encodeURIComponent(id)}`, {
          approved,
          ...(opts.respondedBy && { respondedBy: opts.respondedBy }),
        });
        success('Response recorded', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
