@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1

set maybe_cli=
set "first_arg=%~1"
if "%first_arg:~0,1%"=="-" (
    set maybe_cli=YES
)

if "%maybe_cli%"=="YES" (
  "%~dp0..\Code.exe" "%~dp0..\resources\app\out\cli.js" %*
) else (
  start "" "%~dp0..\Code.exe" "%~dp0..\resources\app\out\cli.js" %*
)
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
