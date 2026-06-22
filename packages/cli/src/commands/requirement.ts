import type { Command } from 'commander';
import { createClient } from '../api-client.js';
import { table, detail, withErrorHandling } from '../output.js';

export function registerRequirementCommands(program: Command) {
  const req = program.command('requirement').alias('req').description('Manage requirements');

  req.command('list')
    .description('List requirements')
    .option('--status <status>', 'Filter by status')
    .option('--project <projectId>', 'Filter by project')
    .option('--source <source>', 'Filter by source (user/agent/workflow)')
    .action(withErrorHandling(async (opts: Record<string, string>) => {
      const client = createClient(program.optsWithGlobals());
      const query: Record<string, string | undefined> = {
        status: opts.status,
        projectId: opts.project,
        source: opts.source,
      };
      const data = await client.get<{ requirements: Record<string, unknown>[] }>('/requirements', query);
      table(data.requirements, [
        { key: 'id', header: 'ID', width: 28 },
        { key: 'title', header: 'Title', width: 30 },
        { key: 'status', header: 'Status', width: 12 },
        { key: 'priority', header: 'Priority', width: 8 },
        { key: 'source', header: 'Source', width: 10 },
      ], { title: 'Requirements' });
    }));

  req.command('show <id>')
    .description('Show requirement details')
    .action(withErrorHandling(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<Record<string, unknown>>(`/requirements/${id}`);
      detail(data, { title: `Requirement: ${data.title ?? id}` });
    }));
}
