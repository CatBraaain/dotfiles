set shell := ["pwsh", "-c"]

run_ps_file := "pwsh -NoProfile -ExecutionPolicy Bypass -File"

_:
  @just --list --unsorted

apply:
  {{run_ps_file}} map.ps1
  chezmoi apply -c chezmoi.yaml --force

diff:
  {{run_ps_file}} map.ps1
  chezmoi diff -c chezmoi.yaml

winconfig:
  winconfig schema undotfiles/winconfig/winconfig.yaml --output undotfiles/winconfig/winconfig.schema.json --strict
  gsudo winconfig run undotfiles/winconfig/winconfig.yaml

wintasks:
  gsudo wintasks apply --path undotfiles/wintasks/wintasks.yaml

winget:
  gsudo {{run_ps_file}} undotfiles/winget.ps1

autologon:
  autologon64