import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { detail, fail, success, table } from '../output.js';

function asObjectRecord(data: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return {};
}

function asRowArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ['tasks', 'items', 'data', 'results'] as const) {
      const v = o[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function parseBlockedBy(s: string | undefined): string[] | undefined {
  if (s === undefined || s === '') return undefined;
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function truncateTitle(t: unknown, max: number): string {
  const s = String(t ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function registerTaskCommands(program: Command): Command {
  const task = program.command('task').description('Task management');

  task
    .command('list')
    .description('GET /api/tasks')
    .option('--status <status>')
    .option('--agent-id <id>')
    .option('--project-id <id>')
    .option('--requirement-id <id>')
    .option('--org-id <id>')
    .option('--limit <n>', 'Max results')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<unknown>('/tasks', {
          status: opts.status,
          agentId: opts.agentId,
          projectId: opts.projectId,
          requirementId: opts.requirementId,
          orgId: opts.orgId,
          limit: opts.limit,
        });
        const rows = asRowArray(data);
        if (out.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        const mapped = rows.map(r => {
          const assigned =
            r.assignedAgentId ?? r.assigneeAgentId ?? r.assignee ?? r.assignedTo ?? r.agentId;
          return {
            id: r.id,
            title: r.title,
            status: r.status,
            priority: r.priority,
            assignedAgentId: assigned,
          };
        });
        table(
          mapped,
          [
            { key: 'id', header: 'id', width: 28 },
            { key: 'title', header: 'title', width: 30 },
            { key: 'status', header: 'status', width: 9 },
            { key: 'priority', header: 'priority', width: 8 },
            { key: 'assignedAgentId', header: 'assignedAgentId', width: 28 },
          ],
        );
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('get <id>')
    .description('GET /api/tasks/:id')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<unknown>(`/tasks/${encodeURIComponent(id)}`);
        detail(asObjectRecord(data), out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('create')
    .description('POST /api/tasks')
    .requiredOption('--title <title>')
    .option('--description <text>')
    .option('--priority <p>')
    .option('--assignee <id>')
    .option('--reviewer <id>')
    .option('--project-id <id>')
    .option('--type <type>')
    .option('--blocked-by <ids>', 'Comma-separated task ids')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const blockedBy = parseBlockedBy(opts.blockedBy);
        const body: Record<string, unknown> = { title: opts.title };
        if (opts.description !== undefined) body.description = opts.description;
        if (opts.priority !== undefined) body.priority = opts.priority;
        if (opts.assignee !== undefined) body.assignee = opts.assignee;
        if (opts.reviewer !== undefined) body.reviewer = opts.reviewer;
        if (opts.projectId !== undefined) body.projectId = opts.projectId;
        if (opts.type !== undefined) body.type = opts.type;
        if (blockedBy?.length) body.blockedBy = blockedBy;
        const data = await client.post<unknown>('/tasks', body);
        success('Task created', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('update <id>')
    .description('PUT /api/tasks/:id')
    .option('--title <title>')
    .option('--description <text>')
    .option('--priority <p>')
    .option('--status <status>')
    .option('--assignee <id>')
    .option('--project-id <id>')
    .option('--reviewer <id>')
    .option('--blocked-by <ids>', 'Comma-separated task ids')
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const body: Record<string, unknown> = {};
        if (opts.title !== undefined) body.title = opts.title;
        if (opts.description !== undefined) body.description = opts.description;
        if (opts.priority !== undefined) body.priority = opts.priority;
        if (opts.status !== undefined) body.status = opts.status;
        if (opts.assignee !== undefined) body.assignee = opts.assignee;
        if (opts.projectId !== undefined) body.projectId = opts.projectId;
        if (opts.reviewer !== undefined) body.reviewer = opts.reviewer;
        const blockedBy = parseBlockedBy(opts.blockedBy);
        if (blockedBy !== undefined) body.blockedBy = blockedBy;
        const data = await client.put<unknown>(`/tasks/${encodeURIComponent(id)}`, body);
        success('Task updated', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('approve <id>')
    .description('POST /api/tasks/:id/approve')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/approve`);
        success('Task approved', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('reject <id>')
    .description('POST /api/tasks/:id/reject')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/reject`);
        success('Task rejected', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('cancel <id>')
    .description('POST /api/tasks/:id/cancel')
    .option('--cascade', 'Cancel dependents', false)
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const body = opts.cascade ? { cascade: true } : undefined;
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/cancel`, body);
        success('Task cancelled', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('run <id>')
    .description('POST /api/tasks/:id/run')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/run`);
        success('Task run started', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('pause <id>')
    .description('POST /api/tasks/:id/pause')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/pause`);
        success('Task paused', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('resume <id>')
    .description('POST /api/tasks/:id/resume')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/resume`);
        success('Task resumed', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('retry <id>')
    .description('POST /api/tasks/:id/retry')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/retry`);
        success('Task retry requested', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('accept <id>')
    .description('POST /api/tasks/:id/accept')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/accept`);
        success('Task accepted', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('revision <id>')
    .description('POST /api/tasks/:id/revision')
    .option('--reason <text>')
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const body = opts.reason !== undefined ? { reason: opts.reason } : undefined;
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/revision`, body);
        success('Revision requested', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('archive <id>')
    .description('POST /api/tasks/:id/archive')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/archive`);
        success('Task archived', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('logs <id>')
    .description('GET /api/tasks/:id/logs')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<unknown>(`/tasks/${encodeURIComponent(id)}/logs`);
        const rec = asObjectRecord(data);
        if (Object.keys(rec).length) detail(rec, out);
        else console.log(JSON.stringify(data, null, 2));
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('comment <id>')
    .description('POST /api/tasks/:id/comments')
    .requiredOption('--content <text>')
    .option('--author-id <id>')
    .option('--author-name <name>')
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const body: Record<string, unknown> = { content: opts.content };
        if (opts.authorId !== undefined) body.authorId = opts.authorId;
        if (opts.authorName !== undefined) body.authorName = opts.authorName;
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/comments`, body);
        success('Comment added', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('comments <id>')
    .description('GET /api/tasks/:id/comments')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<unknown>(`/tasks/${encodeURIComponent(id)}/comments`);
        const rows = asRowArray(data);
        if (rows.length > 0) {
          const keys = Object.keys(rows[0]!);
          table(rows, keys.map(k => ({ key: k, header: k })), out);
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('subtasks <id>')
    .description('GET /api/tasks/:id/subtasks')
    .action(async (id, _opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<unknown>(`/tasks/${encodeURIComponent(id)}/subtasks`);
        const rows = asRowArray(data);
        if (rows.length > 0) {
          const keys = Object.keys(rows[0]!);
          table(rows, keys.map(k => ({ key: k, header: k })), out);
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('subtask-add <id>')
    .description('POST /api/tasks/:id/subtasks')
    .requiredOption('--title <title>')
    .action(async (id, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>(`/tasks/${encodeURIComponent(id)}/subtasks`, { title: opts.title });
        success('Subtask added', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('dashboard')
    .description('GET /api/tasks/dashboard')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string };
      const client = createClient(g);
      try {
        const data = await client.get<unknown>('/tasks/dashboard', { orgId: opts.orgId });
        console.log(JSON.stringify(data, null, 2));
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  task
    .command('board')
    .description('GET /api/taskboard')
    .option('--org-id <id>')
    .option('--project-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string };
      const client = createClient(g);
      try {
        const data = await client.get<unknown>('/taskboard', {
          orgId: opts.orgId,
          projectId: opts.projectId,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  return task;
}
