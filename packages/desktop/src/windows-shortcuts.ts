import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Ensure Desktop + Start Menu shortcuts exist on Windows.
 *
 * NSIS assisted upgrades historically delete .lnk in customUnInstall while
 * stock install skips recreation ($keepShortcuts). Repair whenever either
 * shortcut is missing — not only once per version — so a broken upgrade can
 * self-heal on the next successful launch.
 */
export async function ensureWindowsShortcuts(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  const exePath = process.execPath;
  if (!exePath || !existsSync(exePath)) return;

  const name = 'Markus';
  const marker = join(app.getPath('userData'), `.shortcuts-${app.getVersion()}`);

  const checkPs = `
$ErrorActionPreference = 'Stop'
$name = ${JSON.stringify(name)}
$missing = $false
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('StartMenu'))) {
  if (-not $dir) { continue }
  $lnk = Join-Path $dir ($name + '.lnk')
  if (-not (Test-Path -LiteralPath $lnk)) { $missing = $true; break }
}
if ($missing) { exit 2 } else { exit 0 }
`;

  let needsRepair = !existsSync(marker);
  if (!needsRepair) {
    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', checkPs],
        { windowsHide: true, timeout: 10000 },
      );
    } catch (err: unknown) {
      const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: number }).code : undefined;
      if (code === 2) needsRepair = true;
      else {
        // Checker failed unexpectedly — still try to recreate once.
        needsRepair = true;
      }
    }
  }

  if (!needsRepair) return;

  const createPs = `
$ErrorActionPreference = 'Stop'
$exe = ${JSON.stringify(exePath)}
$name = ${JSON.stringify(name)}
$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('StartMenu'))) {
  if (-not $dir) { continue }
  $lnk = Join-Path $dir ($name + '.lnk')
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = Split-Path $exe
  $s.IconLocation = $exe + ',0'
  $s.Save()
}
`;

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', createPs],
      { windowsHide: true, timeout: 15000 },
    );
    writeFileSync(marker, new Date().toISOString(), 'utf8');
    console.log('[shortcuts] Desktop/Start Menu shortcuts ensured');
  } catch (err) {
    console.warn('[shortcuts] failed to create shortcuts:', err);
  }
}
