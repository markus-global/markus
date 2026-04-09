import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Command } from 'commander';
import { APP_VERSION } from '@markus/shared';
import { setGlobalJson } from './output.js';

// Load .env file from project root
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

const program = new Command();

program
  .name('markus')
  .description('Markus — AI Digital Workforce Platform CLI')
  .version(`v${APP_VERSION}`, '-v, --version')
  .option('-s, --server <url>', 'API server URL', process.env['MARKUS_API_URL'] || 'http://localhost:8056')
  .option('-k, --api-key <key>', 'API key for authentication')
  .option('--json', 'Output in JSON format')
  .option('-c, --config <path>', 'Path to markus.json config file')
  .hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals();
    if (opts.json) setGlobalJson(true);
  });

// Lazy-load command modules to keep startup fast
async function registerCommands() {
  // ── 1. start ───────────────────────────────────────────────────────
  const { registerStartCommand } = await import('./commands/start.js');
  registerStartCommand(program);

  // ── 2. agent ───────────────────────────────────────────────────────
  const { registerAgentCommands } = await import('./commands/agent.js');
  registerAgentCommands(program);

  // ── 3. project (+ task, requirement, deliverable, report, review, approval)
  const { registerProjectCommands } = await import('./commands/project.js');
  const { registerTaskCommands } = await import('./commands/task.js');
  const { registerRequirementCommands } = await import('./commands/requirement.js');
  const { registerDeliverableCommands } = await import('./commands/deliverable.js');
  const { registerReportCommands } = await import('./commands/report.js');
  const { registerReviewCommands } = await import('./commands/review.js');
  const { registerApprovalCommands } = await import('./commands/approval.js');

  const projectCmd = registerProjectCommands(program);
  registerTaskCommands(projectCmd);
  registerRequirementCommands(projectCmd);
  registerDeliverableCommands(projectCmd);
  registerReportCommands(projectCmd);
  registerReviewCommands(projectCmd);
  registerApprovalCommands(projectCmd);

  // ── 4. team ────────────────────────────────────────────────────────
  const { registerTeamCommands } = await import('./commands/team.js');
  registerTeamCommands(program);

  // ── 4b. connect + install ─────────────────────────────────────────
  const { registerConnectCommands } = await import('./commands/connect.js');
  registerConnectCommands(program);

  const { registerInstallAgentCommands } = await import('./commands/install-agent.js');
  registerInstallAgentCommands(program);

  // ── 5. skill ───────────────────────────────────────────────────────
  const { registerSkillCommands } = await import('./commands/skill.js');
  registerSkillCommands(program);

  // ── 6. admin (+ system, audit, user, key, role, template, builder, gateway, external-agent, settings)
  const admin = program.command('admin').description('Platform administration and system controls');
  const { registerSystemCommands } = await import('./commands/system.js');
  const { registerAuditCommands } = await import('./commands/audit.js');
  const { registerUserCommands } = await import('./commands/user.js');
  const { registerKeyCommands } = await import('./commands/key.js');
  const { registerRoleCommands } = await import('./commands/role.js');
  const { registerTemplateCommands } = await import('./commands/template.js');
  const { registerBuilderCommands } = await import('./commands/builder.js');
  const { registerGatewayCommands } = await import('./commands/gateway.js');
  const { registerExternalAgentCommands } = await import('./commands/external-agent.js');
  const { registerSettingsCommands } = await import('./commands/settings.js');

  const systemCmd = registerSystemCommands(admin);
  registerAuditCommands(systemCmd);
  registerUserCommands(admin);
  registerKeyCommands(admin);
  registerRoleCommands(admin);
  registerTemplateCommands(admin);
  registerBuilderCommands(admin);
  registerGatewayCommands(admin);
  registerExternalAgentCommands(admin);
  registerSettingsCommands(admin);
}

registerCommands()
  .then(() => program.parseAsync(process.argv))
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
