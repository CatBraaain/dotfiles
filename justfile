set windows-shell := ["pwsh", "-c"]

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
install:
  bun undotfiles/install/windows.ts

apply:
  bun dotfiles-manager apply

[linux]
test-rime:
    #!/usr/bin/env bash
    set -euo pipefail
    cd dotfiles/rime
    lua5.4 tests/candidate_gate.test.lua lua/kagiroi/candidate_gate.lua
    lua5.4 tests/rime_controls.test.lua lua/kagiroi/rime_controls.lua
    lua5.4 tests/rime_ascii_toggle.test.lua lua/kagiroi/rime_ascii_toggle.lua
    lua5.4 tests/rime_henkan_filter.test.lua lua/kagiroi/rime_henkan_filter.lua
    lua5.4 tests/kagiroi_n_kana_speller.test.lua lua/kagiroi/kagiroi_n_kana_speller.lua
    bash tests/rime/run.sh

diff:
  bun dotfiles-manager diff

managed:
  bun dotfiles-manager managed

[windows]
winconfig:
  gsudo { \
    winconfig schema undotfiles/winconfig/winconfig.yaml --output undotfiles/winconfig/winconfig.schema.json --strict; \
    winconfig run undotfiles/winconfig/winconfig.yaml; \
  }

[windows]
wintasks:
  gsudo wintasks apply --path undotfiles/wintasks/wintasks.yaml

[windows]
msime mode="apply":
  $mode = "{{mode}}"; $romaFlag = if ($mode -eq "diff") { @("--dry-run") } elseif ($mode -eq "apply") { @() } else { throw "mode must be apply or diff: $mode" }; $keyFlag = if ($mode -eq "diff") { @("--diff") } else { @() }; bun undotfiles/ime/msime/roma-def.ts @romaFlag && bun undotfiles/ime/msime/key-settings.ts @keyFlag

[windows]
mozc mode="apply":
  $mode = "{{ mode }}"; if ($mode -eq "diff") { bun undotfiles/ime/mozc/roma-def.ts --dry-run } elseif ($mode -eq "export") { bun undotfiles/ime/mozc/roma-def.ts --export } elseif ($mode -eq "apply") { bun undotfiles/ime/mozc/roma-def.ts } else { throw "mode must be apply, diff or export: $mode" }

[windows]
autologon:
  autologon64
