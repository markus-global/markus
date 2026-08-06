#!/usr/bin/env node
/**
 * Patch electron-builder NSIS templates before packaging.
 *
 * Why: nsis.include custom macros have not been reliably overriding stock
 * CHECK_APP_RUNNING / uninstallOldVersion dialogs in our published builds
 * (rc.11–rc.12 still showed $(appCannotBeClosed)). Patching the templates
 * that makensis always compiles guarantees the dialog cannot appear.
 *
 * CRITICAL: makensis treats unused-symbol warnings as errors (6001/6010/6012).
 * When removing a MessageBox/Call, also remove the labels, Vars, and includes
 * that only existed for that path.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

function resolveTemplatesDir() {
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

/** Replace the first matching candidate (supports re-entrant / intermediate patches). */
function patchFirstMatch(filePath, candidates, to, label, name) {
  if (!existsSync(filePath)) {
    throw new Error(`NSIS template not found: ${filePath}`);
  }
  const src = readFileSync(filePath, 'utf8');
  const marker = to.trim().slice(0, 48);
  if (marker && src.includes(marker) && !candidates.some((c) => src.includes(c))) {
    console.log(`[patch-nsis] ${label}: ${name} already applied`);
    return;
  }
  for (const from of candidates) {
    if (src.includes(from)) {
      writeFileSync(filePath, src.replace(from, to));
      console.log(`[patch-nsis] ${label}: patched ${name}`);
      return;
    }
  }
  // Already at desired end state?
  if (marker && src.includes(marker)) {
    console.log(`[patch-nsis] ${label}: ${name} already applied`);
    return;
  }
  throw new Error(`[patch-nsis] ${label}: pattern not found for ${name}`);
}

const templatesDir = resolveTemplatesDir();
console.log(`[patch-nsis] templates: ${templatesDir}`);

const allowOnlyOne = join(templatesDir, 'include', 'allowOnlyOneInstallerInstance.nsh');
const installUtil = join(templatesDir, 'include', 'installUtil.nsh');

// ── 1) allowOnlyOneInstallerInstance.nsh ─────────────────────────────────

// Drop getProcessInfo.nsh + Var pid (unused after CHECK_APP_RUNNING rewrite).
patchFirstMatch(
  allowOnlyOne,
  [
    `!ifmacrondef customCheckAppRunning
  !include "getProcessInfo.nsh"
  Var pid
!endif`,
    `; Markus patch: skip getProcessInfo.nsh (unused after CHECK_APP_RUNNING rewrite).
; Leaving it in causes: warning 6010 un._GetProcessInfo not referenced → error.
!ifmacrondef customCheckAppRunning
  Var pid
!endif`,
  ],
  `; Markus patch: omit getProcessInfo.nsh and Var pid.
; Unused un._GetProcessInfo / pid → makensis warning-as-error (6010 / 6001).
`,
  'allowOnlyOneInstallerInstance.nsh',
  'omit getProcessInfo + pid',
);

// Never MessageBox/Quit on "app running" — best-effort taskkill only.
patchFirstMatch(
  allowOnlyOne,
  [
    `!macro CHECK_APP_RUNNING
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
  ],
  `!macro CHECK_APP_RUNNING
  ; Markus patch: never block install/uninstall on process detection.
  ; Stock PowerShell Path.StartsWith($INSTDIR) false-positives and shows
  ; $(appCannotBeClosed). Only best-effort kill; always continue.
  DetailPrint "Best-effort stop of \${APP_EXECUTABLE_FILENAME} (never blocks)..."
  nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /C taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}" >nul 2>&1 & taskkill /F /T /IM "elevate.exe" >nul 2>&1'
  Pop $0
  Sleep 600
!macroend`,
  'allowOnlyOneInstallerInstance.nsh',
  'CHECK_APP_RUNNING',
);

// ── 2) installUtil.nsh — UninstallLoop must also drop OneMoreAttempt label ─
// Stock MessageBox jumps to OneMoreAttempt; fall-through does NOT count as a
// label reference in makensis. Removing only the MessageBox → warning 6012.

// CRITICAL: must clear $R0 to 0. handleUninstallResult Quits when $R0 != 0
// unless customUnInstallCheck is defined. Returning with a stale non-zero $R0
// after "continue" either aborts the upgrade or (with a weak check macro)
// continues over a half-deleted tree while still looking failed.
const uninstallContinue = `    \${if} $R5 > 5
      ; Markus patch: continue with overwrite install instead of blocking.
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      StrCpy $R0 0
      ClearErrors
      Return
    \${endIf}
`;

// Already-patched variant that forgot StrCpy $R0 0 (rc.13–0.9.2).
const uninstallContinueBroken = `    \${if} $R5 > 5
      ; Markus patch: continue with overwrite install instead of blocking.
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      ClearErrors
      Return
    \${endIf}
`;

patchFirstMatch(
  installUtil,
  [
    // Stock
    `    \${if} $R5 > 5
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt
      Return
    \${endIf}

  OneMoreAttempt:`,
    // Intermediate: MessageBox patched but label left behind (rc.13–rc.16)
    `    \${if} $R5 > 5
      ; Markus patch: continue with overwrite install instead of blocking.
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      ClearErrors
      Return
    \${endIf}

  OneMoreAttempt:`,
    // Applied continue patch without clearing $R0
    uninstallContinueBroken,
  ],
  `${uninstallContinue}
`,
  'installUtil.nsh',
  'UninstallLoop continue + clear $R0 + drop OneMoreAttempt',
);

// ── Sanity checks (live symbols only; comments may mention these names) ───
const allowSrc = readFileSync(allowOnlyOne, 'utf8');
if (/!include\s+"getProcessInfo\.nsh"/.test(allowSrc) || /^\s*Var pid\s*$/m.test(allowSrc)) {
  throw new Error('[patch-nsis] allowOnlyOneInstallerInstance.nsh still has getProcessInfo include or Var pid');
}

const utilSrc = readFileSync(installUtil, 'utf8');
if (/^\s*OneMoreAttempt:\s*$/m.test(utilSrc) || /IDRETRY OneMoreAttempt/.test(utilSrc)) {
  throw new Error('[patch-nsis] installUtil.nsh still references OneMoreAttempt');
}
if (/MessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "\$\(appCannotBeClosed\)"/.test(utilSrc)) {
  throw new Error('[patch-nsis] installUtil.nsh still has appCannotBeClosed MessageBox');
}
if (!/StrCpy \$R0 0/.test(utilSrc)) {
  throw new Error('[patch-nsis] installUtil.nsh continue path must clear $R0 (StrCpy $R0 0)');
}

console.log('[patch-nsis] done');
