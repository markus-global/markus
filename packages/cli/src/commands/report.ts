import { Command } from 'commander';
import { createClient, ApiError } from '../api-client.js';
import { table, detail, success, fail, extractRows } from '../output.js';

export function registerReportCommands(program: Command) {
  const root = program.command('report').description('Reports and usage');

  root
    .command('generate')
    .requiredOption('--period <p>', 'daily | weekly | monthly')
    .option('--scope <s>')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      const period = String(opts.period).toLowerCase();
      if (!['daily', 'weekly', 'monthly'].includes(period)) fail('--period must be daily, weekly, or monthly');
      try {
        const data = await client.post<Record<string, unknown>>('/reports/generate', {
          period,
          ...(opts.scope && { scope: opts.scope }),
          ...(opts.orgId && { orgId: opts.orgId }),
        });
        success('Report generated', data, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });

  root
    .command('usage')
    .option('--org-id <id>')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const client = createClient(g);
      const out = { json: !!g.json };
      const q = opts.orgId ? { orgId: opts.orgId } : undefined;
      try {
        const usage = await client.get<Record<string, unknown>>('/usage', q);
        const agentsData = await client.get<Record<string, unknown>>('/usage/agents', q);
        if (out.json) {
          console.log(JSON.stringify({ usage, agents: agentsData }, null, 2));
          return;
        }
        const u = (usage.usage ?? usage) as Record<string, unknown>;
        detail(u, { title: 'Usage' });
        if (usage.plan) {
          const plan = usage.plan as Record<string, unknown>;
          const limits = (plan.limits ?? plan) as Record<string, unknown>;
          detail({ tier: plan.tier, ...limits }, { title: 'Plan limits' });
        }
        const agentRows = extractRows(agentsData);
        table(agentRows, [
          { key: 'agentName', header: 'Name', width: 20 },
          { key: 'role', header: 'Role', width: 18 },
          { key: 'status', header: 'Status', width: 8 },
          { key: 'tokensUsedToday', header: 'Tokens/Day', width: 12 },
          { key: 'totalTokensUsed', header: 'Total Tokens', width: 14 },
        ], { title: 'Usage by agent' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        throw e;
      }
    });
}
