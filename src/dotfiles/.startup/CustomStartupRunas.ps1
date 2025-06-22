using module ".\lib\RunAsync.psm1"

RunAsync "C:\Projects\AutoHotkey\Scripts\ScreenLock.ahk"

Invoke-Expression "winget upgrade --all --uninstall-previous"
Remove-Item "$env:USERPROFILE\Desktop\*.lnk" -Force

RunAsync "C:\Projects\AutoHotkey\src\Main.ahk"
RunAsync "C:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe"
RunAsync "Taskmgr.exe" -WinTitle "タスク マネージャー" -HideWin
# RunAsync "C:\Projects\Windows File History\NetShare.bat"

Invoke-Expression "explorer.exe .\CustomStartup.vbs"
