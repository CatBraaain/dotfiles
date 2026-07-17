#!/usr/bin/env bash
set -euo pipefail

extensions_for_windows=(
  ms-vscode-remote.remote-wsl
)

extensions_for_linux=(
  # keep-sorted start by_regex=(?:#\s)?(.*) sticky_comments=no
  alefragnani.bookmarks
  anthropic.claude-code
  astral-sh.ty
  awalsh128.keep-sorted
  bierner.markdown-yaml-preamble
  bpruitt-goddard.mermaid-markdown-syntax-highlighting
  bradlc.vscode-tailwindcss
  catbraaain.auto-fix-venv
  catbraaain.conditional-config
  catbraaain.toggle-files-exclude
  charliermarsh.ruff
  christian-kohler.path-intellisense
  codeium.codeium
  csharpier.csharpier-vscode
  csholmq.excel-to-markdown-table
  davidkol.fastcompare
  docker.docker
  donjayamanne.githistory
  eamodio.gitlens
  emeraldwalk.runonsave
  formulahendry.code-runner
  foxundermoon.shell-format
  geeklearningio.graphviz-markdown-preview
  github.remotehub
  github.vscode-github-actions
  golang.go
  gurumukhi.selected-lines-count
  hashhar.gitattributes
  hediet.vscode-drawio
  henoc.svgeditor
  ibm.output-colorizer
  ionutvmi.reg
  janisdd.vscode-edit-csv
  jebbs.plantuml
  jinliming2.vscode-go-template
  jnoortheen.nix-ide
  joshbolduc.commitlint
  kevinrose.vsc-python-indent
  leathong.openscad-language-support
  mark-wiemer.vscode-autohotkey-plus-plus
  markwhen.markwhen
  mechatroner.rainbow-csv
  mhutchie.git-graph
  mikestead.dotenv
  ms-azuretools.vscode-containers
  ms-dotnettools.csdevkit
  ms-dotnettools.csharp
  ms-dotnettools.vscode-dotnet-runtime
  ms-playwright.playwright
  ms-python.debugpy
  ms-python.python
  ms-vscode.cpptools
  ms-vscode.powershell
  ms-vscode.remote-repositories
  mylesmurphy.prettify-ts
  naumovs.color-highlight
  nefrob.vscode-just-syntax
  oxc.oxc-vscode
  pomber.git-file-history
  redhat.java
  redhat.vscode-yaml
  rust-lang.rust-analyzer
  saber2pr.file-git-history
  savh.json5-kit
  shd101wyy.markdown-preview-enhanced
  stephanvs.dot
  svelte.svelte-vscode
  takumii.markdowntable
  tamasfe.even-better-toml
  thenuprojectcontributors.vscode-nushell-lang
  tintinweb.graphviz-interactive-preview
  tombonnike.vscode-status-bar-format-toggle
  unifiedjs.vscode-mdx
  vitest.explorer
  vsls-contrib.gistfs
  yoavbls.pretty-ts-errors
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

