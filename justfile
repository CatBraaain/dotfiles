set windows-shell := ["pwsh", "-c"]

_:
  @just --list --unsorted

[linux]
setup:
  bash setup.sh

[linux]
apply:
  bash pre-chezmoi.sh
  chezmoi apply -c chezmoi.yaml --force

[linux]
managed:
  bash pre-chezmoi.sh
  chezmoi managed -c chezmoi.yaml

[linux]
diff:
  bash pre-chezmoi.sh
  chezmoi diff -c chezmoi.yaml

[linux]
nix:
  nix profile upgrade undotfiles/flakes

[windows]
setup:
  powershell setup.ps1

[windows]
apply:
  pwsh pre-chezmoi.ps1
  chezmoi apply -c chezmoi.yaml --force

[windows]
diff:
  pwsh pre-chezmoi.ps1
  chezmoi diff -c chezmoi.yaml

[windows]
managed:
  bash pre-chezmoi.sh
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
