$pathMaps = @{
    "docker"           = "AppData/Roaming/Docker"
    "erdtree"          = "AppData/Roaming/erdtree"
    "gemini"           = ".gemini"
    "mise"             = ".config/mise"
    "nushell"          = "AppData/Roaming/nushell"
    "obs-studio"       = "AppData/Roaming/obs-studio"
    "powershell"       = "Documents/WindowsPowerShell"
    "windows-terminal" = "AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState"
    "roo"              = ".roo"
    "sharex"           = "Documents/ShareX"
}

Remove-Item dist/* -Force -Recurse -ErrorAction SilentlyContinue
robocopy dotfiles dist /e | Out-Null
foreach ($pathMap in $pathMaps.GetEnumerator()) {
    robocopy dist/$($pathMap.Name) dist/$($pathMap.Value) /e /move | Out-Null
}

Get-ChildItem -Path ./dist -Recurse | % {
    if ($_.Name -like ".*" -and $_.Name -notlike ".chezmoi*") {
        $srcPath = (Resolve-Path $_.FullName -Relative)
        $dstPath = $srcPath -replace "\\[.]", "\dot_"
        Move-Item $srcPath $dstPath -Force
    }
}