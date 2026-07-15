#!/usr/bin/env bash
set -euo pipefail

if ! command -v nix >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf -L \
    https://install.determinate.systems/nix | sh -s -- install
fi
export PATH="$HOME/.nix-profile/bin:$PATH"

if ! command -v git >/dev/null 2>&1; then
  nix profile add nixpkgs#git
fi

DOTFILES_DIR="$HOME/projects/dotfiles"
if [[ ! -d "$DOTFILES_DIR" ]]; then
  git clone https://github.com/CatBraaain/dotfiles.git "$DOTFILES_DIR"
fi
cd "$DOTFILES_DIR"

nix profile add ./undotfiles/flakes
nix profile upgrade undotfiles/flakes
just apply
