_:
  @just --list

apply:
  bun compiler/configs2dotfiles.bun.js
  chezmoi apply -c chezmoi.yaml --force

diff:
  bun compiler/configs2dotfiles.bun.js
  chezmoi diff -c chezmoi.yaml

apply-tasks:
  bun compiler/configs2dotfiles.bun.js
  chezmoi apply "$USERPROFILE/.taskscheduler/tasks.yaml" -c chezmoi.yaml --force
  taskscheduler apply --path $USERPROFILE/.taskscheduler/tasks.yaml

winget-install:
  yq src/configs/.winget/packages.yaml -o json > dist/winget-packages.json
  winget pin reset --force
  winget import dist/winget-packages.json
  winget pin add Autohotkey.AutoHotkey
  del /q %USERPROFILE%\Desktop\*.lnk
