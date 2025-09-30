run_ps_cmd := "powershell -NoProfile -ExecutionPolicy Bypass -Command"
run_ps_file := "powershell -NoProfile -ExecutionPolicy Bypass -File"

_:
  @just --list --unsorted

apply:
  chezmoi apply -c chezmoi.yaml --force

diff:
  chezmoi diff -c chezmoi.yaml

wintasks:
  wintasks jsonschema > undotfiles/wintasks/wintasks-schema.json
  wintasks apply --path undotfiles/wintasks/wintasks.yaml

winget:
  yq undotfiles/winget/packages.yaml -o json > ${TEMP}/packages.json
  winget pin reset --force
  winget import ${TEMP}/packages.json
  winget pin add Autohotkey.AutoHotkey
  rm -f $(cygpath $USERPROFILE/Desktop/*.lnk)
  rm -f $(cygpath $PUBLIC/Desktop/*.lnk)
  {{run_ps_file}} undotfiles/winget/expand_coreutils.ps1

import "undotfiles/debloat/justfile"
debloat:
  just win11debloat
  just winutil
  just setup-powerplan
