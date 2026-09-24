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
  gsudo pwsh undotfiles/install/windows.ps1

apply:
  bun scripts/pre-chezmoi.ts
  bun scripts/home-apply.ts dist ~

diff:
  bun scripts/pre-chezmoi.ts
  bun scripts/home-diff.ts dist ~

managed:
  bun scripts/pre-chezmoi.ts
  bun scripts/home-diff.ts --managed dist ~

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
  $mode = "{{ mode }}"; if ($mode -eq "diff") { bun undotfiles/ime/mozc/roma-def.ts --dry-run } elseif ($mode -eq "apply") { bun undotfiles/ime/mozc/roma-def.ts } else { throw "mode must be apply or diff: $mode" }

[windows]
autologon:
  autologon64
