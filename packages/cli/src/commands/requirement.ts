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

function parseTags(raw?: string): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const tags = raw.split(',').map(s => s.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

export function registerRequirementCommands(program: Command) {
  const requirement = program.command('requirement').description('Manage requirements');

  requirement
    .command('list')
    .description('List requirements')
    .option('--org-id <id>', 'Organization id')
    .option('--status <status>', 'Filter by status')
    .option('--project-id <id>', 'Filter by project id')
    .option('--source <source>', 'Filter by source')
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        orgId?: string;
        status?: string;
        projectId?: string;
        source?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.get<{ requirements: Record<string, unknown>[] }>('/requirements', {
          orgId: globalOpts.orgId,
          status: globalOpts.status,
          projectId: globalOpts.projectId,
          source: globalOpts.source,
        });
        const rows = (res.requirements ?? []).map(r => ({
          id: String(r['id'] ?? ''),
          title: truncate(String(r['title'] ?? ''), 30),
          status: String(r['status'] ?? ''),
          priority: String(r['priority'] ?? ''),
          projectId: String(r['projectId'] ?? r['project_id'] ?? ''),
        }));
        table(
          rows,
          [
            { key: 'id', header: 'id' },
            { key: 'title', header: 'title', width: 30 },
            { key: 'status', header: 'status' },
            { key: 'priority', header: 'priority' },
            { key: 'projectId', header: 'projectId' },
          ],
          { ...opts, title: 'Requirements' },
        );
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  requirement
    .command('get <id>')
    .description('Get a requirement by id')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.get<{ requirement: Record<string, unknown> }>(`/requirements/${encodeURIComponent(id)}`);
        detail(res.requirement ?? {}, { ...opts, title: `Requirement ${id}` });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  requirement
    .command('create')
    .description('Create a requirement')
    .requiredOption('--title <title>', 'Title')
    .option('--description <text>', 'Description')
    .option('--priority <priority>', 'Priority')
    .option('--project-id <id>', 'Project id')
    .option('--org-id <id>', 'Organization id')
    .option('--tags <tags>', 'Comma-separated tags')
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        title: string;
        description?: string;
        priority?: string;
        projectId?: string;
        orgId?: string;
        tags?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      const body: Record<string, unknown> = {
        title: globalOpts.title,
        description: globalOpts.description ?? '',
        orgId: globalOpts.orgId ?? 'default',
      };
      if (globalOpts.priority !== undefined) body['priority'] = globalOpts.priority;
      if (globalOpts.projectId !== undefined) body['projectId'] = globalOpts.projectId;
      const tags = parseTags(globalOpts.tags);
      if (tags !== undefined) body['tags'] = tags;
      try {
        const res = await client.post<{ requirement: Record<string, unknown> }>('/requirements', body);
        success('Requirement created', res.requirement, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  requirement
    .command('update <id>')
    .description('Update a requirement')
    .option('--title <title>', 'Title')
    .option('--description <text>', 'Description')
    .option('--priority <priority>', 'Priority')
    .option('--tags <tags>', 'Comma-separated tags')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        title?: string;
        description?: string;
        priority?: string;
        tags?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      const body: Record<string, unknown> = {};
      if (globalOpts.title !== undefined) body['title'] = globalOpts.title;
      if (globalOpts.description !== undefined) body['description'] = globalOpts.description;
      if (globalOpts.priority !== undefined) body['priority'] = globalOpts.priority;
      const tags = parseTags(globalOpts.tags);
      if (tags !== undefined) body['tags'] = tags;
      if (Object.keys(body).length === 0) fail('Provide at least one of --title, --description, --priority, --tags');
      try {
        const res = await client.put<{ requirement: Record<string, unknown> }>(
          `/requirements/${encodeURIComponent(id)}`,
          body,
        );
        success('Requirement updated', res.requirement, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  requirement
    .command('approve <id>')
    .description('Approve a requirement')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.post<{ requirement: Record<string, unknown> }>(
          `/requirements/${encodeURIComponent(id)}/approve`,
        );
        success('Requirement approved', res.requirement, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  requirement
    .command('reject <id>')
    .description('Reject a requirement')
    .option('--reason <text>', 'Rejection reason')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        reason?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.post<{ requirement: Record<string, unknown> }>(
          `/requirements/${encodeURIComponent(id)}/reject`,
          { reason: globalOpts.reason ?? '' },
        );
        success('Requirement rejected', res.requirement, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  requirement
    .command('delete <id>')
    .description('Delete (cancel) a requirement')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.delete<Record<string, unknown>>(`/requirements/${encodeURIComponent(id)}`);
        success('Requirement deleted', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
