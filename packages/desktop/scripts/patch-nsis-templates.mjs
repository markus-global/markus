#!/usr/bin/env node
/**
 * Patch electron-builder NSIS templates before packaging.
 *
 * Design (keep this simple — do not re-introduce layered RC history):
 *
 *   1. Never block on "app running" / "cannot be closed" dialogs.
 *   2. Never run the fragile stock CopyFiles extract path.
 *   3. Upgrade = kill helpers → wipe INSTDIR → extract → verify Markus.exe.
 *
 * Strategy: replace whole `!macro NAME ... !macroend` blocks by name (regex),
 * so the script is idempotent and does not depend on exact prior patch text.
 *
 * CRITICAL: makensis treats unused-symbol warnings as errors (6001/6010/6012).
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

/** Replace `!macro name ... !macroend` (non-greedy, first match). */
function replaceMacro(filePath, macroName, newMacroSource, label) {
  if (!existsSync(filePath)) {
    throw new Error(`NSIS template not found: ${filePath}`);
  }
  const src = readFileSync(filePath, 'utf8');
  const re = new RegExp(
    String.raw`!macro\s+${macroName}\b[\s\S]*?!macroend`,
    'm',
  );
  if (!re.test(src)) {
    // Already at desired end-state?
    if (src.includes(newMacroSource.trim().slice(0, 60))) {
      console.log(`[patch-nsis] ${label}: ${macroName} already applied`);
      return;
    }
    throw new Error(`[patch-nsis] ${label}: !macro ${macroName} not found`);
  }
  const next = src.replace(re, newMacroSource.trim());
  writeFileSync(filePath, next);
  console.log(`[patch-nsis] ${label}: replaced !macro ${macroName}`);
}

/** Replace a unique exact snippet (for non-macro blocks like UninstallLoop). */
function replaceSnippet(filePath, fromCandidates, to, label, name) {
  if (!existsSync(filePath)) {
    throw new Error(`NSIS template not found: ${filePath}`);
  }
  const src = readFileSync(filePath, 'utf8');
  if (src.includes(to.trim())) {
    console.log(`[patch-nsis] ${label}: ${name} already applied`);
    return;
  }
  for (const from of fromCandidates) {
    if (src.includes(from)) {
      writeFileSync(filePath, src.replace(from, to));
      console.log(`[patch-nsis] ${label}: patched ${name}`);
      return;
    }
  }
  throw new Error(`[patch-nsis] ${label}: pattern not found for ${name}`);
}

const templatesDir = resolveTemplatesDir();
console.log(`[patch-nsis] templates: ${templatesDir}`);

const allowOnlyOne = join(templatesDir, 'include', 'allowOnlyOneInstallerInstance.nsh');
const installUtil = join(templatesDir, 'include', 'installUtil.nsh');
const extractAppPackage = join(templatesDir, 'include', 'extractAppPackage.nsh');

// ── 1) Drop unused getProcessInfo include / Var pid ───────────────────────
replaceSnippet(
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
    `; Markus patch: omit getProcessInfo.nsh and Var pid.
; Unused un._GetProcessInfo / pid → makensis warning-as-error (6010 / 6001).
`,
  ],
  `; Markus patch: omit getProcessInfo.nsh and Var pid.
; Unused un._GetProcessInfo / pid → makensis warning-as-error (6010 / 6001).
`,
  'allowOnlyOneInstallerInstance.nsh',
  'omit getProcessInfo + pid',
);

// ── 2) CHECK_APP_RUNNING: never dialog, only taskkill ─────────────────────
replaceMacro(
  allowOnlyOne,
  'CHECK_APP_RUNNING',
  `!macro CHECK_APP_RUNNING
  ; Markus: never MessageBox/Quit. Best-effort kill only.
  DetailPrint "Best-effort stop of \${APP_EXECUTABLE_FILENAME} + helpers (never blocks)..."
  nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /C taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}" >nul 2>&1 & taskkill /F /T /IM "elevate.exe" >nul 2>&1 & taskkill /F /T /IM "OpenConsole.exe" >nul 2>&1 & taskkill /F /T /IM "winpty-agent.exe" >nul 2>&1'
  Pop $0
  Sleep 600
!macroend`,
  'allowOnlyOneInstallerInstance.nsh',
);

// Neutralize MessageBox inside unused stock _CHECK_APP_RUNNING (not inserted,
// but keep templates free of $(appCannotBeClosed) MessageBox lines).
replaceSnippet(
  allowOnlyOne,
  [
    `        \${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          Quit
        \${else}
          Goto loop
        \${endIf}`,
    `        \${if} $R1 > 1
          ; Markus patch: unused _CHECK_APP_RUNNING must not MessageBox either.
          DetailPrint "app still running after kills; continuing (no dialog)"
          Goto not_running
        \${else}
          Goto loop
        \${endIf}`,
  ],
  `        \${if} $R1 > 1
          ; Markus: unused _CHECK_APP_RUNNING — never dialog.
          DetailPrint "app still running after kills; continuing (no dialog)"
          Goto not_running
        \${else}
          Goto loop
        \${endIf}`,
  'allowOnlyOneInstallerInstance.nsh',
  'neutralize _CHECK_APP_RUNNING dialog',
);

// ── 3) UninstallLoop: never dialog; clear $R0 and continue overwrite ──────
replaceSnippet(
  installUtil,
  [
    // Stock
    `    \${if} $R5 > 5
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt
      Return
    \${endIf}

  OneMoreAttempt:`,
    // Prior Markus patches (with/without $R0 clear, with/without label)
    `    \${if} $R5 > 5
      ; Markus patch: continue with overwrite install instead of blocking.
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      ClearErrors
      Return
    \${endIf}

  OneMoreAttempt:`,
    `    \${if} $R5 > 5
      ; Markus patch: continue with overwrite install instead of blocking.
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      ClearErrors
      Return
    \${endIf}
`,
    `    \${if} $R5 > 5
      ; Markus patch: continue with overwrite install instead of blocking.
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      StrCpy $R0 0
      ClearErrors
      Return
    \${endIf}
`,
  ],
  `    \${if} $R5 > 5
      ; Markus: old uninstall failed — continue overwrite (never dialog).
      DetailPrint "Previous uninstaller failed after retries; continuing overwrite install"
      StrCpy $R0 0
      ClearErrors
      Return
    \${endIf}
`,
  'installUtil.nsh',
  'UninstallLoop continue',
);

// ── 4) extractUsing7za: the one true install path ─────────────────────────
//
//   SetOutPath $PLUGINSDIR   ← leave INSTDIR before wiping (CWD-safe)
//   taskkill helpers
//   RMDir /r $INSTDIR        ← automatic cleanup, no user action
//   CreateDirectory $INSTDIR
//   SetOutPath $INSTDIR
//   Nsis7z::Extract
//   verify Markus.exe or Abort
//
replaceMacro(
  extractAppPackage,
  'extractUsing7za',
  `!macro extractUsing7za FILE
  ; Markus install path (do not complicate this):
  ; leave INSTDIR → kill helpers → wipe INSTDIR → extract → verify exe.
  DetailPrint "Markus: wipe INSTDIR + direct 7z extract + verify exe"
  SetOutPath "$PLUGINSDIR"

  nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /C taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}" >nul 2>&1 & taskkill /F /T /IM "elevate.exe" >nul 2>&1 & taskkill /F /T /IM "OpenConsole.exe" >nul 2>&1 & taskkill /F /T /IM "winpty-agent.exe" >nul 2>&1'
  Pop $0
  Sleep 800

  ; Leftovers from the broken rc.4 Rename approach
  RMDir /r "$INSTDIR.__markus_old"
  nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /C if exist "$INSTDIR.__markus_old" rmdir /s /q "$INSTDIR.__markus_old" >nul 2>&1'
  Pop $0

  IfFileExists "$INSTDIR" 0 markus_extract_fresh
    DetailPrint "Removing previous install (automatic)"
    RMDir /r "$INSTDIR"
    nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /C if exist "$INSTDIR" rmdir /s /q "$INSTDIR" >nul 2>&1'
    Pop $0
    Sleep 300
  markus_extract_fresh:

  ClearErrors
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  DetailPrint "Extracting into $INSTDIR"
  Nsis7z::Extract "\${FILE}"

  IfFileExists "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" markus_extract_ok 0
    DetailPrint "Missing \${APP_EXECUTABLE_FILENAME} — retry extract once"
    Sleep 500
    nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /C taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}" >nul 2>&1 & taskkill /F /T /IM "OpenConsole.exe" >nul 2>&1'
    Pop $0
    SetOutPath "$INSTDIR"
    Nsis7z::Extract "\${FILE}"
  IfFileExists "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" markus_extract_ok 0
    DetailPrint "FATAL: \${APP_EXECUTABLE_FILENAME} missing after extract"
    MessageBox MB_OK|MB_ICONSTOP "Markus failed to install: \${APP_EXECUTABLE_FILENAME} was not written to:$\\r$\\n$INSTDIR$\\r$\\n$\\r$\\nPlease run the installer again."
    SetErrorLevel 2
    Abort
  markus_extract_ok:
  DetailPrint "Verified \${APP_EXECUTABLE_FILENAME} present"
!macroend`,
  'extractAppPackage.nsh',
);

// ── Sanity: final templates must match the contract ───────────────────────
const allowSrc = readFileSync(allowOnlyOne, 'utf8');
const utilSrc = readFileSync(installUtil, 'utf8');
const extractSrc = readFileSync(extractAppPackage, 'utf8');

if (/!include\s+"getProcessInfo\.nsh"/.test(allowSrc) || /^\s*Var pid\s*$/m.test(allowSrc)) {
  throw new Error('[patch-nsis] allowOnlyOne still has getProcessInfo / Var pid');
}
if (/^\s*MessageBox[^\n]*\$\(appCannotBeClosed\)/m.test(allowSrc)) {
  throw new Error('[patch-nsis] allowOnlyOne still MessageBox appCannotBeClosed');
}
if (/^\s*MessageBox[^\n]*\$\(appCannotBeClosed\)/m.test(utilSrc)) {
  throw new Error('[patch-nsis] installUtil still MessageBox appCannotBeClosed');
}
if (/^\s*OneMoreAttempt:\s*$/m.test(utilSrc)) {
  throw new Error('[patch-nsis] installUtil still has OneMoreAttempt label');
}
if (!/StrCpy \$R0 0/.test(utilSrc)) {
  throw new Error('[patch-nsis] installUtil continue path must clear $R0');
}
if (/CopyFiles \/SILENT/.test(extractSrc)) {
  throw new Error('[patch-nsis] extractAppPackage must not use CopyFiles');
}
if (/Rename "\$INSTDIR"/.test(extractSrc)) {
  throw new Error('[patch-nsis] extractAppPackage must not Rename INSTDIR');
}
if (/^\s*MessageBox[^\n]*\$\(appCannotBeClosed\)/m.test(extractSrc)) {
  throw new Error('[patch-nsis] extractAppPackage still MessageBox appCannotBeClosed');
}
if (!extractSrc.includes('SetOutPath "$PLUGINSDIR"')) {
  throw new Error('[patch-nsis] extract must leave INSTDIR before wipe');
}
if (!extractSrc.includes('Verified ${APP_EXECUTABLE_FILENAME} present')) {
  throw new Error('[patch-nsis] extract must verify APP_EXECUTABLE_FILENAME');
}

console.log('[patch-nsis] done — contract OK');
