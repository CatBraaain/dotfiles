$aliasDir = ".\dist\dotfiles\exact_alias"

$aliases = @(
    # @{ aliasName = "npm"; commandName = "pnpm %*" },
    # @{ aliasName = "rnpm"; commandName = "C:\Program Files\nodejs\npm %*" }
)

New-Item -ItemType "Directory" -Path $aliasDir -Force | Out-Null
Get-ChildItem -Path $aliasDir -File | ForEach-Object {
    Remove-Item -Path $_.FullName -Force
}

foreach ($alias in $aliases) {
    $filePath = Join-Path $aliasDir ("$($alias.aliasName).cmd")
    New-Item -Path $filePath -Value $alias.commandName -Force | Out-Null
}
