import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { detail, fail } from '../output.js';

export function registerSettingsCommands(program: Command) {
  const root = program.command('settings').description('Server settings');

  root.command('llm').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/settings/llm');
      detail(data, { ...out, title: 'LLM settings' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('env-models').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.get<Record<string, unknown>>('/settings/env-models');
      detail(data, { ...out, title: 'Env models' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root
    .command('oauth-status')
    .option('--provider <p>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      try {
        const data = await client.get<Record<string, unknown>>('/settings/oauth/status', {
          provider: opts.provider,
        });
        detail(data, { ...out, title: 'OAuth status' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
