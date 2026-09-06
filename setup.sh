#!/usr/bin/env bash
set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  sudo apt update
  sudo apt install -y git curl
fi

DOTFILES_DIR="$HOME/projects/dotfiles"
if [[ ! -d "$DOTFILES_DIR" ]]; then
  git clone https://github.com/CatBraaain/dotfiles.git "$DOTFILES_DIR"
fi
cd "$DOTFILES_DIR"

bash undotfiles/bootstrap.sh

eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
just apply
