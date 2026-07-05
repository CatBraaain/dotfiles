winget install Microsoft.PowerShell --source winget
& pwsh -c {
    winget install twpayne.chezmoi Git.Git gerardog.gsudo Casey.Just --source winget
    Set-ExecutionPolicy -Scope CurrentUser Bypass -Force
    if (-not (Test-Path C:/Projects/dotfiles)) {
        git clone https://github.com/CatBraaain/dotfiles.git C:\Projects\dotfiles
    }
    gsudo {
        cd C:/Projects/dotfiles
        just winget
        just winconfig
        just msime
        just apply
    }
}
