$src = Get-Content -Path ".\lib\WindowController.cs" | Out-String
Add-Type -TypeDefinition $src -Language CSharp
