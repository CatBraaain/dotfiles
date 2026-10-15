# Session environment is owned by ~/.profile (read by login shells).
# Non-login interactive shells (e.g. the VS Code integrated terminal) read only
# this file, so source it here unless it already ran in this startup chain.
if [ -z "${_DOTFILES_ENV_LOADED:-}" ] && [ -f ~/.profile ]; then
  . ~/.profile
fi

case $- in
  *i*) ;;
  *) return ;;
esac

[ -f ~/.config/bash/bashrc ] && . ~/.config/bash/bashrc
[ -f ~/.secrets.sh ] && . ~/.secrets.sh

if [ -e /dev/dxg ] && grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease; then
  export GALLIUM_DRIVER="d3d12"
fi

# keep-sorted start
alias a="pi"
alias ac="pi -c"
alias ah="pi --class high"
alias aj="pi --agent junior"
alias al="pi --class low"
alias am="pi --class middle"
alias ar="pi -r"
alias as="pi --agent senior"
alias c2p="code2prompt"
alias cmd="cmd.exe"
alias dc="docker compose"
alias browse="bun ~/.agents/cli/browse"
alias j="just"
alias ksorted="keep-sorted"
alias runp="bun run --parallel"
alias ticket="bun ~/.agents/cli/ticket"
alias uv-python-update="uv python install --reinstall 3.11 3.12 3.13"
alias win="powershell.exe"
alias wt="wt.exe"
# keep-sorted end

docker-inspect() {
  docker exec -it "$@" /bin/sh
}

just-init() {
  printf '_:\n  @just --list --unsorted\n' > justfile
}

uv-init() {
  uv init --bare
  uv venv
}

eza-tree() {
  eza --git-ignore --group-directories-first --tree "$@"
}
