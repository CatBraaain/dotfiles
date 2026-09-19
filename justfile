set windows-shell := ["pwsh", "-c"]

_:
  @just --list --unsorted

[linux]
setup:
  bash setup.sh

[linux]
apply:
  bun pre-chezmoi.ts
  chezmoi apply -c chezmoi.yaml --force

[linux]
managed:
  bun pre-chezmoi.ts
  chezmoi managed -c chezmoi.yaml

[linux]
diff:
  bun pre-chezmoi.ts
  chezmoi diff -c chezmoi.yaml

install:
  bun undotfiles/bootstrap/bootstrap.ts sync

[windows]
setup:
  powershell setup.ps1

[windows]
apply:
  bun pre-chezmoi.ts
  chezmoi apply -c chezmoi.yaml --force

[windows]
diff:
  bun pre-chezmoi.ts
  chezmoi diff -c chezmoi.yaml

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
winget:
  gsudo pwsh undotfiles/winget.ps1

[windows]
msime mode="apply":
  $mode = "{{mode}}"; $romaFlag = if ($mode -eq "diff") { @("--dry-run") } elseif ($mode -eq "apply") { @() } else { throw "mode must be apply or diff: $mode" }; $keyFlag = if ($mode -eq "diff") { @("--diff") } else { @() }; bun undotfiles/ime/custom-roma-def.ts @romaFlag && bun undotfiles/ime/msime-key-settings.ts @keyFlag

[windows]
autologon:
  autologon64
