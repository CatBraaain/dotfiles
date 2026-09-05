#!/usr/bin/env bash
set -euo pipefail

extensions_for_windows=(
  # keep-sorted start by_regex=(?:#\s)?(.*) sticky_comments=no
  ms-vscode-remote.remote-wsl
  tomoki1207.pdf
  # keep-sorted end
)

extensions_for_linux=(
  # keep-sorted start by_regex=(?:#\s)?(.*) sticky_comments=no
  116ideas.worktree-autosync
  alefragnani.bookmarks
  awalsh128.keep-sorted
  bierner.markdown-yaml-preamble
  bpruitt-goddard.mermaid-markdown-syntax-highlighting
  catbraaain.auto-fix-venv
  catbraaain.toggle-files-exclude
  charliermarsh.ruff
  christian-kohler.path-intellisense
  codeium.codeium
  davidkol.fastcompare
  donjayamanne.githistory
  eamodio.gitlens
  emeraldwalk.runonsave
  formulahendry.code-runner
  foxundermoon.shell-format
  golang.go
  grapecity.gc-excelviewer
  gurumukhi.selected-lines-count
  ibm.output-colorizer
  ionutvmi.reg
  jinliming2.vscode-go-template
  jnoortheen.nix-ide
  joshbolduc.commitlint
  mark-wiemer.vscode-autohotkey-plus-plus
  mechatroner.rainbow-csv
  mikestead.dotenv
  ms-azuretools.vscode-containers
  ms-vscode.powershell
  ms-vscode.remote-repositories
  mylesmurphy.prettify-ts
  naumovs.color-highlight
  nefrob.vscode-just-syntax
  oxc.oxc-vscode
  pomber.git-file-history
  redhat.vscode-yaml
  saber2pr.file-git-history
  shd101wyy.markdown-preview-enhanced
  svelte.svelte-vscode
  takumii.markdowntable
  tamasfe.even-better-toml
  tombonnike.vscode-status-bar-format-toggle
  # tomoki1207.pdf # for linux but not for wsl
  yzhang.markdown-all-in-one
  # keep-sorted end
)

# Built locally from source and installed via VSIX instead of the Marketplace.
local_vscode_extensions=(
  # keep-sorted start by_regex=(?:#\s)?(.*) sticky_comments=no
  todo-lsp.todo
  # keep-sorted end
)

todo_lsp_repo="$HOME/mirrors/github.com/CatBraaain/todo-lsp"

default_branch="main"

exclude_local_extensions() {
  grep -Fvx -f <(printf '%s\n' "${local_vscode_extensions[@]}") <<< "$1" || true
}

ensure_todo_lsp_repo() {
  if [[ -d "$todo_lsp_repo/.git" ]]; then
    git -C "$todo_lsp_repo" pull --ff-only origin "$default_branch" >&2
  elif [[ -e "$todo_lsp_repo" ]]; then
    echo "error: mirror path is not a Git repository: $todo_lsp_repo" >&2
    return 1
  else
    mkdir -p "$(dirname "$todo_lsp_repo")"
    git clone https://github.com/CatBraaain/todo-lsp.git "$todo_lsp_repo"
  fi
}

build_todo_lsp_vsix() {
  local extension_version vsix_path
  extension_version="$(cd "$todo_lsp_repo/vscode-todo" && node -p "require('./package.json').version")"
  vsix_path="$todo_lsp_repo/vscode-todo/todo-$extension_version.vsix"

  rm -f "$vsix_path"
  (cd "$todo_lsp_repo" && just prod) >&2
  (cd "$todo_lsp_repo/vscode-todo" && npm run package -- \
    --allow-missing-repository --no-rewrite-relative-links) >&2

  [[ -f "$vsix_path" ]] || {
    echo "error: VSIX was not created: $vsix_path" >&2
    return 1
  }
  printf '%s\n' "$vsix_path"
}

install_local_extensions() {
  local -a code_cmd=("$@")
  local local_head="" remote_head=""

  # Skip the whole clone/pull/build/install when the local HEAD already
  # matches the remote tip (checked via ls-remote, without pulling), tracked
  # files are unmodified (untracked build artifacts such as the built VSIX are
  # ignored), and the extension is still installed.
  if [[ -d "$todo_lsp_repo/.git" ]]; then
    local_head="$(git -C "$todo_lsp_repo" rev-parse HEAD)"
    remote_head="$(git -C "$todo_lsp_repo" ls-remote origin "refs/heads/$default_branch" | awk '{print $1}')"
    if [[ -n "$remote_head" && "$local_head" == "$remote_head" ]] &&
      [[ -z "$(git -C "$todo_lsp_repo" status --porcelain --untracked-files=no)" ]] &&
      "${code_cmd[@]}" --list-extensions 2>/dev/null | tr -d '\r' | grep -Fxq "todo-lsp.todo"; then
      echo "[linux] cached   todo-lsp.todo @ ${local_head:0:12}"
      return 0
    fi
  fi

  ensure_todo_lsp_repo

  local vsix_path
  vsix_path="$(build_todo_lsp_vsix)"
  echo "[linux] install $vsix_path"
  "${code_cmd[@]}" --install-extension "$vsix_path" --force
}

# usage: sync_extensions <label>   (label: linux | windows)
sync_extensions() {
  local label="$1"
  local -a code_cmd desired
  case "$label" in
    linux)
      code_cmd=(code)
      desired=("${extensions_for_linux[@]}")
      ;;
    windows)
      code_cmd=(powershell.exe -NoProfile -Command code)
      desired=("${extensions_for_windows[@]}")
      ;;
    *)
      echo "error: unknown label '$label' (expected: linux | windows)" >&2
      return 1
      ;;
  esac

  local installed want
  installed="$( "${code_cmd[@]}" --list-extensions 2>/dev/null \
                | tr -d '\r' \
                | grep -E '^[a-z0-9-]+\.[a-z0-9-]+$' \
                | sort -u )" || true
  want="$( printf '%s\n' "${desired[@]}" | sort -u )"

  local installed_marketplace desired_marketplace
  installed_marketplace="$(exclude_local_extensions "$installed")"
  desired_marketplace="$(exclude_local_extensions "$want")"

  local to_install to_remove
  to_install="$( comm -13 <(printf '%s\n' "$installed_marketplace") <(printf '%s\n' "$desired_marketplace") )"
  to_remove="$( comm -23 <(printf '%s\n' "$installed_marketplace") <(printf '%s\n' "$desired_marketplace") )"

  while IFS= read -r ext; do
    [[ -z "$ext" ]] && continue
    echo "[$label] install  $ext"
    "${code_cmd[@]}" --install-extension "$ext"
  done <<< "$to_install"

  while IFS= read -r ext; do
    [[ -z "$ext" ]] && continue
    echo "[$label] uninstall $ext"
    "${code_cmd[@]}" --uninstall-extension "$ext"
  done <<< "$to_remove"
}

main() {
  if command -v code >/dev/null 2>&1; then
    install_local_extensions code
    sync_extensions "linux"
  else
    echo "warn: 'code' not found; skipping linux extensions" >&2
  fi

  if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null 2>&1; then
    sync_extensions "windows"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

