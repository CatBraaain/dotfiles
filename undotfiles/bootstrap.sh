#!/usr/bin/env bash
# Bootstrap system packages and CLI tools for this dotfiles setup.
# No version management: every tool installs/updates to its latest release.
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
SDK_DIR="$HOME/.android-sdk"
APT_UPDATED=0

# region functions

# --- helpers ------------------------------------------------------------------

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

# --- system packages (apt / deb) ----------------------------------------------

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

ensure_powershell() {
  dpkg -s powershell >/dev/null 2>&1 && return 0
  local ubuntu_version
  ubuntu_version=$(lsb_release -rs)
  curl -fsSL -o /tmp/packages-microsoft-prod.deb \
    "https://packages.microsoft.com/config/ubuntu/${ubuntu_version}/packages-microsoft-prod.deb"
  sudo dpkg -i /tmp/packages-microsoft-prod.deb
  sudo apt update
  APT_UPDATED=1
  sudo apt install -y powershell
}

ensure_google_chrome() {
  dpkg -s google-chrome-stable >/dev/null 2>&1 && return 0
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub |
    sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" |
    sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
  sudo apt update
  APT_UPDATED=1
  sudo apt install -y google-chrome-stable
}

ensure_drawio() {
  dpkg -s drawio >/dev/null 2>&1 && return 0
  local url
  url=$(curl -s https://api.github.com/repos/JGraph/drawio-desktop/releases/latest |
    grep -o 'https[^"]*amd64[^"]*\.deb' | head -1)
  curl -fsSL -o /tmp/drawio.deb "$url"
  sudo dpkg -i /tmp/drawio.deb
}

ensure_androidsdk() {
  [[ -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]] && return 0
  local build
  build=$(curl -s https://dl.google.com/android/repository/repository2-3.xml |
    grep -o 'commandlinetools-linux-[0-9]*' | grep -o '[0-9]*$' | sort -n | tail -1)
  log "installing android cmdline-tools build $build"
  curl -fsSL -o /tmp/cmdline-tools.zip \
    "https://dl.google.com/android/repository/commandlinetools-linux-${build}_latest.zip"
  rm -rf /tmp/cmdline-tools-extract "$SDK_DIR/cmdline-tools"
  unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-extract
  mkdir -p "$SDK_DIR/cmdline-tools"
  mv /tmp/cmdline-tools-extract/cmdline-tools "$SDK_DIR/cmdline-tools/latest"
  yes | "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK_DIR" --licenses >/dev/null
  yes | "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK_DIR" "platform-tools" >/dev/null
}

# --- standalone tools ---------------------------------------------------------

ensure_vp() {
  command -v vp >/dev/null 2>&1 || curl -fsSL https://vite.plus | bash
}

ensure_bun() {
  command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
}

ensure_uv() {
  command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
}

ensure_ubi() {
  command -v ubi >/dev/null 2>&1 || {
    mkdir -p "$BIN_DIR"
    curl -sSL https://raw.githubusercontent.com/houseabsolute/ubi/master/bootstrap/bootstrap-ubi.sh |
      TARGET="$BIN_DIR" sh
  }
}

ensure_go() {
  command -v go >/dev/null 2>&1 && return 0
  local version
  version=$(curl -s 'https://go.dev/dl/?mode=json' |
    grep -o '"version": *"go[0-9][^"]*"' | head -1 | grep -o 'go[0-9][^"]*')
  log "installing go $version to ~/.local/go"
  curl -sL "https://go.dev/dl/${version}.linux-amd64.tar.gz" | tar -C "$HOME/.local" -xz
}

ensure_node() {
  command -v node >/dev/null 2>&1 && return 0
  local version
  version=$(curl -s https://nodejs.org/dist/index.json |
    grep -o '"version": *"v[0-9][^"]*"' | head -1 | grep -o 'v[0-9][^"]*')
  log "installing node $version to ~/.local/node"
  curl -fsSL "https://nodejs.org/dist/${version}/node-${version}-linux-x64.tar.gz" | tar -C "$HOME/.local" -xz
  rm -rf "$HOME/.local/node"
  mv "$HOME/.local/node-${version}-linux-x64" "$HOME/.local/node"
}

ensure_rustup() {
  command -v cargo >/dev/null 2>&1 && return 0
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  export PATH="$HOME/.cargo/bin:$PATH"
}

# --- tool installers (npm / python / cargo / github / go) ---------------------

npm_tool() {
  bun add -g "$1"
}

python_tool() {
  uv tool install --force "$1"
}

cargo_tool() {
  cargo install --locked "$1"
}

github_tool() {
  local repo="$1"
  shift
  ubi --project "$repo" --in "$BIN_DIR" "$@"
}

go_tool() {
  go install "$1@latest"
}

# endregion

# ==============================================================================
# System packages (apt / deb)
# ==============================================================================

log "system packages"

ensure_powershell
ensure_google_chrome
ensure_drawio
ensure_apt bubblewrap
ensure_apt build-essential
ensure_apt ffmpeg
ensure_apt fonts-noto-cjk
ensure_apt git
ensure_apt libasound2t64
ensure_apt socat
ensure_apt tmux
ensure_apt unzip
ensure_apt xvfb
ensure_androidsdk

# ==============================================================================
# Standalone tools
# ==============================================================================

log "standalone tools"

ensure_vp
ensure_bun
ensure_uv
ensure_ubi
ensure_go
ensure_node
ensure_rustup

# ==============================================================================
# LLM-only CLI tools
# ==============================================================================

log "LLM-only CLI tools"

github_tool ast-grep/ast-grep --exe sg
github_tool TomWright/dasel
github_tool Wilfred/difftastic --exe difft
github_tool sharkdp/hyperfine
github_tool jqlang/jq
github_tool chmln/sd
github_tool koalaman/shellcheck
github_tool mvdan/sh --exe shfmt
github_tool watchexec/watchexec
github_tool mufeedvh/code2prompt
github_tool pdfcpu/pdfcpu
github_tool rtk-ai/rtk
github_tool google/keep-sorted
npm_tool @earendil-works/pi-coding-agent
npm_tool agent-browser
npm_tool cursor-agent
npm_tool officecli
go_tool github.com/karust/openserp
python_tool 'trafilatura[all]'
python_tool 'mineru[all]'

# ==============================================================================
# General CLI tools
# ==============================================================================

log "general CLI tools"

github_tool nektos/act
github_tool cli/cli --exe gh
github_tool twpayne/chezmoi
github_tool eza-community/eza
github_tool sharkdp/fd --exe fd
github_tool jgm/pandoc
github_tool BurntSushi/ripgrep --exe rg
github_tool casey/just
github_tool terror/just-lsp
github_tool Serokell/nixfmt
github_tool mikefarah/yq
github_tool cargo-binstall/cargo-binstall
github_tool solidiquer/erdtree --exe erd
github_tool jdx/mise
cargo_tool git-cliff
cargo_tool tokei
npm_tool oxfmt
npm_tool oxlint
npm_tool tree-sitter-cli
npm_tool @typescript/native-preview # tsgo / tsgolint
python_tool harlequin
go_tool golang.org/x/tools/gopls
