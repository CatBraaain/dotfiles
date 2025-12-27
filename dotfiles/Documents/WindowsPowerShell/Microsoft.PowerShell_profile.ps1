[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module Microsoft.PowerShell.Management
$unneccessaryAliases = @(
    "where"
)
$unneccessaryAliases | % { Remove-Item -Force "Alias:$_" }

Set-Alias -Name "where" -Value where.exe
Set-Alias -Name "which" -Value where.exe