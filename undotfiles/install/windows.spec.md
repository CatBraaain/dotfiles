# Windows install spec

`undotfiles/install/windows.ps1` の観測可能な振る舞いの仕様。対象は、管理者権限のPowerShellでスクリプトを実行したときのWinGetパッケージ導入と後処理である。

- 実行形式: `pwsh undotfiles/install/windows.ps1`。
- 管理者権限がない場合、スクリプトは管理者権限のPowerShellを起動し、自身の処理を終了する。
- `OpenWhispr.OpenWhispr`をmanaged packageとしてWinGetへ渡し、OpenWhisprを導入または更新する。
- OpenWhisprのAPI key、文字起こし設定、AI cleanup設定はこのスクリプトで管理しない。
- インストール後、ユーザーのDesktopにある`.lnk`を削除し、WinGet package directory配下の`.exe`へのsymbolic linkをWinGet links directoryへ作成する。
