# OpenWhispr自動設定登録 要件

## 背景

音声入力のクリーンアップが要約や言い換えを伴い、話者の強調や言い直しが失われる。クリーンアップ結果は別のコーディングエージェントのインプットになるため、情報の欠落が最も大きなリスクである。OpenWhispr のGUIからの手動登録は受け入れられず、dotfiles の apply への組み込みが必要。

また会議検出通知は、会話中に意図しないタイミングで割り込むため無効化したい。音声アシスタントは発話中の呼びかけをコマンドとして実行し、文字起こし以外の応答を貼り付けるため無効化したい。いずれも設定は Electron の localStorage に保存され `.env` では制御できないため、GUI での手動設定は受け入れられず、dotfiles の apply への組み込みが必要。

さらに、リポジトリ名 dotfiles を音声で話すと「. files」「.files」と記号+英語で文字起こしされ、話した通りの表記にならない。文字起こし後にトリガー語を置換する OpenWhispr のスニペット機能で「dotfiles」へ置換したい。この置換も GUI での手動登録は受け入れられず、dotfiles の apply への組み込みが必要。

固有名詞が音声入力で誤認識されるたびに、同じ正規表記への補正を繰り返している。正規表記を OpenWhispr の個人辞書へ一括登録し、認識ヒントとして使いたい。GUI での個別登録ではなく、dotfiles の宣言で管理する必要がある。

## 目的

apply の実行で、`managed-keys.data.yaml` に宣言した localStorage キー群を OpenWhispr に反映し、辞書の宣言語を SQLite の個人辞書へ差分追加した状態にする。既定の宣言は次のとおりである。

- フィラーのみを除去するクリーンアッププロンプトの登録（`customPrompt.cleanup`）
- 会議検出通知の無効化（`notifyMeetingDetection=false`）
- 音声アシスタントの無効化（`useDictationAgent=false`）
- 「. files」「.files」と文字起こしされる発話を「dotfiles」へ置換するスニペットの登録（`snippets`）
- 正規表記89語の個人辞書への登録（`dictionary`）。辞書は認識ヒントであり、宣言語どおりの認識を保証するものではない

## 要件・制約

- 対象OSは Linux と Windows。macOS は対象外
- 管理対象の storage キーと値は `managed-keys.data.yaml` の `keys` 配列を正本とする。各エントリは `key` と文字列の `value` を宣言し、`value` は空でなく NUL を含まないこと。複数行の値は block scalar で宣言する
- 個人辞書の追加語は、同じファイルで `keys` と並ぶ `dictionary` 配列を正本とする。各要素は NUL を含まない文字列とし、初期宣言は全89語の正規表記を保持する。登録時は前後の空白を除き、空文字は登録対象から除外する。大文字小文字を無視して重複する宣言語は、先頭の表記を使う。`dictionary` 省略時は個人辞書を変更しない。登録対象の辞書追加語がない場合はDBへアクセスせず、既存の storage キーのみを処理する
- 宣言の YAML パースは `yaml` パッケージの直 import で行い、依存は Bun の auto-install で解決する。宣言はテスト内の YAML 文字列で表現する
- `Preferences` または `Local Storage` が存在するディレクトリを認識済みの userData とする
- 未認識の userData では、宣言とインストール済みアプリの識別を検証した後、`status=skipped code=OK` と宣言の SHA-256 を返し、終了コード0 で終わる。英語の detail で OpenWhispr の起動・終了後に再実行するよう案内する。CLI はこの案内を色指定なしの stdout に表示し、stderr は空にする。エラー時の detail は stderr に表示する。hook lock の取得、harness の起動、shadow runtime の生成、登録・storage・SQLite・既存ファイルへの書き込みは行わない
- 宣言の欠損・不正、アプリの未インストール・識別失敗は、userData の認識状態によらず `INVALID_INPUT` エラーとする。認識済みuserData での hook lock と入力検証の優先順位は維持する
- 認識済みの userData で OpenWhispr が起動中のときはフックは何も書き換えず明確なエラー（LOCKED）で終わり、起動状態を変更しない。owner は必要に応じてアプリを終了してから applyする
- 宣言した storage キーの値がすべて一致し、辞書DBの移行が不要で、辞書の宣言語がすべて有効な語として登録済みなら、何も変更せず `status=unchanged code=OK` を返す。辞書語の不足だけを追加した場合も `status=applied code=OK` を返す。宣言の検証後に返す `keys_sha256` は、storage キー群・辞書の両宣言を含む SHA-256 とする
- 変更するのは宣言に列挙した storage キーと、個人辞書に不足する宣言語の差分追加とする。ただし、アプリ既存のDB移行に伴う辞書以外のDB更新は許容する。provider・model・認証情報・既存の `.env` と、移行に伴わない他のデータは変更しない
- 個人辞書の同一語は、前後の空白を除き、大文字小文字を無視して判定する。差分登録では、既存の有効な同一語は表記・学習由来などの属性・共有状態を保持し、宣言されていない既存語も保持する。再実行で同一語を重複登録しない
- 認識済みの userData で登録対象の辞書追加語があり、辞書登録にDB移行が必要なときは、インストール済みアプリの既存DB移行処理を利用する。独自の移行SQLは追加しない。移行前のDB全体をWAL内の確定済みデータも含めて保持し、移行・登録・検証が成功した場合だけ移行後のDBを反映して `status=applied code=OK` を返す。DBの反映では既存ファイルを置き換えず、所有者・権限・ACLを保持する。移行済みDBでは全DB移行を実行しない
- 辞書DBが存在しない、既存の辞書テーブルがない、必要なアプリ機能が利用できない、または移行・登録・検証が失敗したときは `APPLY_FAILED` エラーで終わり、detail に原因を示す。DBの新規初期化は行わない
- 会議検出通知の無効化は、設定GUIの「会議の検出」トグルをオフにした状態と同等であること。通知オフに伴い会議の音声検出も停止することは許容する
- 音声アシスタントの無効化は、設定GUIの「音声アシスタントを有効にする」トグルをオフにした状態と同等であること。ディクテーションは文字起こしとクリーンアップのみで動作し、発話がコマンドとして解釈・実行されないこと
- 捕捉できる移行・登録・検証失敗時は、今回変更した storage キーと SQLite 個人辞書を適用前の状態へ復元する。DB移行時は、辞書以外も含むDB全体を適用前の状態に保つ
- カスタムクリーンアッププロンプト（`managed-keys.data.yaml` の `customPrompt.cleanup`）内に、実際に修正してほしい入力と期待する出力の例を記載する
- スニペットの宣言は、トリガー `. files` と `.files` を replacement `dotfiles` へ置換する内容とする。トリガーの一致は OpenWhispr の単語境界ルール（前方・後方が空白・句読点・記号）に従い、`files` 単体などの部分一致は置換対象にしない
- `snippets` の正本は OpenWhispr 側の SQLite であり、localStorage に書いた宣言は SQLite が空のときだけ初回起動に取り込まれる。取り込み後は宣言の変更を再適用しても反映されない
- `managed-keys.data.yaml` は home へ展開しない（`.data.` 予約名による dist 限定のデータファイル）。この文書は展開対象外であること（`remap.data.md` の除外行）

## 受け入れ条件

- 認識済みの userData では、owner が OpenWhispr を終了してから apply を実行した後、OpenWhispr の書き起こしクリーンアップが宣言の `customPrompt.cleanup` 値で動作し、会議検出通知と音声アシスタントが無効化されている
- apply 後に OpenWhispr を起動すると、「. files」「.files」と文字起こしされる発話が「dotfiles」に置換されて出力される
- 未認識の userData では、検証に成功するとプロファイルの有無や既存ファイルを変えずに成功skipし、再実行に必要な案内を表示する
- 個人辞書には不足する宣言語だけが正規表記で追加され、アプリ既存の移行に伴う更新を除き、既存語の表記・属性・共有状態と宣言されていない語が保持される。再実行しても重複せず、storage と辞書の両方が宣言を満たすと `unchanged` になる
- 辞書だけが不足する状態からも追加が行われ、`applied` になる。捕捉できる登録・検証失敗では、変更した storage と個人辞書が適用前の状態へ戻る
- アプリ既存のDB移行を経て辞書登録できる。移行途中・登録・検証の失敗ではDB全体と storage が適用前の状態を保ち、再実行は冪等である
- worktree の `dotfiles/open-whispr/` で `bun run manage-config.data.test.ts` が通る。実アプリを使う隔離検証は `OPENWHISPR_E2E=1 bun run manage-config.data.test.ts` で実行する
- Linux・Windows の隔離環境で、実アプリ・実プロファイルに触れずに動作する
