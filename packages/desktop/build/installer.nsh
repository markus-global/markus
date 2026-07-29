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
