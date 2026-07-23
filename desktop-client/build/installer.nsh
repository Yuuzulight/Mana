!include MUI2.nsh
!include LogicLib.nsh
!include nsDialogs.nsh

Var AUTOSTART_CHECKBOX
Var DELETE_DATA_CHECKBOX

Page custom CustomAutostartPage

Function CustomAutostartPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 10u 10u 100% 12u "Would you like Mana to start automatically when you log in?"
  Pop $R0
  ${NSD_CreateCheckbox} 10u 30u 100% 12u "Launch Mana at login"
  Pop $AUTOSTART_CHECKBOX

  nsDialogs::Show
FunctionEnd

Function .onInstSuccess
  ; read checkbox state
  ${NSD_GetState} $AUTOSTART_CHECKBOX $R0
  StrCmp $R0 1 +2
    ; not checked
    Goto done
  ; checked -> write registry entry for current user
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mana" '"$INSTDIR\\Mana.exe"'
  ; fallthrough
  done:
FunctionEnd

; Mana's local data (chat history, saved sign-in, job tracker) lives in
; %APPDATA%\Mana\node-bot-data, not inside the install directory, so a
; normal uninstall leaves it alone by default (see issue #121) -- this page
; is how someone opts into deleting it too, instead of it happening
; silently either way.
UninstPage custom un.CustomDataPage

Function un.CustomDataPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 10u 10u 100% 32u "Mana keeps your chat history, saved sign-in, and job tracker data in $APPDATA\Mana\node-bot-data. Uninstalling does NOT delete this by default, so it's still there if you reinstall later."
  Pop $R0
  ${NSD_CreateCheckbox} 10u 46u 100% 12u "Also delete my Mana data"
  Pop $DELETE_DATA_CHECKBOX

  nsDialogs::Show
FunctionEnd

Function un.onUninstSuccess
  ; remove autostart registry entry
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mana"

  ; delete local data only if explicitly opted into on the page above
  ${NSD_GetState} $DELETE_DATA_CHECKBOX $R0
  StrCmp $R0 1 0 +2
    RMDir /r "$APPDATA\Mana\node-bot-data"
FunctionEnd
