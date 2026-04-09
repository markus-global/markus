import type { Command } from 'commander';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createClient, ApiError } from '../api-client.js';
import { fail } from '../output.js';
import {
  findConnector,
  loadConnectors,
  scanInstalledPlatforms,
  writePlatformConfig,
  installSkillTemplate,
} from '../connector-service.js';

export function registerInstallAgentCommands(program: Command) {
  program
    .command('install <platform>')
    .description('Install an external agent platform and connect it to Markus')
    .option('--org-id <id>', 'Organization ID', 'default')
    .option('--agent-name <name>', 'Agent display name')
    .option('--skip-install', 'Skip npm install (platform already installed)')
    .option('--skip-init', 'Skip platform initialization')
    .option('--skip-connect', 'Only install, do not register with Markus')
    .action(async (platform: string, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };

      const connector = findConnector(platform);
      if (!connector) {
        const available = loadConnectors().map(c => c.platform).join(', ');
        fail(`Unknown platform "${platform}". Available: ${available || 'none'}`);
        return;
      }

      console.log(`\n  Installing ${connector.displayName}...\n`);

      // Step 1: Check if already installed
      const scan = scanInstalledPlatforms();
      const existing = scan.find(s => s.platform === platform);
      const alreadyInstalled = existing?.installed;

      if (alreadyInstalled && !opts.skipInstall) {
        console.log(`  [1/5] ${connector.displayName} is already installed.`);
      } else if (opts.skipInstall) {
        console.log(`  [1/5] Skipping installation (--skip-install).`);
      } else {
        // Install via npm or custom command
        const installCmd = connector.installation.installCommand
          ?? (connector.installation.npmPackage ? `npm install -g ${connector.installation.npmPackage}` : null);

        if (!installCmd) {
          fail(`No installation method defined for ${connector.displayName}.`);
          return;
        }

        console.log(`  [1/5] Installing: ${installCmd}`);
        try {
          execSync(installCmd, { stdio: 'inherit', timeout: 300_000 });
          console.log(`         Installation complete.`);
        } catch (e) {
          fail(`Installation failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }

      // Step 2: Initialize the platform
      if (!opts.skipInit && connector.installation.initCommand) {
        console.log(`  [2/5] Initializing: ${connector.installation.initCommand}`);
        try {
          execSync(connector.installation.initCommand, { stdio: 'inherit', timeout: 120_000 });
        } catch (e) {
          console.log(`         Warning: init command failed (${e instanceof Error ? e.message : String(e)}). Continuing...`);
        }
      } else {
        console.log(`  [2/5] Initialization skipped.`);
      }

      if (opts.skipConnect) {
        console.log(`  [3/5] Connection skipped (--skip-connect).`);
        console.log(`  [4/5] Token generation skipped.`);
        console.log(`  [5/5] Config write skipped.`);
        console.log(`\n  ${connector.displayName} installed. Run \`markus connect add ${platform}\` to connect later.\n`);
        return;
      }

      // Step 3-5: Register, authenticate, and configure (same as `markus connect add`)
      const client = createClient(g);
      const serverUrl = g.server || process.env['MARKUS_API_URL'] || 'http://localhost:8056';
      const agentId = `${platform}-${randomBytes(4).toString('hex')}`;
      const agentName = opts.agentName || connector.defaultAgentName || `${connector.displayName} Agent`;
      const capabilities = connector.defaultCapabilities ?? [];

      try {
        console.log(`  [3/5] Registering ${connector.displayName} with Markus...`);
        const reg = await client.post<Record<string, unknown>>('/gateway/register', {
          agentId,
          agentName,
          orgId: opts.orgId,
          capabilities,
          platform: connector.platform,
        });
        const markusAgentId = reg['markusAgentId'] as string | undefined;
        console.log(`         Registered: ${agentId} → ${markusAgentId ?? 'N/A'}`);

        // Authenticate
        console.log(`  [4/5] Generating auth token...`);
        let token: string | undefined;
        try {
          const infoRes = await client.get<Record<string, unknown>>('/gateway/info');
          const secret = infoRes['orgSecretFull'] as string;
          const authRes = await client.post<Record<string, unknown>>('/gateway/auth', {
            agentId,
            orgId: opts.orgId,
            secret,
          });
          token = authRes['token'] as string;
          console.log(`         Token ready.`);
        } catch {
          console.log(`         Warning: auto-auth failed. Authenticate manually later.`);
        }

        // Write config + install skill
        console.log(`  [5/5] Configuring ${connector.displayName}...`);
        let configUpdated = false;
        if (token) {
          configUpdated = writePlatformConfig(connector, serverUrl, token);
          if (configUpdated) {
            console.log(`         Config updated: ${connector.integration.configPath}`);
          }
        }

        const skillInstalled = installSkillTemplate(connector);
        if (skillInstalled) {
          console.log(`         Skill template installed.`);
        }

        // Summary
        console.log(`\n  ┌─────────────────────────────────────┐`);
        console.log(`  │   Install & Connect Complete!        │`);
        console.log(`  └─────────────────────────────────────┘`);
        console.log(`\n  Platform:          ${connector.displayName}`);
        console.log(`  External Agent ID: ${agentId}`);
        console.log(`  Markus Agent ID:   ${markusAgentId ?? 'N/A'}`);

        if (connector.installation.startCommand) {
          console.log(`\n  To start ${connector.displayName}:`);
          console.log(`    ${connector.installation.startCommand}`);
        }

        console.log(`\n  To verify connection:`);
        console.log(`    markus connect status`);
        console.log('');
      } catch (e) {
        if (e instanceof ApiError) {
          console.error(`\n  Connection failed: ${e.message}`);
          console.log(`  ${connector!.displayName} was installed but could not connect to Markus.`);
          console.log(`  Make sure the Markus server is running (\`markus start\`), then run:`);
          console.log(`    markus connect add ${platform}\n`);
          return;
        }
        throw e;
      }
    });
}
