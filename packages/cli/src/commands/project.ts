import type { Command } from 'commander';
import { ApiError, createClient } from '../api-client.js';
import { detail, fail, success, table } from '../output.js';

function outOpts(cmd: Command) {
  const g = cmd.optsWithGlobals() as { json?: boolean };
  return { json: !!g.json };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function parseRepositories(raw?: string): unknown[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    fail('Invalid JSON for --repositories (expected a JSON array)');
  }
}

function parseTeamIds(raw?: string): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
}

export function registerProjectCommands(program: Command): Command {
  const project = program.command('project').description('Manage projects');

  project
    .command('list')
    .description('List projects')
    .option('--org-id <id>', 'Organization id')
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; orgId?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = { json: !!globalOpts.json };
      try {
        const res = await client.get<{ projects: Record<string, unknown>[] }>('/projects', {
          orgId: globalOpts.orgId,
        });
        const projects = res.projects ?? [];
        if (opts.json) {
          console.log(JSON.stringify(projects, null, 2));
          return;
        }
        table(
          projects,
          [
            { key: 'id', header: 'id', width: 30 },
            { key: 'name', header: 'name', width: 20 },
            { key: 'status', header: 'status', width: 8 },
            { key: 'description', header: 'description', width: 30 },
          ],
          { title: 'Projects' },
        );
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  project
    .command('get <id>')
    .description('Get a project by id')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.get<{ project: Record<string, unknown> }>(`/projects/${encodeURIComponent(id)}`);
        detail(res.project ?? {}, { ...opts, title: `Project ${id}` });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  project
    .command('create')
    .description('Create a project')
    .requiredOption('--name <name>', 'Project name')
    .option('--description <text>', 'Description')
    .option('--org-id <id>', 'Organization id')
    .option('--repositories <json>', 'JSON array of repository objects')
    .option('--team-ids <ids>', 'Comma-separated team ids')
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        name: string;
        description?: string;
        orgId?: string;
        repositories?: string;
        teamIds?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      const repositories = parseRepositories(globalOpts.repositories);
      const teamIds = parseTeamIds(globalOpts.teamIds);
      const body: Record<string, unknown> = {
        name: globalOpts.name,
        description: globalOpts.description ?? '',
        orgId: globalOpts.orgId ?? 'default',
      };
      if (repositories !== undefined) body['repositories'] = repositories;
      if (teamIds !== undefined) body['teamIds'] = teamIds;
      try {
        const res = await client.post<{ project: Record<string, unknown> }>('/projects', body);
        success('Project created', res.project, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  project
    .command('update <id>')
    .description('Update a project')
    .option('--name <name>', 'Project name')
    .option('--description <text>', 'Description')
    .option('--repositories <json>', 'JSON array of repository objects')
    .option('--team-ids <ids>', 'Comma-separated team ids')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        name?: string;
        description?: string;
        repositories?: string;
        teamIds?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      const body: Record<string, unknown> = {};
      if (globalOpts.name !== undefined) body['name'] = globalOpts.name;
      if (globalOpts.description !== undefined) body['description'] = globalOpts.description;
      const repositories = parseRepositories(globalOpts.repositories);
      const teamIds = parseTeamIds(globalOpts.teamIds);
      if (repositories !== undefined) body['repositories'] = repositories;
      if (teamIds !== undefined) body['teamIds'] = teamIds;
      if (Object.keys(body).length === 0) fail('Provide at least one of --name, --description, --repositories, --team-ids');
      try {
        const res = await client.put<{ project: Record<string, unknown> }>(`/projects/${encodeURIComponent(id)}`, body);
        success('Project updated', res.project, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  project
    .command('delete <id>')
    .description('Delete a project')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.delete<Record<string, unknown>>(`/projects/${encodeURIComponent(id)}`);
        success('Project deleted', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  return project;
}
