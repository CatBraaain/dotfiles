if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) { Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs; exit }

$unmanagedPackages = @(
    "Discord.Discord"
    "Docker.DockerDesktop"
    "Google.Chrome"
    "Mozilla.Firefox"
)
$managedPackages = @(
    "AdrienAllard.FileConverter"
    "astral-sh.uv"
    "AutoHotkey.AutoHotkey"
    "beekeeper-studio.beekeeper-studio"
    "BluePointLilac.ContextMenuManager"
    "Canonical.Ubuntu"
    "Casey.Just"
    "ch.LosslessCut"
    "CPUID.CPU-Z"
    "DuongDieuPhap.ImageGlass"
    "ezwinports.make"
    "gerardog.gsudo"
    "GIMP.GIMP.3"
    "Git.Git"
    "GitHub.cli"
    "GoLang.Go"
    "Guru3D.Afterburner"
    "Guru3D.RTSS"
    "Gyan.FFmpeg"
    "HaraldBoegeholz.h2testw"
    "jdx.mise"
    "M2Team.NanaZip"
    "MartiCliment.UniGetUI"
    "Meltytech.Shotcut"
    "Microsoft.AppInstaller"
    "Microsoft.VisualStudioCode"
    "Microsoft.WindowsTerminal"
    "MikeFarah.yq"
    "Mojang.MinecraftLauncher"
    "MongoDB.Compass.Full"
    "MPC-BE.MPC-BE"
    "mulaRahul.Keyviz"
    "nektos.act"
    "Nushell.Nushell"
    "OBSProject.OBSStudio"
    "OpenJS.NodeJS.LTS"
    "Oven-sh.Bun"
    "pnpm.pnpm"
    "qishibo.AnotherRedisDesktopManager"
    "ShareX.ShareX"
    "Solidiquis.Erdtree"
    # "StirlingTools.StirlingPDF"
    "sxyazi.yazi"
    "Sysinternals.Autologon"
    "TortoiseGit.TortoiseGit"
    "twpayne.chezmoi"
    "uutils.coreutils"
    "Valve.Steam"
    "w4po.ExplorerTabUtility"
    "WinDirStat.WinDirStat"
)
winget install "AutoHotkey.AutoHotkey" --version 1.1.37.02 --no-upgrade --source winget
winget install $unmanagedPackages --no-upgrade --source winget
winget install $managedPackages --source winget


$coreutils_path = "${env:LOCALAPPDATA}\Microsoft\WinGet\Links\coreutils.exe"
$expand_path = "${env:USERPROFILE}\.local\coreutils"
New-Item -Path $expand_path -ItemType Directory -Force | Out-Null
$utilsList = @(coreutils --list)
$utilsList | ? {
    $_ -notin @("[")
} | % {
    "${expand_path}\${_}.exe"
} | ? {
    -not (Test-Path $_)
} | % {
    New-Item -ItemType SymbolicLink -Path $_ -Target $coreutils_path
}