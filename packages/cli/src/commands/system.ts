import type { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForUpdate } from '@markus/shared';
import { createClient, ApiError } from '../api-client.js';
import { detail, success, fail } from '../output.js';

function findMarkusRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'packages'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

export function registerSystemCommands(program: Command): Command {
  const root = program.command('system').description('System control');

  root.command('status').description('Show system and health status').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const status = await client.get<unknown>('/system/status');
      const health = await client.get<unknown>('/health');
      if (out.json) {
        console.log(JSON.stringify({ status, health }, null, 2));
        return;
      }
      detail(status as Record<string, unknown>, { title: 'System status' });
      detail(health as Record<string, unknown>, { title: 'Health' });
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('emergency-stop').description('Stop all agents immediately').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { server?: string; apiKey?: string; json?: boolean };
    const client = createClient(g);
    const out = { json: !!g.json };
    try {
      const data = await client.post<unknown>('/system/emergency-stop');
      success('Emergency stop executed', data, out);
    } catch (e) {
      if (e instanceof ApiError) fail(e.message);
      throw e;
    }
  });

  root.command('version').description('Show current and latest version info').action(async (_opts, cmd) => {
    const g = cmd.optsWithGlobals() as { json?: boolean };
    const markusRoot = findMarkusRoot();
    const info: Record<string, unknown> = {};

    try {
      const updateInfo = await checkForUpdate();
      info.currentVersion = updateInfo.currentVersion;
      info.latestVersion = updateInfo.latestVersion;
      info.npmUpdateAvailable = updateInfo.updateAvailable;
    } catch { /* ignore */ }

    if (markusRoot) {
      if (!info.currentVersion) {
        try {
          const pkg = JSON.parse(readFileSync(resolve(markusRoot, 'package.json'), 'utf-8')) as { version: string };
          info.currentVersion = pkg.version;
        } catch { /* ignore */ }
      }

      try {
        const isGit = existsSync(resolve(markusRoot, '.git'));
        if (isGit) {
          info.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: markusRoot, encoding: 'utf-8' }).trim();
          info.gitCommit = execSync('git rev-parse --short HEAD', { cwd: markusRoot, encoding: 'utf-8' }).trim();
          info.gitDate = execSync('git log -1 --format=%ci', { cwd: markusRoot, encoding: 'utf-8' }).trim();
          try {
            execSync('git fetch origin --quiet', { cwd: markusRoot, timeout: 10_000 });
            const behind = execSync('git rev-list HEAD..origin/main --count', { cwd: markusRoot, encoding: 'utf-8' }).trim();
            info.commitsBehind = parseInt(behind, 10);
            info.gitUpdateAvailable = parseInt(behind, 10) > 0;
          } catch {
            info.gitUpdateAvailable = 'unknown (fetch failed)';
          }
        }
      } catch { /* not a git repo */ }
      info.installPath = markusRoot;
    }

    if (g.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      detail(info, { title: 'Markus Version' });
      if (info.npmUpdateAvailable === true) {
        console.log(`\n  ⬆ New version available: v${info.latestVersion} (current: v${info.currentVersion})`);
        console.log(`    Run \`npm i -g @markus-global/cli\` to upgrade.`);
      }
      if (info.gitUpdateAvailable === true) {
        console.log(`\n  ⬆ ${info.commitsBehind} commit(s) behind origin/main. Run \`markus admin system update\` to update.`);
      }
    }
  });

  root
    .command('update')
    .description('Pull latest code from GitHub and rebuild')
    .option('--dry-run', 'Show what would be done without making changes')
    .action(async (opts) => {
      const markusRoot = findMarkusRoot();
      if (!markusRoot) {
        fail('Cannot locate Markus installation directory');
        return;
      }
      if (!existsSync(resolve(markusRoot, '.git'))) {
        fail('Markus installation is not a git repository. Update manually.');
        return;
      }

      const run = (cmd: string) => {
        console.log(`  $ ${cmd}`);
        if (!opts.dryRun) {
          execSync(cmd, { cwd: markusRoot, stdio: 'inherit', timeout: 300_000 });
        }
      };

      try {
        console.log(opts.dryRun ? '=== DRY RUN ===' : '=== Updating Markus ===');
        console.log(`  Installation: ${markusRoot}\n`);

        run('git pull origin main');
        run('pnpm install');
        run('pnpm build');

        console.log(opts.dryRun
          ? '\n  Dry run complete. Run without --dry-run to apply.'
          : '\n  ✓ Update complete. Restart the server to apply changes:\n    markus start');
      } catch (e) {
        fail(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

  return root;
}
