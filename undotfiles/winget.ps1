if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) { Start-Process pwsh "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs; exit }

$unmanagedPackages = @(
    # keep-sorted start by_regex=\..+ sticky_comments=no
    "Google.Chrome"
    "Discord.Discord"
    "Docker.DockerDesktop"
    "Mozilla.Firefox"
    "TortoiseGit.TortoiseGit"
    "beekeeper-studio.beekeeper-studio"
    # keep-sorted end
)
$managedPackages = @(
    # keep-sorted start by_regex=\..+ sticky_comments=no
    "Guru3D.Afterburner"
    # "Microsoft.AppInstaller"
    "CPUID.CPU-Z"
    # "MongoDB.Compass.Full"
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
    "HaraldBoegeholz.h2testw"
    # keep-sorted end
)
$managedDevPackages = @(
    # keep-sorted start by_regex=\..+ sticky_comments=no
    # "qishibo.AnotherRedisDesktopManager"
    "AutoHotkey.AutoHotkey" # windows
    "Oven-sh.Bun"
    "Solidiquis.Erdtree"
    "Gyan.FFmpeg"
    "Git.Git"
    "GoLang.Go"
    "Casey.Just"
    "RussellBanks.Komac"
    "OpenJS.NodeJS.LTS"
    "Microsoft.PowerShell" # windows
    "XAMPPRocky.Tokei"
    "Canonical.Ubuntu" # windows
    "nektos.act"
    "twpayne.chezmoi"
    "GitHub.cli"
    "Microsoft.coreutils"
    "eza-community.eza"
    "sharkdp.fd"
    "orhun.git-cliff"
    "gerardog.gsudo" # windows
    "ezwinports.make"
    "jdx.mise"
    "pnpm.pnpm"
    "BurntSushi.ripgrep.MSVC"
    "CatBraaain.runx" # windows
    "astral-sh.uv"
    "CatBraaain.winconfig" # windows
    "MikeFarah.yq"
    # keep-sorted end
)

winget install "AutoHotkey.AutoHotkey" --silent --version 1.1.37.02 --no-upgrade --source winget
winget install $unmanagedPackages --no-upgrade --source winget
winget install $managedPackages --source winget
winget install $managedDevPackages --source winget

Remove-Item "$env:USERPROFILE\Desktop\*.lnk" -Force

$packagesDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
$linksDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
Get-ChildItem -Path $packagesDir -Filter *.exe -Recurse | % {
    New-Item -ItemType SymbolicLink -Path $linksDir -Name $_.Name -Value $_.FullName -Force | Out-Null
}
