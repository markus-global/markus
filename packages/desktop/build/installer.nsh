; Register markus:// for deep-link auth / Hub install on Windows.
; electron-builder's `protocols` config alone is unreliable for NSIS per-user installs
; (HKCU), so we write the URL protocol keys explicitly.
;
; Also force Desktop + Start Menu shortcuts. Assisted NSIS installs can leave the
; "create shortcut" checkboxes unchecked (or skip recreation on upgrade); users
; then see no Markus entry after a successful install.
!macro customInstall
  DetailPrint "Registering markus:// URL protocol"
  WriteRegStr HKCU "Software\Classes\markus" "" "URL:Markus Protocol"
  WriteRegStr HKCU "Software\Classes\markus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\markus\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\markus\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  DetailPrint "Creating Desktop and Start Menu shortcuts"
  CreateShortCut "$DESKTOP\Markus.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\Markus.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\markus"
  Delete "$DESKTOP\Markus.lnk"
  Delete "$SMPROGRAMS\Markus.lnk"
!macroend

; Force-close a running Markus before upgrade. The stock electron-builder check
; fails when the app is tray-hidden, slow to quit, or ignores WM_CLOSE — leaving
; users stuck on "Markus cannot be closed…".
!macro customCheckAppRunning
  DetailPrint "Closing Markus if it is still running..."
  nsExec::ExecToLog 'taskkill /F /IM Markus.exe /T'
  Pop $0
  Sleep 800
!macroend
