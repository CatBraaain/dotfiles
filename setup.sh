#!/usr/bin/env bash
# One-shot setup for a fresh Linux machine: install the tools needed to run
# this repo's TypeScript entry points (git, Homebrew, bun), clone the repo,
# then hand over to undotfiles/bootstrap/bootstrap.ts (system packages) and `just apply`.
set -euo pipefail

# Homebrew on Linux official installer default. Only this path is hardcoded:
# `brew --prefix` needs a working brew, which we may not have yet.
BREW_BIN="/home/linuxbrew/.linuxbrew/bin/brew"
APT_UPDATED=0

apt_update_once() {
	[[ $APT_UPDATED -eq 0 ]] || return 0
	sudo apt update
	APT_UPDATED=1
}

ensure_apt() {
	dpkg -s "$1" >/dev/null 2>&1 && return 0
	apt_update_once
	sudo apt install -y "$1"
}

ensure_apt curl            # Homebrew installer fetches its script with it
ensure_apt git             # clones this repo; Homebrew installer prerequisite
ensure_apt build-essential # Homebrew on Linux build prerequisite

DOTFILES_DIR="$HOME/projects/dotfiles"
if [[ ! -d "$DOTFILES_DIR" ]]; then
	git clone https://github.com/CatBraaain/dotfiles.git "$DOTFILES_DIR"
fi
cd "$DOTFILES_DIR"

# --- homebrew ----------------------------------------------------------------

if [[ ! -x "$BREW_BIN" ]]; then
	NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$("$BREW_BIN" shellenv)"

# bun runs bootstrap/bootstrap.ts and pre-chezmoi.ts. Also kept as a brew
# formula in config.yaml; bootstrap keeps both paths in sync idempotently.
command -v bun >/dev/null 2>&1 || brew install bun

bun undotfiles/bootstrap/bootstrap.ts sync

just apply
