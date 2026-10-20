# OpenWhispr自動設定登録 要件

## 背景

音声入力のクリーンアップが要約や言い換えを伴い、話者の強調や言い直しが失われる。クリーンアップ結果は別のコーディングエージェントのインプットになるため、情報の欠落が最も大きなリスクである。OpenWhispr のGUIからの手動登録は受け入れられず、dotfiles の apply への組み込みが必要。

また会議検出通知は、会話中に意図しないタイミングで割り込むため無効化したい。音声アシスタントは発話中の呼びかけをコマンドとして実行し、文字起こし以外の応答を貼り付けるため無効化したい。いずれも設定は Electron の localStorage に保存され `.env` では制御できないため、GUI での手動設定は受け入れられず、dotfiles の apply への組み込みが必要。

さらに、リポジトリ名 dotfiles を音声で話すと「. files」「.files」と記号+英語で文字起こしされ、話した通りの表記にならない。文字起こし後にトリガー語を置換する OpenWhispr のスニペット機能で「dotfiles」へ置換したい。この置換も GUI での手動登録は受け入れられず、dotfiles の apply への組み込みが必要。

## 目的

apply の実行で、`managed-keys.data.yaml` に宣言した localStorage キー群が OpenWhispr に反映された状態にする。既定の宣言は次のとおりである。

- フィラーのみを除去するクリーンアッププロンプトの登録（`customPrompt.cleanup`）
- 会議検出通知の無効化（`notifyMeetingDetection=false`）
- 音声アシスタントの無効化（`useDictationAgent=false`）
- 「. files」「.files」と文字起こしされる発話を「dotfiles」へ置換するスニペットの登録（`snippets`）

## 要件・制約

- 対象OSは Linux と Windows。macOS は対象外
- 管理対象の storage キーと値は `managed-keys.data.yaml` を正本とする。各エントリは `key` と文字列の `value` を宣言し、`value` は空でなく NUL を含まないこと。複数行の値は block scalar で宣言する
- 宣言の YAML パースは `yaml` パッケージの直 import で行い、依存は Bun の auto-install で解決する。宣言はテスト内の YAML 文字列で表現する
- `Preferences` または `Local Storage` が存在するディレクトリを認識済みの userData とする
- 未認識の userData では、宣言とインストール済みアプリの識別を検証した後、`status=skipped code=OK` と宣言キー群の SHA-256 を返し、終了コード0 で終わる。英語の detail で OpenWhispr の起動・終了後に再実行するよう案内する。CLI はこの案内を色指定なしの stdout に表示し、stderr は空にする。エラー時の detail は stderr に表示する。hook lock の取得、harness の起動、shadow runtime の生成、登録・storage・既存ファイルへの書き込みは行わない
- 宣言の欠損・不正、アプリの未インストール・識別失敗は、userData の認識状態によらず `INVALID_INPUT` エラーとする。認識済みuserData での hook lock と入力検証の優先順位は維持する
- 認識済みの userData で OpenWhispr が起動中のときはフックは何も書き換えず明確なエラー（LOCKED）で終わり、起動状態を変更しない。owner は必要に応じてアプリを終了してから applyする
- 登録済みの内容が一致する場合は何も変更しない
- 変更するのは宣言に列挙した storage キーのみ。provider・model・認証情報・既存の `.env`・アプリの他のデータは変更しない
- 会議検出通知の無効化は、設定GUIの「会議の検出」トグルをオフにした状態と同等であること。通知オフに伴い会議の音声検出も停止することは許容する
- 音声アシスタントの無効化は、設定GUIの「音声アシスタントを有効にする」トグルをオフにした状態と同等であること。ディクテーションは文字起こしとクリーンアップのみで動作し、発話がコマンドとして解釈・実行されないこと
- 失敗時は適用前の状態へ復元する
- カスタムクリーンアッププロンプト（`managed-keys.data.yaml` の `customPrompt.cleanup`）内に、実際に修正してほしい入力と期待する出力の例を記載する
- スニペットの宣言は、トリガー `. files` と `.files` を replacement `dotfiles` へ置換する内容とする。トリガーの一致は OpenWhispr の単語境界ルール（前方・後方が空白・句読点・記号）に従い、`files` 単体などの部分一致は置換対象にしない
- `snippets` の正本は OpenWhispr 側の SQLite であり、localStorage に書いた宣言は SQLite が空のときだけ初回起動に取り込まれる。取り込み後は宣言の変更を再適用しても反映されない
- `managed-keys.data.yaml` は home へ展開しない（`.data.` 予約名による dist 限定のデータファイル）。この文書は展開対象外であること（`remap.data.md` の除外行）

## 受け入れ条件

- 認識済みの userData では、owner が OpenWhispr を終了してから apply を実行した後、OpenWhispr の書き起こしクリーンアップが宣言の `customPrompt.cleanup` 値で動作し、会議検出通知と音声アシスタントが無効化されている
- apply 後に OpenWhispr を起動すると、「. files」「.files」と文字起こしされる発話が「dotfiles」に置換されて出力される
- 未認識の userData では、検証に成功するとプロファイルの有無や既存ファイルを変えずに成功skipし、再実行に必要な案内を表示する
- worktree で `bun test` と `OPENWHISPR_E2E=1 bun test` が通る
- Linux・Windows の隔離実証により、実アプリ・実プロファイルに触れずに動作することを確認済みである
