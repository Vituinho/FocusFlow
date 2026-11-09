; Remove the "start with Windows" registration written by app.setLoginItemSettings when FocusFlow is uninstalled,
; so no orphaned startup entry (or approval flag) is left behind. The Run value is named after the AppUserModelID.
!macro customUnInstall
  DeleteRegValue HKCU "SoftwareMicrosoftWindowsCurrentVersionRun" "br.com.focusflow.desktop"
  DeleteRegValue HKCU "SoftwareMicrosoftWindowsCurrentVersionExplorerStartupApprovedRun" "br.com.focusflow.desktop"
!macroend
