import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * Ensure Desktop + Start Menu shortcuts exist on Windows.
 * NSIS assisted upgrades often skip desktop shortcut recreation; this runs
 * once per version from the app itself as a reliable fallback.
 */
export async function ensureWindowsShortcuts(): Promise<void> {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  const exePath = process.execPath;
  if (!exePath || !existsSync(exePath)) return;

  const marker = join(app.getPath('userData'), `.shortcuts-${app.getVersion()}`);
  if (existsSync(marker)) return;

  const name = 'Markus';
  const ps = `
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
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 15000 },
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(marker, new Date().toISOString(), 'utf8');
    console.log('[shortcuts] Desktop/Start Menu shortcuts ensured');
  } catch (err) {
    console.warn('[shortcuts] failed to create shortcuts:', err);
  }
}
