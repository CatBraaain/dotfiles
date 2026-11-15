[windows]
set shell := ["pwsh", "-c"]

_:
  @just --list --unsorted

[linux]
setup:
  bash setup.sh

[windows]
setup:
  powershell setup.ps1

[linux]
install:
  bun undotfiles/install/linux.ts sync

[windows]
install *args:
  bun undotfiles/install/windows.ts {{ args }}

format:
  ~/.bun/install/global/node_modules/oxfmt/bin/oxfmt . "!**/*.md"
  prettier --write --plugin ~/.bun/install/global/node_modules/prettier-markdown-table/index.js "**/*.md"

apply:
  bun dotfiles-manager apply

[linux]
test-rime:
  #!/usr/bin/env bash
  set -euo pipefail
  cd dotfiles/rime
  generated="$(mktemp -d "${TMPDIR:-/tmp}/dotfiles-rime-unit.XXXXXX")"
  trap 'rm -rf "$generated"' EXIT
  bun zenkaku.build.ts --output "$generated/kagiroi_dotfiles_zenkaku.dict.yaml"
  bash tests/zenkaku_build.test.sh
  lua5.4 tests/candidate_gate.test.lua lua/kagiroi/candidate_gate.lua
  lua5.4 tests/rime_controls.test.lua lua/kagiroi/rime_controls.lua "$generated/lua/kagiroi/zenkaku_text.lua"
  lua5.4 tests/rime_ascii_toggle.test.lua lua/kagiroi/rime_ascii_toggle.lua lua/kagiroi/rime_controls.lua "$generated/lua/kagiroi/zenkaku_text.lua"
  lua5.4 tests/kagiroi_n_kana_speller.test.lua lua/kagiroi/kagiroi_n_kana_speller.lua "$generated/lua/kagiroi/zenkaku_rules.lua" "$generated/kagiroi_dotfiles_zenkaku.dict.yaml"
  lua5.4 tests/kagiroi_suffix.test.lua lua/kagiroi/kagiroi_n_kana_speller.lua "$generated/lua/kagiroi/zenkaku_rules.lua"
  lua5.4 tests/char_variants.test.lua lua/kagiroi/char_variants.lua
  lua5.4 tests/bunsetsu.test.lua lua/kagiroi/bunsetsu.lua
  lua5.4 tests/default_config.test.lua default.custom.yaml
  lua5.4 tests/weasel_config.test.lua weasel.custom.yaml
  lua5.4 tests/fcitx5_config.test.lua ../fcitx5/conf/rime.conf ../remap.data.md
  lua5.4 tests/kagiroi_config.test.lua kagiroi.custom.yaml lua/kagiroi/candidate_gate.lua "$generated/lua/kagiroi/zenkaku_text.lua"
  bash tests/rime/run.sh

# Record rime harness snapshots under dotfiles/rime/tests/rime/snapshots/.
# Usage: just test-rime-update            (refresh existing snapshot files)
#        just test-rime-update <scenario> (start guarding that scenario)
#        just test-rime-update all        (record every scenario)
# Review the diff before keeping the new files.
[linux]
test-rime-update scenario="":
    bash dotfiles/rime/tests/rime/run.sh {{ if scenario == "" { "--update" } else { "--update=" + scenario } }}

diff:
  bun dotfiles-manager diff

managed:
  bun dotfiles-manager managed

[windows]
winconfig *args:
  gsudo bun undotfiles/winconfig/engine.ts {{args}}

[windows]
wintasks:
  gsudo wintasks apply --path undotfiles/wintasks/wintasks.yaml

[windows]
msime mode="apply":
  $mode = "{{ mode }}"; $romaFlag = if ($mode -eq "diff") { @("--dry-run") } elseif ($mode -eq "apply") { @() } else { throw "mode must be apply or diff: $mode" }; $keyFlag = if ($mode -eq "diff") { @("--diff") } else { @() }; bun undotfiles/ime/msime/roma-def.ts @romaFlag && bun undotfiles/ime/msime/key-settings.ts @keyFlag

[windows]
autologon:
  autologon64
