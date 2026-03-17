[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Remove-Item -Force "Alias:where"
Remove-Item -Force "Alias:cp"
Remove-Item -Force "Alias:rm"
Set-Alias -Name "where" -Value "where.exe"
Set-Alias -Name "which" -Value "where.exe"

Set-Alias -Name "dc" -Value "docker compose"
Set-Alias -Name "docker-inspect" -Value "docker exec -it %* /bin/sh"
Set-Alias -Name "j" -Value "just"
Set-Alias -Name "just-init" -Value "`"_:`n@just --list --unsorted`" | Out-File -Encoding utf8 justfile"
Set-Alias -Name "mise-init" -Value "mise gen config -o mise.toml"
Set-Alias -Name "mr" -Value "mise run"
Set-Alias -Name "uv-init" -Value "uv init --bare & uv venv"
Set-Alias -Name "uv-python-update" -Value "uv python install --reinstall 3.11 3.12 3.13"

function bunr {
    bun run $args
}

function eza-tree {
    eza --git-ignore --group-directories-first --tree $args
}
