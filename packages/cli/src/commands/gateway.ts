import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { detail, success, fail } from '../output.js';

function printManual(data: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === 'string') {
    console.log(data);
    return;
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    const md = o['markdown'] ?? o['content'] ?? o['body'] ?? o['manual'];
    if (typeof md === 'string') {
      console.log(md);
      return;
    }
  }
  console.log(JSON.stringify(data, null, 2));
}

export function registerGatewayCommands(program: Command) {
  const root = program.command('gateway').description('External agent gateway');

  root.command('info').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/gateway/info');
      detail(data, { ...out, title: 'Gateway info' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root
    .command('register')
    .requiredOption('--agent-id <id>')
    .requiredOption('--agent-name <n>')
    .option('--org-id <id>')
    .option('--capabilities <csv>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      const caps = opts.capabilities
        ? String(opts.capabilities).split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      try {
        const data = await client.post<unknown>('/gateway/register', {
          agentId: opts.agentId,
          agentName: opts.agentName,
          ...(opts.orgId && { orgId: opts.orgId }),
          ...(caps && { capabilities: caps }),
        });
        success('Gateway registration', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('auth')
    .requiredOption('--agent-id <id>')
    .requiredOption('--secret <s>')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.post<Record<string, unknown>>('/gateway/auth', {
          agentId: opts.agentId,
          secret: opts.secret,
          ...(opts.orgId && { orgId: opts.orgId }),
        });
        success('Authenticated', data, out);
        if (!out.json) {
          const token = data['token'] ?? data['accessToken'] ?? data['jwt'];
          if (token && typeof token === 'string') console.log(`Token: ${token}`);
        }
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('message')
    .requiredOption('--text <t>')
    .requiredOption('--api-key <k>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient({ server: g.server, apiKey: opts.apiKey });
      const out = { json: !!g.json };
      try {
        const data = await client.post<unknown>('/gateway/message', { text: opts.text });
        success('Message sent', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root.command('status').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/gateway/status');
      detail(data, { ...out, title: 'Gateway status' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('manual').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<unknown>('/gateway/manual');
      printManual(data, out.json);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('team').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/gateway/team');
      detail(data, { ...out, title: 'Gateway team' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });
}
