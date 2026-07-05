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
    "qishibo.AnotherRedisDesktopManager"
    # "Microsoft.AppInstaller"
    "AutoHotkey.AutoHotkey"
    "Oven-sh.Bun"
    "CPUID.CPU-Z"
    "MongoDB.Compass.Full"
    "BluePointLilac.ContextMenuManager"
    "sordum.EasyContextMenu"
    "Solidiquis.Erdtree"
    "w4po.ExplorerTabUtility"
    "Gyan.FFmpeg"
    "Rem0o.FanControl"
    "AdrienAllard.FileConverter"
    "GIMP.GIMP.3"
    "Git.Git"
    "GoLang.Go"
    "DuongDieuPhap.ImageGlass"
    "Casey.Just"
    "mulaRahul.Keyviz"
    "RussellBanks.Komac"
    "ch.LosslessCut"
    "MPC-BE.MPC-BE"
    "Mojang.MinecraftLauncher"
    "M2Team.NanaZip"
    "OpenJS.NodeJS.LTS"
    "OBSProject.OBSStudio"
    "Microsoft.PowerShell"
    "Guru3D.RTSS"
    "ShareX.ShareX"
    "Meltytech.Shotcut"
    "Valve.Steam"
    # "StirlingTools.StirlingPDF"
    "Microsoft.Sysinternals.Autologon"
    "XAMPPRocky.Tokei"
    "Canonical.Ubuntu"
    "Devolutions.UniGetUI"
    "Microsoft.VisualStudioCode"
    "WinDirStat.WinDirStat"
    "Microsoft.WindowsTerminal"
    "nektos.act"
    "twpayne.chezmoi"
    "GitHub.cli"
    "Microsoft.coreutils"
    "eza-community.eza"
    "sharkdp.fd"
    "Schniz.fnm"
    "orhun.git-cliff"
    "gerardog.gsudo"
    "HaraldBoegeholz.h2testw"
    "ezwinports.make"
    "jdx.mise"
    "pnpm.pnpm"
    "BurntSushi.ripgrep.MSVC"
    "CatBraaain.runx"
    "astral-sh.uv"
    "CatBraaain.winconfig"
    "MikeFarah.yq"
    # keep-sorted end
)
winget install "AutoHotkey.AutoHotkey" --silent --version 1.1.37.02 --no-upgrade --source winget
winget install $unmanagedPackages --no-upgrade --source winget
winget install $managedPackages --source winget

Remove-Item "$env:USERPROFILE\Desktop\*.lnk" -Force

$packagesDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
$linksDir = "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
Get-ChildItem -Path $packagesDir -Filter *.exe -Recurse | % {
    New-Item -ItemType SymbolicLink -Path $linksDir -Name $_.Name -Value $_.FullName -Force | Out-Null
}
