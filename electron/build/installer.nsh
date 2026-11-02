; Extra steps for the Windows installer (electron-builder includes this file; see "nsis.include" in package.json).
;
; Windows only lists a browser under Settings > Apps > Default apps if the app registers itself there. The installer is per user
; (SHCTX is HKCU), so this needs no administrator rights. Windows 10 and 11 do not let an app make itself the default: the user
; chooses Alcove in Default apps, which the app opens for them (see "set_default_browser" in main.js).

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\AlcoveHTML" "" "Alcove HTML Document"
  WriteRegStr SHCTX "Software\Classes\AlcoveHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\AlcoveHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Classes\AlcoveURL" "" "Alcove URL"
  WriteRegStr SHCTX "Software\Classes\AlcoveURL" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\AlcoveURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\AlcoveURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove" "" "Alcove"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities" "ApplicationName" "Alcove"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities" "ApplicationDescription" "A productivity and privacy focused browser"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities\FileAssociations" ".htm" "AlcoveHTML"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities\FileAssociations" ".html" "AlcoveHTML"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities\FileAssociations" ".xhtml" "AlcoveHTML"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities\URLAssociations" "http" "AlcoveURL"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Alcove\Capabilities\URLAssociations" "https" "AlcoveURL"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Alcove" "Software\Clients\StartMenuInternet\Alcove\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\AlcoveHTML"
  DeleteRegKey SHCTX "Software\Classes\AlcoveURL"
  DeleteRegKey SHCTX "Software\Clients\StartMenuInternet\Alcove"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Alcove"
!macroend
