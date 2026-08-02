; Markus NSIS extras (protocol + shortcuts).
; Process-detection / upgrade dialogs are patched in electron-builder templates
; by scripts/patch-nsis-templates.mjs (do not rely on customCheckAppRunning alone).
;
; Do NOT name this file "installer.nsh".

!macro customInstall
  SetShellVarContext current

  WriteRegStr HKCU "Software\Classes\markus" "" "URL:Markus Protocol"
  WriteRegStr HKCU "Software\Classes\markus" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\markus\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\markus\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}" "Path" "$INSTDIR"

  StrCpy $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk" "$0" "" "$0" 0
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Classes\markus"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${APP_EXECUTABLE_FILENAME}"
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
!macroend
