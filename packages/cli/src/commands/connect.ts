import type { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { createClient, ApiError } from '../api-client.js';
import { success, fail, table } from '../output.js';
import {
  loadConnectors,
  findConnector,
  scanInstalledPlatforms,
  writePlatformConfig,
  installSkillTemplate,
} from '../connector-service.js';

export function registerConnectCommands(program: Command) {
  const root = program.command('connect').description('Connect / disconnect external agent platforms');

  // ── markus connect scan ─────────────────────────────────────────────────────
  root
    .command('scan')
    .description('Scan for installed agent platforms that can be connected')
    .action(async (_opts, cmd) => {
      const g = cmd.optsWithGlobals() as { json?: boolean };
      const out = { json: !!g.json };

      const results = scanInstalledPlatforms();

      if (out.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log('  No connector descriptors found.');
        console.log('  Place connector JSON files in ~/.markus/connectors/');
        return;
      }

      table(results as unknown as Record<string, unknown>[], [
        { key: 'displayName', header: 'Platform', width: 20 },
        { key: 'platform', header: 'ID', width: 15 },
        { key: 'installed', header: 'Installed', width: 10 },
        { key: 'binaryFound', header: 'Binary', width: 8 },
        { key: 'running', header: 'Running', width: 8 },
        { key: 'configPath', header: 'Config', width: 40 },
      ], { title: 'Detected agent platforms' });

      const installed = results.filter(r => r.installed);
      if (installed.length > 0) {
        console.log(`\n  To connect: markus connect <platform>`);
        console.log(`  Available:  ${installed.map(r => r.platform).join(', ')}`);
      }
    });

  // ── markus connect list ─────────────────────────────────────────────────────
  root
    .command('list')
    .description('List all available connector descriptors')
    .action(async (_opts, cmd) => {
      const g = cmd.optsWithGlobals() as { json?: boolean };
      const out = { json: !!g.json };
      const connectors = loadConnectors();

      if (out.json) {
        console.log(JSON.stringify(connectors, null, 2));
        return;
      }

      table(connectors.map(c => ({
        platform: c.platform,
        displayName: c.displayName,
        description: c.description,
        type: c.integration.type,
      })), [
        { key: 'platform', header: 'ID', width: 15 },
        { key: 'displayName', header: 'Name', width: 20 },
        { key: 'description', header: 'Description', width: 45 },
        { key: 'type', header: 'Type', width: 10 },
      ], { title: 'Available connectors' });
    });

  // ── markus connect <platform> ───────────────────────────────────────────────
  root
    .command('add <platform>')
    .description('Connect an external agent platform to Markus')
    .option('--agent-id <id>', 'External agent ID (auto-generated if omitted)')
    .option('--agent-name <name>', 'Agent display name')
    .option('--org-id <id>', 'Organization ID', 'default')
    .option('--capabilities <csv>', 'Comma-separated capabilities')
    .option('--no-config-write', 'Skip writing token/URL to platform config')
    .option('--no-skill-install', 'Skip installing integration skill template')
    .option('--agent-card-url <url>', 'Agent Card URL for custom platforms')
    .action(async (platform: string, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const out = { json: !!g.json };

      const connector = findConnector(platform);
      if (!connector) {
        fail(`Unknown platform "${platform}". Run \`markus connect list\` to see available connectors.`);
        return;
      }

      const agentId = opts.agentId || `${platform}-${randomBytes(4).toString('hex')}`;
      const agentName = opts.agentName || connector.defaultAgentName || `${connector.displayName} Agent`;
      const capabilities = opts.capabilities
        ? String(opts.capabilities).split(',').map((s: string) => s.trim()).filter(Boolean)
        : connector.defaultCapabilities ?? [];

      const client = createClient(g);
      const serverUrl = g.server || process.env['MARKUS_API_URL'] || 'http://localhost:8056';

      try {
        // Step 1: Register via gateway
        console.log(`\n  Connecting ${connector.displayName} to Markus...\n`);
        console.log(`  [1/4] Registering external agent...`);

        const reg = await client.post<Record<string, unknown>>('/gateway/register', {
          agentId,
          agentName,
          orgId: opts.orgId,
          capabilities,
          platform: connector.platform,
          agentCardUrl: opts.agentCardUrl || connector.detection.agentCardUrl,
        });

        const markusAgentId = reg['markusAgentId'] as string | undefined;
        console.log(`         Agent registered: ${agentId} → Markus agent ${markusAgentId ?? '(none)'}`);

        // Step 2: Authenticate to get token
        console.log(`  [2/4] Generating authentication token...`);

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
          console.log(`         Token generated (${token ? token.slice(0, 20) + '...' : 'none'})`);
        } catch {
          console.log(`         Warning: Could not auto-generate token. You may need to authenticate manually.`);
        }

        // Step 3: Write config to platform
        let configUpdated = false;
        if (opts.configWrite !== false && token) {
          console.log(`  [3/4] Writing connection config to ${connector.displayName}...`);
          configUpdated = writePlatformConfig(connector, serverUrl, token);
          if (configUpdated) {
            console.log(`         Updated: ${connector.integration.configPath}`);
          } else {
            console.log(`         Skipped: could not write config (file may not exist yet)`);
          }
        } else {
          console.log(`  [3/4] Config write skipped.`);
        }

        // Step 4: Install skill template
        let skillInstalled = false;
        if (opts.skillInstall !== false && connector.integration.skillTemplateName) {
          console.log(`  [4/4] Installing integration skill template...`);
          skillInstalled = installSkillTemplate(connector);
          if (skillInstalled) {
            console.log(`         Installed: ${connector.integration.skillTemplateName}`);
          } else {
            console.log(`         Skipped: skill template not found or target dir missing`);
          }
        } else {
          console.log(`  [4/4] Skill install skipped.`);
        }

        // Summary
        const result = {
          platform: connector.platform,
          externalAgentId: agentId,
          markusAgentId,
          markusUrl: serverUrl,
          token: token ? `${token.slice(0, 20)}...` : undefined,
          configUpdated,
          skillInstalled,
        };

        if (out.json) {
          console.log(JSON.stringify({ ...result, token }, null, 2));
        } else {
          console.log(`\n  ┌─────────────────────────────────────┐`);
          console.log(`  │      Connection Successful!          │`);
          console.log(`  └─────────────────────────────────────┘`);
          console.log(`\n  Platform:          ${connector.displayName}`);
          console.log(`  External Agent ID: ${agentId}`);
          console.log(`  Markus Agent ID:   ${markusAgentId ?? 'N/A'}`);
          console.log(`  Markus URL:        ${serverUrl}`);
          console.log(`  Config Updated:    ${configUpdated ? 'Yes' : 'No'}`);
          console.log(`  Skill Installed:   ${skillInstalled ? 'Yes' : 'No'}`);

          if (token && !configUpdated) {
            console.log(`\n  Manual setup required:`);
            console.log(`  Set the following in your ${connector.displayName} config:`);
            console.log(`    ${connector.integration.urlField}: ${serverUrl}`);
            console.log(`    ${connector.integration.tokenField}: ${token}`);
          }

          if (!token) {
            console.log(`\n  Next step: authenticate the agent manually:`);
            console.log(`    markus admin gateway auth --agent-id ${agentId} --secret <gateway-secret>`);
          }
          console.log('');
        }
      } catch (e) {
        if (e instanceof ApiError) {
          fail(`Failed to connect: ${e.message}`);
        } else {
          throw e;
        }
      }
    });

  // ── markus connect remove <platform-or-id> ──────────────────────────────────
  root
    .command('remove <platformOrId>')
    .description('Disconnect an external agent platform from Markus')
    .option('--org-id <id>', 'Organization ID', 'default')
    .action(async (platformOrId: string, opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const out = { json: !!g.json };
      const client = createClient(g);

      try {
        // Try to list external agents and find matching one
        const agents = await client.get<{ registrations?: Record<string, unknown>[]; agents?: Record<string, unknown>[] }>('/external-agents', { orgId: opts.orgId });
        const rows = agents.registrations ?? agents.agents ?? [];
        const match = rows.find((r: Record<string, unknown>) =>
          r['platform'] === platformOrId ||
          r['externalAgentId'] === platformOrId ||
          (r['externalAgentId'] as string)?.startsWith(platformOrId + '-')
        );

        if (!match) {
          fail(`No connected agent found for "${platformOrId}". Run \`markus admin external-agent list\` to see all.`);
          return;
        }

        const extId = match['externalAgentId'] as string;
        const agentId = match['id'] ?? match['markusAgentId'];

        // Delete via external-agents endpoint
        if (agentId) {
          await client.delete(`/external-agents/${encodeURIComponent(agentId as string)}`, { orgId: opts.orgId });
        }

        success(`Disconnected ${platformOrId} (agent: ${extId})`, match, out);
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        else throw e;
      }
    });

  // ── markus connect status ───────────────────────────────────────────────────
  root
    .command('status')
    .description('Show connection status of all external agents')
    .option('--org-id <id>', 'Organization ID', 'default')
    .action(async (opts, cmd) => {
      const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
      const out = { json: !!g.json };
      const client = createClient(g);

      try {
        const data = await client.get<Record<string, unknown>>('/external-agents', { orgId: opts.orgId });
        const rows = (data['registrations'] ?? data['agents'] ?? data['rows'] ?? []) as Record<string, unknown>[];

        if (out.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log('  No external agents connected.');
          console.log('  Run `markus connect scan` to find installable platforms.');
          return;
        }

        table(rows, [
          { key: 'externalAgentId', header: 'External ID', width: 24 },
          { key: 'agentName', header: 'Name', width: 20 },
          { key: 'platform', header: 'Platform', width: 12 },
          { key: 'connected', header: 'Online', width: 8 },
          { key: 'markusAgentId', header: 'Markus Agent', width: 28 },
          { key: 'lastHeartbeat', header: 'Last Seen', width: 20 },
        ], { title: 'Connected external agents' });
      } catch (e) {
        if (e instanceof ApiError) fail(e.message);
        else throw e;
      }
    });
}
