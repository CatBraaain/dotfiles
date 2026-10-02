# Dist path map

Each row maps an entry relative to this folder to an optional destination for each OS.
An empty cell keeps the entry at its original path; `-` removes it from `dist/`.

| key | linux | windows | macos |
| --- | --- | --- | --- |
| .agents |  | - | - |
| .dsh |  | - | - |
| .dsh/test | - | - | - |
| .dsh/plugins.exact/build.apply.test.ts | - | - | - |
| .gitconfig.local.sample | - | - | - |
| .pi |  | - | - |
| .pi/agent/bun_install.apply.test.ts | - | - | - |
| .pi/agent/extensions/*/index.test.ts | - | - | - |
| .playwright |  | - | - |
| .wslconfig | - |  | - |
| **/\*.sample | - | - | - |
| **/\*.spec.md | - | - | - |
| **/SPEC.md | - | - | - |
| **/node_modules | - | - | - |
| docker | .docker/desktop | AppData/Roaming/Docker | - |
| erdtree | .config/erdtree | AppData/Roaming/erdtree | - |
| fcitx5 | .config/fcitx5 | - | - |
| git-cliff | .config/git-cliff | AppData/Roaming/git-cliff | - |
| gsudo | - |  | - |
| rime/tests | - | - | - |
| rime | .local/share/fcitx5/rime | AppData/Roaming/Rime | - |
| localsend/settings.update.json | .local/share/org.localsend.localsend_app/shared_preferences.update.json | AppData/Roaming/LocalSend/settings.update.json | - |
| obs-studio | - | AppData/Roaming/obs-studio | - |
| open-whispr |  | AppData/Roaming/open-whispr | - |
| powershell | - | Documents/PowerShell | - |
| rtk | .config/rtk | - | - |
| sharex | - | Documents/ShareX | - |
| vscode/sync_vscode_extensions.apply.ts |  | - |  |
| vscode |  | AppData/Roaming/Code/User | - |
| windows-terminal | - | AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState | - |
| zed | .config/zed | AppData/Roaming/Zed | - |
