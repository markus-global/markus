import type { Command } from 'commander';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { checkForUpdate, APP_VERSION } from '@markus/shared';

type InstallMethod = 'npm' | 'binary' | 'electron' | 'unknown';

function detectInstallMethod(): InstallMethod {
  if (process.versions['electron']) {
    return 'electron';
  }

  const execPath = process.argv[1] ?? '';

  // npm global install: path contains node_modules
  if (execPath.includes('node_modules') || execPath.includes('/usr/local/lib/')) {
    return 'npm';
  }

  // Binary install: in ~/.markus/app/ or /Applications/Markus.app/ or similar
  const markusAppDir = join(homedir(), '.markus', 'app');
  if (execPath.startsWith(markusAppDir) || execPath.includes('.markus')) {
    return 'binary';
  }

  // Homebrew or other system paths — treat as npm for update purposes
  if (execPath.includes('/bin/markus')) {
    return 'npm';
  }

  return 'unknown';
}

function getDownloadUrl(version: string): string {
  const os = platform();
  const a = arch();
  const platformStr = os === 'win32' ? 'win' : os;
  const archStr = a === 'arm64' ? 'arm64' : 'x64';
  return `https://github.com/markus-global/markus/releases/download/v${version}/markus-setup-${platformStr}-${archStr}.tar.gz`;
}

async function updateViaNpm(targetVersion?: string): Promise<void> {
  const version = targetVersion ? `@${targetVersion}` : '@latest';
  const pkg = `@markus-global/cli${version}`;

  console.log(`  Updating via npm: ${pkg}...`);

  const result = spawnSync('npm', ['install', '-g', pkg], {
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    console.error(`\n  ✗ npm update failed (exit code ${result.status})`);
    console.error(`    Try running manually: npm install -g ${pkg}`);
    process.exit(1);
  }

  console.log(`\n  ✓ Updated successfully. Restart markus to use the new version.`);
}

async function updateBinary(targetVersion: string): Promise<void> {
  const appDir = join(homedir(), '.markus', 'app');
  const tmpDir = join(homedir(), '.markus', '.update-tmp');
  const backupDir = join(homedir(), '.markus', '.update-backup');

  console.log(`  Downloading v${targetVersion}...`);

  const url = getDownloadUrl(targetVersion);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
    }

    // Save to temp file
    mkdirSync(tmpDir, { recursive: true });
    const tarPath = join(tmpDir, 'markus-update.tar.gz');
    const fileStream = createWriteStream(tarPath);
    await pipeline(Readable.fromWeb(res.body as any), fileStream);

    // Extract
    console.log('  Extracting...');
    execSync(`tar -xzf "${tarPath}" -C "${tmpDir}"`, { stdio: 'pipe' });

    // Backup current installation
    if (existsSync(appDir)) {
      if (existsSync(backupDir)) rmSync(backupDir, { recursive: true });
      renameSync(appDir, backupDir);
    }

    // Move new files into place
    const extracted = join(tmpDir, 'markus');
    if (existsSync(extracted)) {
      renameSync(extracted, appDir);
    } else {
      mkdirSync(appDir, { recursive: true });
      execSync(`mv "${tmpDir}"/* "${appDir}/" 2>/dev/null || true`, { stdio: 'pipe', shell: '/bin/sh' });
    }

    // Verify
    const verifyResult = spawnSync(join(appDir, 'bin', 'markus'), ['--version'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (verifyResult.status !== 0) {
      throw new Error('Verification failed — rolling back');
    }

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });

    console.log(`\n  ✓ Updated to v${targetVersion}. Restart markus to use the new version.`);
  } catch (err) {
    // Rollback on failure
    if (existsSync(backupDir)) {
      rmSync(appDir, { recursive: true, force: true });
      renameSync(backupDir, appDir);
      console.error('  Rolled back to previous version.');
    }
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

export function registerUpdateCommand(program: Command) {
  program
    .command('update')
    .description('Update Markus to the latest version')
    .option('--check', 'Only check for updates, do not install')
    .option('--version <ver>', 'Update to a specific version')
    .action(async (opts) => {
      const method = detectInstallMethod();

      if (method === 'electron') {
        console.log('  You are running the Markus desktop app.');
        console.log('  Updates are managed automatically by the app.');
        console.log('  Check Help → Check for Updates in the menu.');
        return;
      }

      // Check for updates
      const info = await checkForUpdate();
      const targetVersion = opts.version ?? info.latestVersion;

      console.log(`  Current version: v${APP_VERSION}`);
      console.log(`  Latest version:  v${info.latestVersion}`);

      if (!opts.version && !info.updateAvailable) {
        console.log('\n  ✓ Already up to date.');
        return;
      }

      if (opts.check) {
        if (info.updateAvailable) {
          console.log(`\n  Update available: v${APP_VERSION} → v${info.latestVersion}`);
          console.log(`  Run \x1b[1mmarkus update\x1b[0m to install.`);
        }
        return;
      }

      console.log(`\n  Updating to v${targetVersion}...`);
      console.log(`  Install method: ${method}\n`);

      switch (method) {
        case 'npm':
          await updateViaNpm(targetVersion);
          break;
        case 'binary':
          await updateBinary(targetVersion);
          break;
        default:
          console.log('  Unable to determine installation method.');
          console.log('  Please update manually:');
          console.log('    npm:    npm install -g @markus-global/cli@latest');
          console.log('    binary: curl -fsSL https://markus.global/install.sh | bash');
          break;
      }
    });
}
