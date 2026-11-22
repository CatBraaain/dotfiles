# Dist path map

Each row maps an entry relative to this folder to an optional destination for each OS.
An empty cell keeps the entry at its original path; `-` removes it from `dist/`.

| key | linux | windows | macos |
| --- | --- | --- | --- |
| .agents |  |  | - |
| .agents/SYSTEM_PROMPT.yaml |  | - | - |
| .agents/config |  |  | - |
| .agents/scripts |  | - | - |
| .config |  |  | - |
| .gitconfig.local.sample | - | - | - |
| .local/cli |  |  | - |
| .pi |  |  | - |
| .playwright |  | - | - |
| .wslconfig | - |  | - |
| **/\*.sample | - | - | - |
| **/\*.spec.md | - | - | - |
| **/\*.requirements.md | - | - | - |
| **/\*.test.ts | - | - | - |
| **/SPEC.md | - | - | - |
| **/REQUIREMENTS.md | - | - | - |
| **/node_modules | - | - | - |
| docker | .docker/desktop | AppData/Roaming/Docker | - |
| fcitx5 | .config/fcitx5 | - | - |
| git-cliff | .config/git-cliff | AppData/Roaming/git-cliff | - |
| gsudo | - |  | - |
| rime/tests | - | - | - |
| rime | .local/share/fcitx5/rime | AppData/Roaming/Rime | - |
| localsend/settings.merge-existing.json | .local/share/org.localsend.localsend_app/shared_preferences.merge-existing.json | AppData/Roaming/LocalSend/settings.merge-existing.json | - |
| obs-studio | - | AppData/Roaming/obs-studio | - |
| open-whispr |  | AppData/Roaming/open-whispr | - |
| powershell | - | Documents/PowerShell | - |
| rtk | .config/rtk | - | - |
| sharex | - | Documents/ShareX | - |
| tmux | .config/tmux | .config/tmux | - |
| tmux/tmux.conf |  | - |  |
| vscode/extensions.apply.ts |  | AppData/Roaming/Code/User/extensions.windows-postapply.ts |  |
| vscode | .config/Code/User | AppData/Roaming/Code/User | - |
| windows-menu | - | AppData/Roaming/Microsoft/Windows/Start Menu/Programs | - |
| windows-terminal | - | AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState | - |
| zed | .config/zed | AppData/Roaming/Zed | - |
