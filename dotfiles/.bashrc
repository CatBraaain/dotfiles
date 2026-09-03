case $- in
  *i*) ;;
  *) return ;;
esac

[ -f ~/.config/bash/bashrc ] && . ~/.config/bash/bashrc
[ -f ~/.secrets.sh ] && . ~/.secrets.sh

export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/go/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.bun/bin:$PATH"
export PATH="$HOME/.local/share/pnpm:$PATH"
. "$HOME/.vite-plus/env"

# keep-sorted start
alias agent="cursor-agent"
alias c2p="code2prompt"
alias cmd="cmd.exe"
alias dc="docker compose"
alias j="just"
alias ksort="keep-sorted"
alias ps="powershell.exe"
alias a="pi"
alias runp="bun run --parallel"
alias uv-python-update="uv python install --reinstall 3.11 3.12 3.13"
alias wt="wt.exe"
# keep-sorted end

gwt() {
  local repository_root
  repository_root=$(git rev-parse --show-toplevel) || return

  local worktree_directory
  worktree_directory="$(dirname "$repository_root")/$(basename "$repository_root")-$1"

  git worktree add -b "$1" "$worktree_directory" || return
  code --add "$worktree_directory"
  cd "$worktree_directory" || return
}

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
