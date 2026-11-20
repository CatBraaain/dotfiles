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
install:
  bun undotfiles/install/windows.ts

format:
  ~/.bun/install/global/node_modules/oxfmt/bin/oxfmt . "!**/*.md"
  prettier --write --plugin ~/.bun/install/global/node_modules/prettier-markdown-table/index.js "**/*.md"

apply:
  bun dotfiles-manager apply

[linux]
test-rime:
  bash dotfiles/rime/tests/run.sh

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

[positional-arguments]
[script("pwsh", "-NoProfile", "-File")]
[windows]
winconfig *args:
  bun undotfiles/winconfig/engine.ts @args
  exit $LASTEXITCODE

[positional-arguments]
[script("pwsh", "-NoProfile", "-File")]
[windows]
wintasks *args:
  $all = @("--path", "undotfiles/wintasks/wintasks.yaml") + $args
  bun undotfiles/wintasks @all
  exit $LASTEXITCODE

[windows]
msime mode="apply":
  $mode = "{{ mode }}"; $romaFlag = if ($mode -eq "diff") { @("--dry-run") } elseif ($mode -eq "apply") { @() } else { throw "mode must be apply or diff: $mode" }; $keyFlag = if ($mode -eq "diff") { @("--diff") } else { @() }; bun undotfiles/ime/msime/roma-def.ts @romaFlag && bun undotfiles/ime/msime/key-settings.ts @keyFlag

[windows]
autologon:
  autologon64
