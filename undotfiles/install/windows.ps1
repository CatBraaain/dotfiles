if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) { Start-Process pwsh "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs; exit }

$unmanagedPackages = @(
    # keep-sorted start by_regex=\..+ sticky_comments=no
    "Google.Chrome"
    "Discord.Discord"
    "Docker.DockerDesktop"
    "Mozilla.Firefox"
    # keep-sorted end
)
$managedPackages = @(
    # keep-sorted start by_regex=\..+ sticky_comments=no
    "Guru3D.Afterburner"
    # "Microsoft.AppInstaller"
    "CPUID.CPU-Z"
    "BluePointLilac.ContextMenuManager"
    "sordum.EasyContextMenu"
    "w4po.ExplorerTabUtility"
    "Rem0o.FanControl"
    "AdrienAllard.FileConverter"
    "GIMP.GIMP.3"
    "DuongDieuPhap.ImageGlass"
    # "mulaRahul.Keyviz"
    "ch.LosslessCut"
    "MPC-BE.MPC-BE"
    "Mojang.MinecraftLauncher"
    "M2Team.NanaZip"
    "OBSProject.OBSStudio"
    "OpenWhispr.OpenWhispr"
    "Guru3D.RTSS"
    "ShareX.ShareX"
    "Meltytech.Shotcut"
    "Valve.Steam"
    # "StirlingTools.StirlingPDF"
    "Microsoft.Sysinternals.Autologon"
    "Devolutions.UniGetUI"
    "Microsoft.VisualStudioCode"
    "WinDirStat.WinDirStat"
    "Microsoft.WindowsTerminal"
    "ZedIndustries.Zed"
    "HaraldBoegeholz.h2testw"
    # keep-sorted end
)
$managedDevPackages = @(
    # keep-sorted start by_regex=\..+ sticky_comments=no
    # "qishibo.AnotherRedisDesktopManager"
    "AutoHotkey.AutoHotkey" # windows
    "Oven-sh.Bun"
    "Solidiquis.Erdtree"
    "Git.Git"
    "Casey.Just"
    "RussellBanks.Komac"
    "OpenJS.NodeJS.LTS"
    "Microsoft.PowerShell" # windows
    "Canonical.Ubuntu" # windows
    "GitHub.cli"
    "Microsoft.coreutils"
    "gerardog.gsudo" # windows
    "CatBraaain.runx" # windows
    "CatBraaain.winconfig" # windows
    # keep-sorted end
)

winget install "AutoHotkey.AutoHotkey" --silent --version 1.1.37.02 --no-upgrade --source winget
winget install "twpayne.chezmoi" --scope machine --source winget
winget install $unmanagedPackages --no-upgrade --source winget
winget install $managedPackages --source winget
winget install $managedDevPackages --source winget

# Mozc: no winget package nor GitHub release exists; the official CI (CI for
# Windows workflow) publishes an MSI as a run artifact instead, which needs
# GitHub authentication. Requires gh from $managedDevPackages and `gh auth login`.
$mozcRun = gh run list --repo google/mozc --workflow=windows.yaml --status=success --limit 1 --json databaseId --jq '.[0].databaseId'
$mozcDir = Join-Path $env:TEMP "mozc-install"
New-Item -ItemType Directory -Path $mozcDir -Force | Out-Null
gh run download $mozcRun --repo google/mozc --name Mozc64_x64.msi --dir $mozcDir
Start-Process msiexec -ArgumentList "/i", "`"$mozcDir\Mozc64_x64.msi`"", "/qn" -Wait
Remove-Item $mozcDir -Recurse -Force

Remove-Item "$env:USERPROFILE\Desktop\*.lnk" -Force

$packagesDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
$linksDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
Get-ChildItem -Path $packagesDir -Filter *.exe -Recurse | % {
    New-Item -ItemType SymbolicLink -Path $linksDir -Name $_.Name -Value $_.FullName -Force | Out-Null
}
