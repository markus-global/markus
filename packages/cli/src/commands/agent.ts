import { Command } from 'commander';
import { createClient } from '../api-client.js';
import { table, detail, success, fail } from '../output.js';

export function registerAgentCommands(program: Command) {
  const agent = program.command('agent').description('Manage agents');

  agent
    .command('list')
    .description('List all agents')
    .action(async () => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<{ agents: Record<string, unknown>[] }>('/agents');
      table(data.agents, [
        { key: 'id', header: 'ID', width: 28 },
        { key: 'name', header: 'Name', width: 20 },
        { key: 'role', header: 'Role', width: 18 },
        { key: 'status', header: 'Status', width: 10 },
        { key: 'agentRole', header: 'Type', width: 10 },
      ], { title: 'Agents' });
    });

  agent
    .command('get <id>')
    .description('Get agent details')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<Record<string, unknown>>(`/agents/${id}`);
      detail(data, { title: `Agent: ${data.name ?? id}` });
    });

  agent
    .command('create')
    .description('Create a new agent')
    .requiredOption('-n, --name <name>', 'Agent name')
    .requiredOption('-r, --role <role>', 'Role template name')
    .option('--org <orgId>', 'Organization ID', 'default')
    .option('--team <teamId>', 'Team ID')
    .option('--agent-role <type>', 'Agent role (worker/manager)', 'worker')
    .option('--skills <skills>', 'Comma-separated skill names')
    .action(async (opts: Record<string, string>) => {
      const client = createClient(program.optsWithGlobals());
      const body: Record<string, unknown> = {
        name: opts.name,
        roleName: opts.role,
        orgId: opts.org,
        agentRole: opts.agentRole,
      };
      if (opts.team) body.teamId = opts.team;
      if (opts.skills) body.skills = opts.skills.split(',').map(s => s.trim());
      const data = await client.post<{ agent: Record<string, unknown> }>('/agents', body);
      success(`Agent created: ${data.agent.id}`, data.agent);
    });

  agent
    .command('delete <id>')
    .description('Delete an agent')
    .option('--purge', 'Also delete agent files')
    .action(async (id: string, opts: { purge?: boolean }) => {
      const client = createClient(program.optsWithGlobals());
      await client.delete(`/agents/${id}`, { purgeFiles: opts.purge ? 'true' : undefined });
      success(`Agent ${id} deleted.`);
    });

  agent
    .command('start <id>')
    .description('Start an agent')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      await client.post(`/agents/${id}/start`);
      success(`Agent ${id} started.`);
    });

  agent
    .command('stop <id>')
    .description('Stop an agent')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      await client.post(`/agents/${id}/stop`);
      success(`Agent ${id} stopped.`);
    });

  agent
    .command('message <id>')
    .description('Send a one-shot message to an agent')
    .requiredOption('-t, --text <text>', 'Message text')
    .option('--sender <senderId>', 'Sender ID')
    .option('--session <sessionId>', 'Session ID')
    .action(async (id: string, opts: Record<string, string>) => {
      const client = createClient(program.optsWithGlobals());
      const body: Record<string, unknown> = { text: opts.text };
      if (opts.sender) body.senderId = opts.sender;
      if (opts.session) body.sessionId = opts.session;
      const data = await client.post<{ reply?: string }>(`/agents/${id}/message`, body);
      success(data.reply ?? '(no reply)', data);
    });

  agent
    .command('chat <id>')
    .description('Interactive chat with an agent')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      // Verify agent exists
      const info = await client.get<Record<string, unknown>>(`/agents/${id}`);
      const name = info.name ?? id;
      console.log(`\nChatting with ${name}. Type "quit" to exit.\n`);

      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = () => {
        rl.question('You: ', async (input: string) => {
          const text = input.trim();
          if (text === 'quit' || text === 'exit') { rl.close(); return; }
          if (!text) { ask(); return; }
          try {
            const data = await client.post<{ reply?: string }>(`/agents/${id}/message`, { text });
            console.log(`\n${name}: ${data.reply ?? '(no reply)'}\n`);
          } catch (err) {
            console.error(`Error: ${err}`);
          }
          ask();
        });
      };
      ask();
    });

  agent
    .command('config <id>')
    .description('Update agent configuration')
    .option('-n, --name <name>', 'New agent name')
    .option('--agent-role <type>', 'Agent role (worker/manager)')
    .option('--skills <skills>', 'Comma-separated skill names')
    .option('--heartbeat <ms>', 'Heartbeat interval in milliseconds')
    .action(async (id: string, opts: Record<string, string>) => {
      const client = createClient(program.optsWithGlobals());
      const body: Record<string, unknown> = {};
      if (opts.name) body.name = opts.name;
      if (opts.agentRole) body.agentRole = opts.agentRole;
      if (opts.skills) body.skills = opts.skills.split(',').map(s => s.trim());
      if (opts.heartbeat) body.heartbeatIntervalMs = Number(opts.heartbeat);
      if (Object.keys(body).length === 0) fail('No config options provided.');
      const data = await client.patch<{ ok: boolean; config: Record<string, unknown> }>(`/agents/${id}/config`, body);
      success(`Agent ${id} config updated.`, data.config);
    });

  agent
    .command('memory <id>')
    .description('Get agent memory summary')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<Record<string, unknown>>(`/agents/${id}/memory`);
      detail(data, { title: 'Memory' });
    });

  agent
    .command('files <id>')
    .description('List agent role files')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<{ files: Record<string, unknown> }>(`/agents/${id}/files`);
      detail(data.files, { title: 'Agent Files' });
    });

  agent
    .command('skill-add <id>')
    .description('Add a skill to an agent')
    .requiredOption('-n, --skill-name <name>', 'Skill name')
    .action(async (id: string, opts: { skillName: string }) => {
      const client = createClient(program.optsWithGlobals());
      await client.post(`/agents/${id}/skills`, { skillName: opts.skillName });
      success(`Skill "${opts.skillName}" added to agent ${id}.`);
    });

  agent
    .command('skill-remove <id>')
    .description('Remove a skill from an agent')
    .requiredOption('-n, --skill-name <name>', 'Skill name')
    .action(async (id: string, opts: { skillName: string }) => {
      const client = createClient(program.optsWithGlobals());
      await client.delete(`/agents/${id}/skills/${opts.skillName}`);
      success(`Skill "${opts.skillName}" removed from agent ${id}.`);
    });

  agent
    .command('activities <id>')
    .description('List agent activities')
    .option('--type <type>', 'Filter by activity type')
    .option('--limit <n>', 'Max results', '20')
    .action(async (id: string, opts: Record<string, string>) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.get<{ activities: Record<string, unknown>[] }>(
        `/agents/${id}/activities`,
        { type: opts.type, limit: opts.limit },
      );
      table(data.activities, [
        { key: 'id', header: 'ID', width: 30 },
        { key: 'type', header: 'Type', width: 12 },
        { key: 'label', header: 'Label', width: 30 },
        { key: 'startedAt', header: 'Started', width: 20 },
        { key: 'success', header: 'OK', width: 5 },
      ], { title: 'Activities' });
    });

  agent
    .command('heartbeat <id>')
    .description('Trigger agent heartbeat')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      await client.post(`/agents/${id}/heartbeat/trigger`);
      success(`Heartbeat triggered for agent ${id}.`);
    });

  agent
    .command('daily-report <id>')
    .description('Generate agent daily report')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      await client.post(`/agents/${id}/daily-report`);
      success(`Daily report generated for agent ${id}.`);
    });

  agent
    .command('role-sync <id>')
    .description('Sync agent role from template')
    .action(async (id: string) => {
      const client = createClient(program.optsWithGlobals());
      const data = await client.post<Record<string, unknown>>(`/agents/${id}/role-sync`);
      success(`Role synced for agent ${id}.`, data);
    });
}
