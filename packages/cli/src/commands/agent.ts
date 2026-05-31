import type { Command } from 'commander';
import { createClient } from '../api-client.js';
import { table, detail, success } from '../output.js';

export function registerAgentCommands(program: Command) {
  const agent = program.command('agent').description('Interact with agents');

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
}
