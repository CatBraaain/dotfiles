$pathMaps = @{
    "docker"           = "AppData/Roaming/Docker"
    "erdtree"          = "AppData/Roaming/erdtree"
    "gemini"           = ".gemini"
    "gsudo"            = "gsudo"
    "mise"             = ".config/mise"
    "nushell"          = "AppData/Roaming/nushell"
    "obs-studio"       = "AppData/Roaming/obs-studio"
    "powershell"       = "Documents/WindowsPowerShell"
    "windows-terminal" = "AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState"
    "roo"              = ".roo"

    ".gitconfig"       = ".gitconfig"
    ".nirc"            = ".nirc"
    ".wslconfig"       = ".wslconfig"
}

Remove-Item dist/* -Force -Recurse
foreach ($pathMap in $pathMaps.GetEnumerator()) {
    Copy-Item dotfiles/$($pathMap.Name) dist/$($pathMap.Value) -Recurse -Force
}
