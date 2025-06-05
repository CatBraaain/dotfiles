$map = @(
    @{ src = "obs-studio"; dist = "AppData/Roaming/obs-studio" },
    @{ src = "mise"; dist = "dot_config/mise" },
    @{ src = "sharex"; dist = "Documents/ShareX" },
    @{ src = ".gitconfig"; dist = "dot_gitconfig" },
    @{ src = ".wslconfig"; dist = "dot_wslconfig" },
    @{ src = ".chezmoiexternal.yaml"; dist = ".chezmoiexternal.yaml" }
)

$dotSrc = "src/configs"
$dotDist = "dist/dotfiles"

if (Test-Path $dotDist) {
    Remove-Item -Path $dotDist -Recurse -Force | Out-Null
}

foreach ($item in $map) {
    $srcPath = Join-Path $dotSrc $($item.src)
    $distPath = Join-Path $dotDist $($item.dist)
    Copy-Item -Path $srcPath -Destination $distPath -Recurse -Force
}

$scriptDir = Join-Path $dotSrc ".dynamic"
Get-ChildItem -Path $scriptDir -Filter "*.ps1" | % {
    . $_.FullName
}
