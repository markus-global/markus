#!/usr/bin/env node
/**
 * Patch electron-builder NSIS templates before packaging.
 *
 * Why: nsis.include custom macros have not been reliably overriding stock
 * CHECK_APP_RUNNING / uninstallOldVersion dialogs in our published builds
 * (rc.11–rc.12 still showed $(appCannotBeClosed)). Patching the templates
 * that makensis always compiles guarantees the dialog cannot appear.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

function resolveTemplatesDir() {
  // app-builder-lib is nested under electron-builder in pnpm layouts.
  let pkgJson;
  try {
    pkgJson = require.resolve('app-builder-lib/package.json');
  } catch {
    pkgJson = require.resolve('app-builder-lib/package.json', {
      paths: [dirname(require.resolve('electron-builder/package.json'))],
    });
  }
  return join(dirname(pkgJson), 'templates', 'nsis');
}

function patchFile(filePath, replacements, label) {
  if (!existsSync(filePath)) {
    throw new Error(`NSIS template not found: ${filePath}`);
  }
  let src = readFileSync(filePath, 'utf8');
  let next = src;
  for (const { from, to, name } of replacements) {
    if (!next.includes(from)) {
      if (next.includes(to.trim().slice(0, 40))) {
        console.log(`[patch-nsis] ${label}: ${name} already applied`);
        continue;
      }
      throw new Error(`[patch-nsis] ${label}: pattern not found for ${name}`);
    }
    next = next.replace(from, to);
    console.log(`[patch-nsis] ${label}: patched ${name}`);
  }
  if (next !== src) writeFileSync(filePath, next);
}

const templatesDir = resolveTemplatesDir();
console.log(`[patch-nsis] templates: ${templatesDir}`);

// 1) Never MessageBox/Quit on "app running" — best-effort taskkill only.
//    Also skip getProcessInfo.nsh: after rewriting CHECK_APP_RUNNING it is
//    unused, and makensis fails with "warning 6010: uninstall function
//    un._GetProcessInfo not referenced" (warnings treated as errors).
patchFile(
  join(templatesDir, 'include', 'allowOnlyOneInstallerInstance.nsh'),
  [
    {
      name: 'skip getProcessInfo include',
      from: `!ifmacrondef customCheckAppRunning
  !include "getProcessInfo.nsh"
  Var pid
!endif`,
      to: `; Markus patch: skip getProcessInfo.nsh (unused after CHECK_APP_RUNNING rewrite).
; Leaving it in causes: warning 6010 un._GetProcessInfo not referenced → error.
!ifmacrondef customCheckAppRunning
  Var pid
!endif`,
    },
    {
      name: 'CHECK_APP_RUNNING',
      from: `!macro CHECK_APP_RUNNING
  Var /GLOBAL CmdPath
  Var /GLOBAL PowerShellPath
  StrCpy $CmdPath "$SYSDIR\\cmd.exe"
  StrCpy $PowerShellPath "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"
  !ifmacrodef customCheckAppRunning
    !insertmacro customCheckAppRunning
  !else
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  !endif
!macroend`,
      to: `!macro CHECK_APP_RUNNING
  ; Markus patch: never block install/uninstall on process detection.
  ; Stock PowerShell Path.StartsWith($INSTDIR) false-positives and shows
  ; $(appCannotBeClosed). Only best-effort kill; always continue.
  DetailPrint "Best-effort stop of \${APP_EXECUTABLE_FILENAME} (never blocks)..."
  nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /C taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}" >nul 2>&1 & taskkill /F /T /IM "elevate.exe" >nul 2>&1'
  Pop $0
  Sleep 600
!macroend`,
    },
  ],
  'allowOnlyOneInstallerInstance.nsh',
);

// 2) When old silent uninstaller fails 5x, continue overwrite install — do not
//    show the same $(appCannotBeClosed) dialog from uninstallOldVersion.
patchFile(
  join(templatesDir, 'include', 'installUtil.nsh'),
  [
    {
      name: 'UninstallLoop MessageBox',
      from: `    \${if} $R5 > 5
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt
      Return
    \${endIf}`,
      to: `    \${if} $R5 > 5
      ; Markus patch: continue with overwrite install instead of blocking.
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      ClearErrors
      Return
    \${endIf}`,
    },
  ],
  'installUtil.nsh',
);

console.log('[patch-nsis] done');
