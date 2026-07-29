; Register markus:// for deep-link auth / Hub install on Windows.
; electron-builder's `protocols` config alone is unreliable for NSIS per-user installs
; (HKCU), so we write the URL protocol keys explicitly.
!macro customInstall
  DetailPrint "Registering markus:// URL protocol"
  WriteRegStr HKCU "Software\Classes\markus" "" "URL:Markus Protocol"
  WriteRegStr HKCU "Software\Classes\markus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\markus\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\markus\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\markus"
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
