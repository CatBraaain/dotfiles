# OpenWhisprクリーンアッププロンプト自動登録 要件

## 背景

音声入力のクリーンアップが要約や言い換えを伴い、話者の強調や言い直しが失われる。クリーンアップ結果は別のコーディングエージェントのインプットになるため、情報の欠落が最も大きなリスクである。OpenWhispr のGUIからの手動登録は受け入れられず、dotfiles の apply への組み込みが必要。

## 目的

apply の実行で、フィラーのみを除去するクリーンアッププロンプト（`cleanup-prompt.txt`）が OpenWhispr に登録された状態にする。

## 要件・制約

- 対象OSは Linux と Windows。macOS は対象外
- `Preferences` または `Local Storage` が存在するディレクトリを認識済みの userData とする
- 未認識の userData では、プロンプトとインストール済みアプリの識別を検証した後、`status=skipped code=OK` とプロンプトの SHA-256 を返し、終了コード0 で終わる。英語の detail で OpenWhispr の起動・終了後に再実行するよう案内する。CLI はこの案内を色指定なしの stdout に表示し、stderr は空にする。エラー時の detail は stderr に表示する。hook lock の取得、harness の起動、shadow runtime の生成、登録・storage・既存ファイルへの書き込みは行わない
- プロンプトの欠損・不正、アプリの未インストール・識別失敗は、userData の認識状態によらず `INVALID_INPUT` エラーとする。認識済みuserData での hook lock と入力検証の優先順位は維持する
- 認識済みの userData で OpenWhispr が起動中のときはフックは何も書き換えず明確なエラー（LOCKED）で終わり、起動状態を変更しない。owner は必要に応じてアプリを終了してから applyする
- 登録済みの内容が一致する場合は何も変更しない
- 変更するのはクリーンアッププロンプトの1キーのみ。provider・model・認証情報・既存の `.env`・アプリの他のデータは変更しない
- 失敗時は適用前の状態へ復元する
- プロンプトの変換契約（フィラーのみ削除、言い直し・強調・語順の一字一句の保持、曖昧語の保持、要約・並べ替えの禁止、実質内容が残らない場合は原文のまま出力）は `cleanup-prompt.txt` を正本とする
- この文書は展開対象外であること（`remap.data.md` の除外行）

## 受け入れ条件

- 認識済みの userData では、owner が OpenWhispr を終了してから apply を実行した後、OpenWhispr の書き起こしクリーンアップが `cleanup-prompt.txt` の内容で動作する
- 未認識の userData では、検証に成功するとプロファイルの有無や既存ファイルを変えずに成功skipし、再実行に必要な案内を表示する
- worktree で `bun test` と `OPENWHISPR_E2E=1 bun test` が通る
- Linux・Windows の隔離実証により、実アプリ・実プロファイルに触れずに動作することを確認済みである
