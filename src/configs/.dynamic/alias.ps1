$aliasDir = ".\dist\dotfiles\exact_alias"

$aliases = @(
    @{ aliasName = "mr"; commandName = "mise run %*" }
    @{ aliasName = "uv-python-update"; commandName = "uv python install --reinstall 3.11 3.12 3.13" }
)

New-Item -ItemType "Directory" -Path $aliasDir -Force | Out-Null
Get-ChildItem -Path $aliasDir -File | ForEach-Object {
    Remove-Item -Path $_.FullName -Force
}

foreach ($alias in $aliases) {
    $filePath = Join-Path $aliasDir ("$($alias.aliasName).cmd")
    New-Item -Path $filePath -Value $alias.commandName -Force | Out-Null
}
