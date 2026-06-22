import type { Command } from 'commander';
import { createClient } from '../api-client.js';
import { table, detail, withErrorHandling } from '../output.js';

export function registerProjectCommands(program: Command) {
  const proj = program.command('project').description('Manage projects');

  proj.command('list')
    .description('List projects')
    .action(withErrorHandling(async () => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<{ projects: Record<string, unknown>[] }>('/projects');
      table(data.projects, [
        { key: 'id', header: 'ID', width: 28 },
        { key: 'name', header: 'Name', width: 25 },
        { key: 'status', header: 'Status', width: 10 },
        { key: 'description', header: 'Description', width: 30 },
      ], { title: 'Projects' });
    }));

  proj.command('show <id>')
    .description('Show project details')
    .action(withErrorHandling(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<Record<string, unknown>>(`/projects/${id}`);
      detail(data, { title: `Project: ${data.name ?? id}` });
    }));
}
