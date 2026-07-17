case $- in
  *i*) ;;
  *) return ;;
esac

[ -f ~/.config/bash/bashrc ] && . ~/.config/bash/bashrc

# keep-sorted start
alias agent="cursor-agent"
alias c2p="code2prompt"
alias cmd="cmd.exe"
alias dc="docker compose"
alias j="just"
alias ksort="keep-sorted"
alias ps="powershell.exe"
alias uv-python-update="uv python install --reinstall 3.11 3.12 3.13"
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
