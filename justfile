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

[linux]
nix:
  # nix profile add ./undotfiles/nix
  nix profile upgrade undotfiles/nix
  bash undotfiles/nix/unflake.sh

[linux]
vscode:
  bash undotfiles/manage-vscode-extensions.sh

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
msime:
  pwsh undotfiles/ime/custom-msime-roma.ps1

[windows]
autologon:
  autologon64
