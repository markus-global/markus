; Markus Desktop — NSIS customisations.
;
; Do NOT name this file "installer.nsh" (reserved by electron-builder).
;
; Install contract (paired with scripts/patch-nsis-templates.mjs):
;   1. Never block the user with "Markus cannot be closed".
;   2. Never run the previous uninstaller (it half-deletes INSTDIR).
;   3. Wipe INSTDIR → extract → verify Markus.exe → write shortcuts.
;   4. Real uninstall (not upgrade) may remove shortcuts; upgrades must not.

!macro markusKillInstallDirProcesses _DIR
  ${if} `${_DIR}` != ""
    DetailPrint "Stopping processes under ${_DIR}"
    nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "Markus.exe" >nul 2>&1 & taskkill /F /T /IM "elevate.exe" >nul 2>&1 & taskkill /F /T /IM "OpenConsole.exe" >nul 2>&1 & taskkill /F /T /IM "winpty-agent.exe" >nul 2>&1'
    Pop $R9
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$p=''${_DIR}''; if (-not $$p) { exit 0 }; Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$p, ''CurrentCultureIgnoreCase'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0"'
    Pop $R9
    Sleep 800
  ${endif}
!macroend

!macro markusSkipOldUninstaller
  ; Empty UninstallString ⇒ uninstallOldVersion is a no-op.
  DetailPrint "Skipping previous uninstaller (overwrite install)"
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

!macro customInit
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
    !insertmacro markusKillInstallDirProcesses "$R8"
  ${endif}
  ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
    !insertmacro markusKillInstallDirProcesses "$R8"
  ${endif}
  !insertmacro markusSkipOldUninstaller
!macroend

!macro customCheckAppRunning
  !insertmacro markusKillInstallDirProcesses "$INSTDIR"
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
    !insertmacro markusKillInstallDirProcesses "$R8"
  ${endif}
  !insertmacro markusSkipOldUninstaller
!macroend

; If an old uninstaller still runs and fails, do not Quit the parent installer.
!macro customUnInstallCheck
  StrCpy $R0 0
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  StrCpy $R0 0
  ClearErrors
!macroend

!macro customInstall
  SetShellVarContext current

  WriteRegStr HKCU "Software\Classes\markus" "" "URL:Markus Protocol"
  WriteRegStr HKCU "Software\Classes\markus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\markus\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\markus\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" markus_exe_ok 0
    MessageBox MB_OK|MB_ICONSTOP "Markus installation is incomplete: ${APP_EXECUTABLE_FILENAME} missing from:$\r$\n$INSTDIR$\r$\n$\r$\nPlease run the installer again."
    SetErrorLevel 2
    Abort
  markus_exe_ok:

  ; Always (re)create shortcuts — stock keepShortcuts can skip this on upgrades.
  StrCpy $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  DetailPrint "Creating Desktop + Start Menu shortcuts"
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

  ; Upgrades pass --keep-shortcuts; must not delete .lnk in that case.
  ${ifNot} ${isKeepShortcuts}
    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$name=''${PRODUCT_FILENAME}.lnk''; foreach ($$dir in @([Environment]::GetFolderPath(''Desktop''), [Environment]::GetFolderPath(''StartMenu''))) { if ($$dir) { Remove-Item (Join-Path $$dir $$name) -Force -ErrorAction SilentlyContinue } }"'
    Pop $R9
  ${endIf}
!macroend
