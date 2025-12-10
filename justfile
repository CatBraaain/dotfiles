set shell := ["nu", "-c"]

run_ps_cmd := "powershell -NoProfile -ExecutionPolicy Bypass -Command"
run_ps_file := "powershell -NoProfile -ExecutionPolicy Bypass -File"

_:
  @just --list --unsorted

apply:
  chezmoi apply -c chezmoi.yaml --force

diff:
  chezmoi diff -c chezmoi.yaml

wintasks:
  wintasks jsonschema | save -f undotfiles/wintasks/wintasks-schema.json
  wintasks apply --path undotfiles/wintasks/wintasks.yaml

winget:
  gsudo {{run_ps_file}} undotfiles/winget.ps1

import "undotfiles/winconfig/justfile"
winconfig:
  gsudo just _winconfig
