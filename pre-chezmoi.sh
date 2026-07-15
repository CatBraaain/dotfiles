#!/usr/bin/env bash
set -euo pipefail

declare -A path_maps=(
  ["docker"]=".docker/desktop"
  ["erdtree"]=".config/erdtree"
  ["git-cliff"]=".config/git-cliff"
)

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
