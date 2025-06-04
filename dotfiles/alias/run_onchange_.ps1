$aliasDir = "$env:USERPROFILE\alias"

remove-item "$aliasDir\*"
@(
    @{ aliasName = "npm"; commandName = "pnpm" }
    @{ aliasName = "rnpm"; commandName = "C:\nvm4w\nodejs\npm" }
) | % {
    New-Item "$aliasDir\$($_.aliasName).cmd" -Value $_.commandName -Force > $null
}
