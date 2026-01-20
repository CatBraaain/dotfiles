set shell := ["powershell.exe", "-c"]

run_ps_cmd := "powershell -NoProfile -ExecutionPolicy Bypass -Command"
run_ps_file := "powershell -NoProfile -ExecutionPolicy Bypass -File"

_:
  @just --list --unsorted

apply:
  {{run_ps_file}} map.ps1
  chezmoi apply -c chezmoi.yaml --force

diff:
  {{run_ps_file}} map.ps1
  chezmoi diff -c chezmoi.yaml

winconfig:
  winconfig run undotfiles/winconfig/winconfig.yaml

wintasks:
  wintasks apply --path undotfiles/wintasks/wintasks.yaml

winget:
  gsudo {{run_ps_file}} undotfiles/winget.ps1

autologon:
  autologon64