using module ".\lib\RunAsync.psm1"

# RunAsync "C:\Program Files\Google\Drive File Stream\launch.bat"
RunAsync "C:\Program Files\Docker\Docker\Docker Desktop.exe"
RunAsync "C:\Program Files\ShareX\ShareX.exe"
RunAsync "C:\Program Files\obs-studio\bin\64bit\obs64.exe" "--startreplaybuffer --minimize-to-tray --disable-shutdown-check"
# RunAsync "C:\Users\PRO\AppData\Local\Programs\Rakuten\Rakuten Link.exe" -WinTitle "Rakuten Link" -CloseWin
RunAsync "explorer.exe" -WinTitle "PC"
RunAsync "Code" "C:\Users\PRO\Documents\TasksTodo" -WinTitle "*TasksTodo - Visual Studio Code" -Options "-WindowStyle Hidden"
RunAsync "Code" "C:\Projects\practice-immich" -WinTitle "*practice-immich - Visual Studio Code" -Options "-WindowStyle Hidden"
RunAsync "C:\Program Files\Google\Chrome\Application\chrome.exe" -WinTitle "* - Google Chrome"
