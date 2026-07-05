set shell := ["pwsh", "-c"]

_:
  @just --list --unsorted

setup:
  Set-ExecutionPolicy -Scope CurrentUser Bypass -Force

apply:
  pwsh pre-chezmoi.ps1
  chezmoi apply -c chezmoi.yaml --force

diff:
  pwsh pre-chezmoi.ps1
  chezmoi diff -c chezmoi.yaml

winconfig:
  winconfig schema undotfiles/winconfig/winconfig.yaml --output undotfiles/winconfig/winconfig.schema.json --strict
  gsudo winconfig run undotfiles/winconfig/winconfig.yaml

wintasks:
  gsudo wintasks apply --path undotfiles/wintasks/wintasks.yaml

winget:
  gsudo pwsh undotfiles/winget.ps1

msime:
  pwsh undotfiles/ime/custom-msime-roma.ps1

autologon:
  autologon64