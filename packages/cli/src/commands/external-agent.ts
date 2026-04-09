import type { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, success, fail, extractRows } from '../output.js';

export function registerExternalAgentCommands(program: Command) {
  const root = program.command('external-agent').description('External agents');

  root
    .command('list')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/external-agents', opts.orgId ? { orgId: opts.orgId } : undefined);
        const rows = extractRows(data);
        table(rows, [
          { key: 'id', header: 'ID', width: 24 },
          { key: 'name', header: 'Name', width: 18 },
          { key: 'agentId', header: 'Agent ID', width: 24 },
          { key: 'platform', header: 'Platform', width: 12 },
          { key: 'connected', header: 'Online', width: 8 },
        ], { ...out, title: 'External agents' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('register')
    .option('--org-id <id>')
    .requiredOption('--agent-id <id>')
    .requiredOption('--name <n>')
    .option('--capabilities <csv>')
    .option('--platform <name>', 'Platform identifier (e.g. openclaw, hermes)')
    .option('--agent-card-url <url>', 'Agent Card URL for discovery')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      const caps = opts.capabilities
        ? String(opts.capabilities).split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      try {
        const data = await client.post<unknown>('/external-agents/register', {
          agentId: opts.agentId,
          name: opts.name,
          ...(opts.orgId && { orgId: opts.orgId }),
          ...(caps && { capabilities: caps }),
          ...(opts.platform && { platform: opts.platform }),
          ...(opts.agentCardUrl && { agentCardUrl: opts.agentCardUrl }),
        });
        success('External agent registered', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('delete <id>')
    .option('--org-id <id>')
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.delete<unknown>(
          `/external-agents/${encodeURIComponent(id)}`,
          opts.orgId ? { orgId: opts.orgId } : undefined,
        );
        success('External agent deleted', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
