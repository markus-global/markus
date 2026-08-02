; Windows NSIS customisations for Markus Desktop.
;
; IMPORTANT: Do NOT name this file "installer.nsh". electron-builder's
; installSection.nsh does `!include installer.nsh` for the stock helpers
; (installApplicationFiles / addDesktopLink / …). buildResources is on the
; include path, so a same-named file can shadow the stock script and produce
; a broken installer (almost-empty install dir, no real app files).
;
; 1) Replace CHECK_APP_RUNNING — stock per-user detection false-positives
;    ("Markus is running") via PowerShell Path.StartsWith($INSTDIR) / find.exe.
;    Never MessageBox / Quit; only best-effort exact-name kill.
;
; 2) Force per-user Desktop + Start Menu shortcuts (SetShellVarContext current).
;
; 3) Register markus:// in HKCU for Hub login deep links.

!macro customCheckAppRunning
  DetailPrint "Best-effort stop of ${APP_EXECUTABLE_FILENAME} (never blocks install)..."
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" >nul 2>&1'
  Pop $0
  Sleep 400
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
  CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
!macroend

!macro customUnInstall
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Classes\markus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
!macroend
