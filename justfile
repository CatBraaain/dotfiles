apply:
  bun compiler/configs2dotfiles.bun.js
  chezmoi apply -c chezmoi.yaml --force

diff:
  bun compiler/configs2dotfiles.bun.js
  chezmoi diff -c chezmoi.yaml

winget-install:
  yq src/configs/.winget/packages.yaml -o json > dist/winget-packages.json
  winget pin reset --force
  winget import dist/winget-packages.json
  winget pin add Autohotkey.AutoHotkey
  del /q %USERPROFILE%\Desktop\*.lnk
