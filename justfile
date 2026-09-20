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

[linux]
apply:
  bun pre-chezmoi.ts
  chezmoi apply -c chezmoi.yaml --force

[windows]
apply:
  bun pre-chezmoi.ts
  chezmoi apply -c chezmoi.yaml --force

[linux]
diff:
  bun pre-chezmoi.ts
  chezmoi diff -c chezmoi.yaml

[windows]
diff:
  bun pre-chezmoi.ts
  chezmoi diff -c chezmoi.yaml

[linux]
managed:
  bun pre-chezmoi.ts
  chezmoi managed -c chezmoi.yaml

[windows]
managed:
  bun pre-chezmoi.ts
  chezmoi managed -c chezmoi.yaml

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
  $mode = "{{mode}}"; $romaFlag = if ($mode -eq "diff") { @("--dry-run") } elseif ($mode -eq "apply") { @() } else { throw "mode must be apply or diff: $mode" }; $keyFlag = if ($mode -eq "diff") { @("--diff") } else { @() }; bun undotfiles/ime/roma-def.ts @romaFlag && bun undotfiles/ime/key-settings.ts @keyFlag

[windows]
autologon:
  autologon64
