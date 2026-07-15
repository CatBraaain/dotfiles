case $- in
  *i*) ;;
  *) return ;;
esac

[ -f ~/.config/bash/bashrc ] && . ~/.config/bash/bashrc

alias c2p="code2prompt"
alias dc="docker compose"
alias j="just"
alias uv-python-update="uv python install --reinstall 3.11 3.12 3.13"

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
