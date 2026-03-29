import type { Command } from 'commander';
import { ApiError, createClient } from '../api-client.js';
import { detail, fail, list, success, table } from '../output.js';

function outOpts(cmd: Command) {
  const g = cmd.optsWithGlobals() as { json?: boolean };
  return { json: !!g.json };
}

type TeamListRow = Record<string, unknown>;

function showTeamStatus(
  data: { agents?: Array<Record<string, unknown>> },
  opts: { json: boolean },
  title: string,
) {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const agents = data.agents ?? [];
  table(
    agents.map(a => ({
      id: String(a['id'] ?? ''),
      name: String(a['name'] ?? ''),
      status: String(a['status'] ?? ''),
      role: String(a['role'] ?? ''),
    })),
    [
      { key: 'id', header: 'id' },
      { key: 'name', header: 'name' },
      { key: 'status', header: 'status' },
      { key: 'role', header: 'role' },
    ],
    { ...opts, title },
  );
}

export function registerTeamCommands(program: Command) {
  const team = program.command('team').description('Manage teams');

  team
    .command('list')
    .description('List teams')
    .option('--org-id <id>', 'Organization id')
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; orgId?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.get<{ teams: TeamListRow[] }>('/teams', {
          orgId: globalOpts.orgId,
        });
        const rows = (res.teams ?? []).map(t => {
          const members = t['members'];
          const memberCount =
            Array.isArray(members) ? members.length : typeof t['memberCount'] === 'number' ? (t['memberCount'] as number) : '';
          return {
            id: String(t['id'] ?? ''),
            name: String(t['name'] ?? ''),
            members: memberCount === '' ? '' : String(memberCount),
          };
        });
        table(
          rows,
          [
            { key: 'id', header: 'id' },
            { key: 'name', header: 'name' },
            { key: 'members', header: 'members' },
          ],
          { ...opts, title: 'Teams' },
        );
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('get <id>')
    .description('Get team agent status (GET /api/teams/:id/status)')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const data = await client.get<{ agents: Array<Record<string, unknown>> }>(
          `/teams/${encodeURIComponent(id)}/status`,
        );
        showTeamStatus(data, opts, `Team ${id} status`);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('create')
    .description('Create a team')
    .requiredOption('--name <name>', 'Team name')
    .option('--description <text>', 'Description')
    .option('--org-id <id>', 'Organization id')
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        name: string;
        description?: string;
        orgId?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      const body: Record<string, unknown> = {
        name: globalOpts.name,
        description: globalOpts.description,
        orgId: globalOpts.orgId,
      };
      try {
        const res = await client.post<{ team: Record<string, unknown> }>('/teams', body);
        success('Team created', res.team, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('update <id>')
    .description('Update a team')
    .option('--name <name>', 'Team name')
    .option('--description <text>', 'Description')
    .option('--manager-id <id>', 'Manager id')
    .option('--manager-type <type>', 'human or agent (used with --manager-id)', 'agent')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        name?: string;
        description?: string;
        managerId?: string;
        managerType?: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      const body: Record<string, unknown> = {};
      if (globalOpts.name !== undefined) body['name'] = globalOpts.name;
      if (globalOpts.description !== undefined) body['description'] = globalOpts.description;
      if (globalOpts.managerId !== undefined) {
        body['managerId'] = globalOpts.managerId;
        body['managerType'] = globalOpts.managerType ?? 'agent';
      }
      if (Object.keys(body).length === 0) fail('Provide at least one of --name, --description, --manager-id');
      try {
        const res = await client.patch<{ team: Record<string, unknown> }>(
          `/teams/${encodeURIComponent(id)}`,
          body,
        );
        success('Team updated', res.team, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('delete <id>')
    .description('Delete a team')
    .option('--delete-members', 'Remove members when deleting', false)
    .option('--purge-files', 'Purge team files', false)
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        deleteMembers?: boolean;
        purgeFiles?: boolean;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.delete<Record<string, unknown>>(`/teams/${encodeURIComponent(id)}`, {
          deleteMembers: globalOpts.deleteMembers ? 'true' : undefined,
          purgeFiles: globalOpts.purgeFiles ? 'true' : undefined,
        });
        success('Team deleted', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('add-member <id>')
    .description('Add a member to a team')
    .requiredOption('--member-id <id>', 'Member id')
    .requiredOption('--member-type <type>', 'human or agent')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        memberId: string;
        memberType: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.post<Record<string, unknown>>(`/teams/${encodeURIComponent(id)}/members`, {
          memberId: globalOpts.memberId,
          memberType: globalOpts.memberType,
        });
        success('Member added', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('remove-member <id>')
    .description('Remove a member from a team')
    .requiredOption('--member-id <id>', 'Member id')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as {
        server?: string;
        apiKey?: string;
        memberId: string;
        json?: boolean;
      };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.delete<Record<string, unknown>>(
          `/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(globalOpts.memberId)}`,
        );
        success('Member removed', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('start <id>')
    .description('Start all agents in a team')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.post<unknown>(`/teams/${encodeURIComponent(id)}/start`);
        success('Team started', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('stop <id>')
    .description('Stop all agents in a team')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.post<unknown>(`/teams/${encodeURIComponent(id)}/stop`);
        success('Team stopped', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('pause <id>')
    .description('Pause all agents in a team')
    .option('--reason <text>', 'Pause reason')
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
        const res = await client.post<unknown>(`/teams/${encodeURIComponent(id)}/pause`, {
          reason: globalOpts.reason,
        });
        success('Team paused', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('resume <id>')
    .description('Resume all agents in a team')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const res = await client.post<unknown>(`/teams/${encodeURIComponent(id)}/resume`);
        success('Team resumed', res, opts);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('status <id>')
    .description('Show team agent status')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const data = await client.get<{ agents: Array<Record<string, unknown>> }>(
          `/teams/${encodeURIComponent(id)}/status`,
        );
        showTeamStatus(data, opts, `Team ${id} status`);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  team
    .command('export <id>')
    .description('Export team files and metadata')
    .action(async (id: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(globalOpts);
      const opts = outOpts(cmd);
      try {
        const data = await client.get<{
          files: Record<string, string>;
          team: { id: string; name: string; description?: string };
        }>(`/teams/${encodeURIComponent(id)}/export`);
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        detail(
          {
            id: data.team.id,
            name: data.team.name,
            description: data.team.description ?? '',
            fileCount: Object.keys(data.files ?? {}).length,
          },
          { title: `Team ${id} export` },
        );
        list(Object.keys(data.files ?? {}).sort(), { title: 'File paths' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
