[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Import-Module Microsoft.PowerShell.Management
Get-Alias | % { if ($_.Name -notin @("%", "?")) { Remove-Item -Force "Alias:$($_.Name)" } }
