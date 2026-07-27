#!/usr/bin/env bash
set -euo pipefail

case "$OSTYPE" in
  msys*|cygwin*|win32*)
    declare -A path_maps=(
      ["docker"]="AppData/Roaming/Docker"
      ["erdtree"]="AppData/Roaming/erdtree"
      ["gemini"]=".gemini"
      ["git-cliff"]="AppData/Roaming/git-cliff"
      ["mise"]=".config/mise"
      ["nushell"]="AppData/Roaming/nushell"
      ["obs-studio"]="AppData/Roaming/obs-studio"
      ["powershell"]="Documents/PowerShell"
      ["windows-terminal"]="AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState"
      ["roo"]=".roo"
      ["sharex"]="Documents/ShareX"
      ["vscode"]="AppData/Roaming/Code/User"
    )
    ;;
  *)
    declare -A path_maps=(
      ["docker"]=".docker/desktop"
      ["erdtree"]=".config/erdtree"
      ["git-cliff"]=".config/git-cliff"
    )
    ;;
esac

rm -rf dist
mkdir -p dist
cp -a dotfiles/. dist/
for src in "${!path_maps[@]}"; do
  if [[ -e "dist/$src" ]]; then
    dst="dist/${path_maps[$src]}"
    mkdir -p "$(dirname "$dst")"
    rm -rf "$dst"
    mv "dist/$src" "$dst"
  fi
done

mapfile -t dot_entries < <(find dist -depth \( -name '.*' ! -name '.chezmoi*' \))
for src in "${dot_entries[@]}"; do
  name="$(basename "$src")"
  dst="$(dirname "$src")/dot_${name#.}"
  mv "$src" "$dst"
done
