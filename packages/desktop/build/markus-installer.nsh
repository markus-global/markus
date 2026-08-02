; Windows NSIS customisations for Markus Desktop.
;
; Do NOT name this file "installer.nsh" — that basename is used by
; electron-builder stock helpers (installApplicationFiles / addDesktopLink).
;
; --- "Markus cannot be closed" on upgrade ---
; installSection calls uninstallOldVersion, which ExecWait's the PREVIOUS
; uninstaller silently. When that exits non-zero five times, the PARENT
; installer shows $(appCannotBeClosed) — same string as the running-app
; check (see installUtil.nsh UninstallLoop). Silent old uninstallers with
; stock CHECK_APP_RUNNING often Quit on false positives (PowerShell
; Path.StartsWith($INSTDIR), leftover elevate.exe, etc.).
;
; Fix: hard-kill install-dir processes, then clear UninstallString so
; uninstallOldVersion no-ops. Electron upgrades are overwrite-safe; our
; customInstall recreates protocol keys + shortcuts.
;
; --- Desktop shortcut missing ---
; Assisted upgrades with keepShortcuts+isUpdated skip stock desktop
; recreation even with createDesktopShortcut=always. Force per-user .lnk
; via CreateShortCut + PowerShell GetFolderPath('Desktop').

!macro markusKillInstallDirProcesses _DIR
  ${if} `${_DIR}` != ""
    DetailPrint "Stopping processes under ${_DIR}"
    nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "Markus.exe" >nul 2>&1 & taskkill /F /T /IM "elevate.exe" >nul 2>&1'
    Pop $R9
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$p=''${_DIR}''; if (-not $$p) { exit 0 }; Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$p, ''CurrentCultureIgnoreCase'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0"'
    Pop $R9
    Sleep 800
  ${endif}
!macroend

!macro markusSkipBrokenOldUninstaller
  ; Make uninstallOldVersion return immediately (empty UninstallString).
  ; Prevents parent $(appCannotBeClosed) after 5 silent uninstall failures.
  DetailPrint "Skipping previous uninstaller (overwrite upgrade)"
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
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
!macro customUnInstallCheck
  DetailPrint "Ignoring previous uninstaller result (upgrade continues)"
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint "Ignoring previous per-user uninstaller result (upgrade continues)"
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

  StrCpy $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  DetailPrint "Creating Desktop + Start Menu shortcuts for $0"
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$exe=''$INSTDIR\${APP_EXECUTABLE_FILENAME}''; $$name=''${PRODUCT_FILENAME}''; $$ws=New-Object -ComObject WScript.Shell; foreach ($$dir in @([Environment]::GetFolderPath(''Desktop''), [Environment]::GetFolderPath(''StartMenu''))) { if (-not $$dir) { continue }; $$lnk=Join-Path $$dir ($$name + ''.lnk''); $$s=$$ws.CreateShortcut($$lnk); $$s.TargetPath=$$exe; $$s.WorkingDirectory=Split-Path $$exe; $$s.IconLocation=$$exe + '',0''; $$s.Save() }"'
  Pop $R9
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Classes\markus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$name=''${PRODUCT_FILENAME}.lnk''; foreach ($$dir in @([Environment]::GetFolderPath(''Desktop''), [Environment]::GetFolderPath(''StartMenu''))) { if ($$dir) { Remove-Item (Join-Path $$dir $$name) -Force -ErrorAction SilentlyContinue } }"'
  Pop $R9
!macroend
