$coreutils_path = "${env:LOCALAPPDATA}\Microsoft\WinGet\Links\coreutils.exe"
$utilsList = @(coreutils --list)
$utilsList | ? {
    $_ -notin @("[")
} | % {
    "${env:USERPROFILE}\.local\coreutils\${_}.exe"
} | ? {
    -not (Test-Path $_)
} | % {
    New-Item -ItemType SymbolicLink -Path $_ -Target $coreutils_path
}