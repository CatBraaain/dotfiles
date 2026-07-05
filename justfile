set shell := ["pwsh", "-c"]

_:
  @just --list --unsorted

setup:
  powershell setup.ps1

apply:
  pwsh pre-chezmoi.ps1
  chezmoi apply -c chezmoi.yaml --force

diff:
  pwsh pre-chezmoi.ps1
  chezmoi diff -c chezmoi.yaml

winconfig:
  gsudo { \
    winconfig schema undotfiles/winconfig/winconfig.yaml --output undotfiles/winconfig/winconfig.schema.json --strict; \
    winconfig run undotfiles/winconfig/winconfig.yaml; \
  }

wintasks:
  gsudo wintasks apply --path undotfiles/wintasks/wintasks.yaml

winget:
  gsudo pwsh undotfiles/winget.ps1

msime:
  pwsh undotfiles/ime/custom-msime-roma.ps1

autologon:
  autologon64