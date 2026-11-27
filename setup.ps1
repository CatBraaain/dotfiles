winget install Microsoft.PowerShell --source winget

$pathSources = @(
    $env:Path
    [Environment]::GetEnvironmentVariable('Path', 'Machine')
    [Environment]::GetEnvironmentVariable('Path', 'User')
)
$env:Path = ($pathSources -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';'

& pwsh -c {
    winget install Git.Git gerardog.gsudo Casey.Just Oven-sh.Bun --source winget
    Set-ExecutionPolicy -Scope CurrentUser Bypass -Force
    $dotfilesDir = Join-Path $HOME 'projects\dotfiles'
    if (-not (Test-Path $dotfilesDir)) {
        git clone https://github.com/CatBraaain/dotfiles.git $dotfilesDir
    }
    gsudo {
        cd (Join-Path $HOME 'projects\dotfiles')
        just install
        just winconfig
        just msime
        just apply
    }
}
