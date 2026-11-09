; Remove the "start with Windows" registration written by app.setLoginItemSettings when FocusFlow is uninstalled,
; so no orphaned startup entry (or approval flag) is left behind.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FocusFlow"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "FocusFlow"
!macroend
