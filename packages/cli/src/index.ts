import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import { Command } from 'commander';
import { APP_VERSION, checkForUpdate } from '@markus/shared';
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

// Handle -v / --version with update check before Commander takes over
const versionArg = process.argv[2];
if (versionArg === '-v' || versionArg === '--version' || versionArg === '-V') {
  console.log(`v${APP_VERSION}`);
  checkForUpdate().then(info => {
    if (info.updateAvailable) {
      console.log(`\n  \x1b[33m⬆ Update available: v${info.latestVersion}\x1b[0m`);
      console.log(`  Run \x1b[1mnpm i -g @markus-global/cli\x1b[0m to upgrade`);
    }
    process.exit(0);
  }).catch(() => process.exit(0));
} else {

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
  const { registerStartCommand } = await import('./commands/start.js');
  registerStartCommand(program);

  const { registerInitCommand } = await import('./commands/init.js');
  registerInitCommand(program);

  const { registerModelCommand } = await import('./commands/model.js');
  registerModelCommand(program);

  const { registerModelsCommand } = await import('./commands/models.js');
  registerModelsCommand(program);

  const { registerDoctorCommand } = await import('./commands/doctor.js');
  registerDoctorCommand(program);

  const { registerAuthCommand } = await import('./commands/auth.js');
  registerAuthCommand(program);

  const { registerUpdateCommand } = await import('./commands/update.js');
  registerUpdateCommand(program);

  const { registerInstallAgentCommands } = await import('./commands/install-agent.js');
  registerInstallAgentCommands(program);

  const { registerAgentCommands } = await import('./commands/agent.js');
  registerAgentCommands(program);

  const { registerTaskCommands } = await import('./commands/task.js');
  registerTaskCommands(program);

  const { registerRequirementCommands } = await import('./commands/requirement.js');
  registerRequirementCommands(program);

  const { registerProjectCommands } = await import('./commands/project.js');
  registerProjectCommands(program);

  const admin = program.command('admin').description('System administration');
  const { registerSystemCommands } = await import('./commands/system.js');
  registerSystemCommands(admin);
}

registerCommands()
  .then(() => program.parseAsync(process.argv))
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

} // end of version-check else block
