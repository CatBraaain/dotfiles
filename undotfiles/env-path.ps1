$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$sorted = (
    $userPath -split ';' | ? { 
        $_ -and $_.Trim() -ne '' 
    } | % { 
        $_.Trim() 
    } | Sort-Object -Unique
) -join ';'
$sorted
[Environment]::SetEnvironmentVariable("Path", $sorted, "User")
