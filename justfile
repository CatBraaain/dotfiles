_:
  @just --list

apply:
  chezmoi apply -c chezmoi.yaml --force

diff:
  chezmoi diff -c chezmoi.yaml

alias:
  bun undotfiles/alias.bun.ts

taskscheduler:
  taskscheduler apply --path undotfiles/taskscheduler-tasks.yaml

winget:
  yq undotfiles/winget-packages.yaml -o json > ${TEMP}/winget-packages.json
  winget pin reset --force
  winget import ${TEMP}/winget-packages.json
  winget pin add Autohotkey.AutoHotkey
  del /q %USERPROFILE%\Desktop\*.lnk
