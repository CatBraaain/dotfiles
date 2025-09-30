$coreutils_path = "${env:LOCALAPPDATA}\Microsoft\WinGet\Links\coreutils.exe"
$expand_path = "${env:USERPROFILE}\.local\coreutils"
New-Item -Path $expand_path -ItemType Directory -Force
$utilsList = @(coreutils --list)
$utilsList | ? {
    $_ -notin @("[")
} | % {
    "${expand_path}\${_}.exe"
} | ? {
    -not (Test-Path $_)
} | % {
    New-Item -ItemType SymbolicLink -Path $_ -Target $coreutils_path
}