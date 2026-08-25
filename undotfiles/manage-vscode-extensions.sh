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
  alefragnani.bookmarks
  astral-sh.ty
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
  rust-lang.rust-analyzer
  saber2pr.file-git-history
  svelte.svelte-vscode
  takumii.markdowntable
  tamasfe.even-better-toml
  tombonnike.vscode-status-bar-format-toggle
  # tomoki1207.pdf # for linux but not for wsl
  yzhang.markdown-all-in-one
  # keep-sorted end
)

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

  local to_install to_remove
  to_install="$( comm -13 <(printf '%s\n' "$installed") <(printf '%s\n' "$want") )"
  to_remove="$( comm -23 <(printf '%s\n' "$installed") <(printf '%s\n' "$want") )"

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
    sync_extensions "linux"
  else
    echo "warn: 'code' not found; skipping linux extensions" >&2
  fi

  if grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null 2>&1; then
    sync_extensions "windows"
  fi
}

main "$@"

