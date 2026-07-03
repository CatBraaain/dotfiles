$ahkExe = "`"C:\Program Files\AutoHotkey\UX\AutoHotkeyUX.exe`""
$codeExe = "`"C:\Users\USERNAME\AppData\Local\Programs\Microsoft VS Code\Code.exe`""

& runx $ahkExe --arg-line "C:\Projects\ahkfiles\ScreenLock\ScreenLock.ahk"

Invoke-Expression "pwsh -File C:\Projects\dotfiles\undotfiles\winget.ps1"
Remove-Item "$env:USERPROFILE\Desktop\*.lnk" -Force
Remove-Item "C:\Users\Public\Desktop\*.lnk" -Force

& runx $ahkExe --arg-line "C:\Projects\ahkfiles\Main\Main.ahk" --run-as
& runx "C:\Program Files (x86)\MSI Afterburner\MSIAfterburner.exe" --run-as --single-instance
& runx "Taskmgr.exe" --win-action minimize --run-as --single-instance
& runx "`"C:\Program Files\Docker\Docker\Docker Desktop.exe`"" --single-instance
& runx "`"C:\Program Files\ShareX\ShareX.exe`"" --single-instance
& runx "`"C:\Program Files\obs-studio\bin\64bit\obs64.exe`"" `
    --arg-line "--startreplaybuffer --minimize-to-tray --disable-shutdown-check" `
    --directory "C:\Program Files\obs-studio\bin\64bit" --single-instance
& runx "explorer.exe" --win-title ".* - エクスプローラー" --win-action maximize
& runx "pwsh" --arg-line "-c `"`"start-process -WindowStyle Hidden cmd.exe '/c code'`"`"" `
    --process-name "code.exe" --win-action activate --single-instance --log-level trace
& runx "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --win-title ".* - Google Chrome" --single-instance --win-action activate
