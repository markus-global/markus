; Windows NSIS customisations for Markus Desktop.
;
; Do NOT name this file "installer.nsh" — that basename is used by
; electron-builder stock helpers (installApplicationFiles / addDesktopLink).
;
; --- Root cause: upgrade leaves no shortcuts / broken install ---
; 1) Stock assisted upgrades pass --keep-shortcuts to the OLD uninstaller, then
;    skip recreating Desktop/Start Menu links ($keepShortcuts=true).
;    Our customUnInstall used to Delete those .lnk files unconditionally, so
;    upgrades wiped shortcuts and never put them back.
; 2) installSection always ExecWait's the previous uninstaller. Silent old
;    uninstallers often fail (busy files / Path.StartsWith false positives) and
;    can half-delete INSTDIR. After five failures stock shows $(appCannotBeClosed);
;    our template patch "continue" without clearing $R0 / without
;    customUnInstallCheck can report success over a corrupted tree.
;
; Fix: kill install-dir processes, clear UninstallString so uninstallOldVersion
; no-ops (Electron overwrite is safe), recreate protocol + shortcuts ourselves,
; refuse to finish if Markus.exe is missing, and never delete shortcuts when
; --keep-shortcuts / --updated is set.
;
; Process-detection AND extract CopyFiles MessageBoxes (same misleading
; $(appCannotBeClosed) string) are hard-patched by
; scripts/patch-nsis-templates.mjs.

!macro markusKillInstallDirProcesses _DIR
  ${if} `${_DIR}` != ""
    DetailPrint "Stopping processes under ${_DIR}"
    ; Markus.exe + installer helper + node-pty ConPTY helpers that lock INSTDIR
    nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "Markus.exe" >nul 2>&1 & taskkill /F /T /IM "elevate.exe" >nul 2>&1 & taskkill /F /T /IM "OpenConsole.exe" >nul 2>&1 & taskkill /F /T /IM "winpty-agent.exe" >nul 2>&1'
    Pop $R9
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$p=''${_DIR}''; if (-not $$p) { exit 0 }; Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$p, ''CurrentCultureIgnoreCase'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0"'
    Pop $R9
    Sleep 800
  ${endif}
!macroend

!macro markusSkipBrokenOldUninstaller
  ; Make uninstallOldVersion return immediately (empty UninstallString).
  ; Prevents half-deleted INSTDIR and parent $(appCannotBeClosed).
  DetailPrint "Skipping previous uninstaller (overwrite upgrade)"
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" QuietUninstallString
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" QuietUninstallString
  !endif
!macroend

; Runs from .onInit for every install path (including UAC inner instance).
!macro customInit
  DetailPrint "Markus customInit: prepare upgrade"
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
    !insertmacro markusKillInstallDirProcesses "$R8"
  ${endif}
  ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
    !insertmacro markusKillInstallDirProcesses "$R8"
  ${endif}
  !insertmacro markusSkipBrokenOldUninstaller
!macroend

!macro customCheckAppRunning
  DetailPrint "Markus customCheckAppRunning: never blocks install"
  !insertmacro markusKillInstallDirProcesses "$INSTDIR"
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
    !insertmacro markusKillInstallDirProcesses "$R8"
  ${endif}
  !insertmacro markusSkipBrokenOldUninstaller
!macroend

; Belt-and-suspenders if an uninstaller still runs and fails.
; handleUninstallResult returns early when this macro exists — so a non-zero
; $R0 from a failed old uninstall cannot Quit the parent installer.
!macro customUnInstallCheck
  DetailPrint "Ignoring previous uninstaller result (upgrade continues)"
  StrCpy $R0 0
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint "Ignoring previous per-user uninstaller result (upgrade continues)"
  StrCpy $R0 0
  ClearErrors
!macroend

!macro customInstall
  SetShellVarContext current

  DetailPrint "Registering markus:// URL protocol (HKCU)"
  WriteRegStr HKCU "Software\Classes\markus" "" "URL:Markus Protocol"
  WriteRegStr HKCU "Software\Classes\markus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\markus\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\markus\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"

  ; Refuse "success" if the main binary never landed (corrupt / aborted extract).
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" markus_exe_ok 0
    DetailPrint "FATAL: $INSTDIR\${APP_EXECUTABLE_FILENAME} missing after install"
    MessageBox MB_OK|MB_ICONSTOP "Markus installation is incomplete: ${APP_EXECUTABLE_FILENAME} was not found in:$\r$\n$INSTDIR$\r$\n$\r$\nPlease close Markus, delete that folder if it still exists, and run the installer again."
    SetErrorLevel 2
    Abort
  markus_exe_ok:

  StrCpy $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  DetailPrint "Creating Desktop + Start Menu shortcuts for $0"
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
  ; OneDrive / redirected Desktop: also write via known folder API.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$exe=''$INSTDIR\${APP_EXECUTABLE_FILENAME}''; $$name=''${PRODUCT_FILENAME}''; $$ws=New-Object -ComObject WScript.Shell; foreach ($$dir in @([Environment]::GetFolderPath(''Desktop''), [Environment]::GetFolderPath(''StartMenu''))) { if (-not $$dir) { continue }; $$lnk=Join-Path $$dir ($$name + ''.lnk''); $$s=$$ws.CreateShortcut($$lnk); $$s.TargetPath=$$exe; $$s.WorkingDirectory=Split-Path $$exe; $$s.IconLocation=$$exe + '',0''; $$s.Save() }"'
  Pop $R9
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Classes\markus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"

  ; Stock uninstaller keeps shortcuts when --keep-shortcuts is passed during
  ; assisted upgrades. We must do the same — otherwise upgrades delete .lnk
  ; files and stock install skips recreating them ($keepShortcuts=true).
  ${ifNot} ${isKeepShortcuts}
    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$name=''${PRODUCT_FILENAME}.lnk''; foreach ($$dir in @([Environment]::GetFolderPath(''Desktop''), [Environment]::GetFolderPath(''StartMenu''))) { if ($$dir) { Remove-Item (Join-Path $$dir $$name) -Force -ErrorAction SilentlyContinue } }"'
    Pop $R9
  ${endIf}
!macroend
