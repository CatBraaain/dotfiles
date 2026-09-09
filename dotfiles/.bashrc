case $- in
  *i*) ;;
  *) return ;;
esac

[ -f ~/.config/bash/bashrc ] && . ~/.config/bash/bashrc
[ -f ~/.secrets.sh ] && . ~/.secrets.sh

export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.local/go/bin:$PATH"
export PATH="$HOME/.local/node/bin:$PATH"
export PATH="$HOME/go/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.local/share/pnpm:$PATH"

if [ -x /home/linuxbrew/.linuxbrew/bin/brew ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi

export ANDROID_HOME="$HOME/.android-sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

[ -f "$HOME/.vite-plus/env" ] && . "$HOME/.vite-plus/env"

# Prefer Bun's global CLIs over stale npm globals in the Homebrew prefix.
export PATH="$HOME/.bun/bin:$PATH"

# keep-sorted start
alias a="pi"
alias ac="pi -c"
alias ar="pi -r"
alias c2p="code2prompt"
alias cmd="cmd.exe"
alias dc="docker compose"
alias j="just"
alias ksorted="keep-sorted"
alias ps="powershell.exe"
alias runp="bun run --parallel"
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
