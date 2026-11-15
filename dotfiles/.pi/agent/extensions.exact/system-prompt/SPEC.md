# system-prompt拡張spec

pi がモデルへ送るsystem prompt の標準部分を、この拡張が保持する文面と組み立てから生成し、送信時に置き換える拡張の観測可能な振る舞いを定める。読者はこの spec だけを読んで内容を go/no-goするユーザーと、実装・検証の担当者。

- 用語: run は 1回のユーザー入力から応答完了までの処理単位。force run は、いずれかの拡張が run開始時に system prompt全文を指定したrun。それ以外を通常run と呼ぶ。標準部分は pi本体が生成するsystem prompt本文（固定文と tools・rules・docs・AGENTS・skills・cwd等のセクション）。標準部分の後ろに他拡張が付けた文は追記と呼ぶ。
- 正本テンプレート: `~/.agents/SYSTEM_PROMPT.yaml`（正本は `dotfiles/.agents/SYSTEM_PROMPT.yaml`）。標準部分の全必須セクションの文面を `{{VAR}}` テンプレートで定義する正本ファイル。スキーマと DSL仕様は下記「正本テンプレートの DSL」のとおり
- 基準版: この拡張が保持するpi標準生成の文面と組み立て。正本が存在しないか無効な場合に使う。有効な正本があるときは、その文面で標準部分を生成する

## 振る舞い

| 条件・状態・入力 | 操作 | 結果 |
| --- | --- | --- |
| 通常run / モデルリクエストの送信直前 | 先頭system message を拡張の組み立てへ置き換える | 送られるsystem prompt の標準部分が、有効な正本があれば正本文面、なければ基準版から生成される |
| 通常run / run中に有効ツールが増減 | 増減後の状態を次のリクエストへ反映する | tools・rules が増減後の内容になり、run開始時の状態に凍結されない |
| 通常run / AGENTS・skills・cwd・他拡張のセクション | run開始時点の内容を反映する | 各セクションが pi本体と同じ位置・形式で本文に載る |
| 通常run / 拡張が所有しないセクション（他拡張の追記セクション等） | pi が描画した内容をそのまま採用する | 他拡張の追記が失われない |
| force run / 全文が拡張の標準描画と前方一致 | 標準部分だけを拡張描画へ置換する | 追記部分はそのまま保持される |
| force run / 全文が拡張の標準描画と前方一致しない | 何もしない | 送信内容は拡張がない場合と同一になる |
| 常時 | ツール定義を扱わない | ツール宣言（名前・説明・引数）は拡張がない場合と同一になる |
| 常時 | セッション履歴を書き換えない | transcript の記録は pi標準どおり。拡張による置換は送信時にのみ現れる |
| モデルリクエストの送信時 / 対応するpayload形式 | 全context handler・force projection後に、この拡張の `before_provider_request` が受け取るpayloadからsystem指示本文を取得する | そのセッションの直近requestの本文として更新する。複数のsystem指示本文はpayload内の順序を保ち、空行1行で連結する。本文がない場合は空文字列を保持する |
| モデルリクエストの送信時 / 未対応または不正なpayload形式 | 直近requestの本文を取得不能として扱う | 以前の本文を保持せず、取得不能の状態へ更新する |
| 直近requestの本文を取得済み（空本文を含む） / `/view-system-prompt` を実行 | 保持している本文を `/tmp/<session_id>_system_prompt.md` へ書き出し、pi の `externalEditor` 設定に従って外部エディタで開く | ファイルの内容が、コマンド実行時点で保持している直近requestの本文になる。同じセッションでは同じファイルを上書きする |
| 初回送信前 / `/view-system-prompt` を実行 | まだ送信内容がないことを案内する | ファイルへの書き出しと外部エディタの起動を行わない |
| 直近requestの本文が取得不能 / `/view-system-prompt` を実行 | 本文を取得できないことを案内する | ファイルへの書き出しと外部エディタの起動を行わない |
| 閲覧用ファイルを外部エディタで編集 | 閲覧用ファイルだけを変更する | 保持している送信内容・以降の送信内容・設定・tools・transcript は変わらない |
| 拡張の文面・組み立て定義を編集 | 以降のリクエストへ反映する | 編集後の文面で生成される。pi本体の更新では拡張の文面は変わらない |
| セッション開始 / `~/.agents/SYSTEM_PROMPT.yaml` が存在 | 正本を読み込み、必須セクション（`preamble`・`tools`・`rules`・`skills`・`cwd`・`project_context`）の全定義を検証した上で、`sections` の定義を拡張の組み立てへ差し替える | 定義したセクションが正本文面になる。docs省略時は下記のとおり扱い、その他の無定義セクション（`addendum` 等）は基準版と同一のまま |
| 有効な正本で `docs` を省略 | 正本から標準部分を生成する | pi標準のdocs本文とタグを出力しない。他拡張が所有するセクションと追記は保持する |
| 有効な正本で `docs` に文字列を定義 | 正本から標準部分を生成する | `<docs>\n本文\n</docs>` を出力する。空文字列でも `<docs>\n\n</docs>` を出力する |
| 正本で YAML・スキーマ不正・必須セクション未定義、または未定義変数を参照 | 正本全体を無視する | 基準版のまま動作し、UI があるモードでは警告を表示する（UI がないモードでは stderr へ警告する） |
| 正本でセクションを定義 / run中に有効ツールが増減 | 定義セクションは正本文面を維持する | tools・rules の新鮮性ルールより正本を優先する |
| 正本に無いセクション名（`[a-z][a-z0-9_-]*`）を定義 | 新規セクションとして末尾へ追加する | `<name>\n本文\n</name>` 形式。既存セクションの順序・内容は変わらない |
| 正本でリストセクション（`tools`・`rules`・`project_context`・`skills`）を定義 / モデルリクエストの送信直前 | `each` テンプレートを run の対応データへ反復適用する。対応データは `tools` が有効ツール（`name`・`description`、生値、空なら `empty`）、`rules` が組み立て済みルール行（`rule`、生値）、`project_context` が context files（`path`・`content`、生値、空で脱落）、`skills` が可視skills（`name`・`description`・`filePath`、XMLエスケープ、空または readツール不在で脱落） | `pre`・`join`・`post`・`empty` は任意。`join` は項目間と `pre`/本文/`post` 間の双方に効く。未定義なら基準版と同一 |
| 正本で preamble を定義 | 冒頭文を正本文面へ置き換える | preamble は pi と同様にタグなしで出力される |

run開始後に skills の読み出しツールが read から bash へ切り替わる場合のみ、skillsセクションの案内文が run開始時の文言になる。

閲覧は `/view-system-prompt` の実行時に行う。`<session_id>` は閲覧対象の piセッションIDであり、閲覧用ファイルには本文だけを書き出す。

対応するチャットAPIは `openai-completions`・`mistral-conversations`・`openai-responses`・`azure-openai-responses`・`openai-codex-responses`・`anthropic-messages`・`bedrock-converse-stream`・`google-generative-ai`・`google-vertex`・`pi-messages`。同じpayload形式を使うカスタムAPIも取得できる。

## 正本テンプレートの DSL

- 必須セクションは `preamble`・`tools`・`rules`・`skills`・`cwd`・`project_context` の6つ。1つでも欠けると正本全体が無効になる（警告 + 基準版）。`docs` は任意の文字列で、数値・真偽値・null・配列・リスト定義はスキーマ不正になる。`addendum` は pi が `--append-system-prompt` から注入するため必須外で、正本で定義するとその文に固定される
- 構文は `{{VAR}}`（変数名は `[A-Za-z][A-Za-z0-9_]*`。ランタイム変数は慣習として大文字、リスト項目フィールドは `name`・`description`・`filePath`・`rule`・`path`・`content`）のみ。ループ・条件分岐はない。反復は `sections.<name>` を `each` 持ちオブジェクトにしたときだけ、拡張がランタイムデータへ `each` を適用する。リストセクションは `tools`・`rules`・`project_context`・`skills` の4名のみ（`pre`・`join`・`post`・`empty` は任意）
- `sections` の値が文字列なら `{{VAR}}` 置換のみ。preamble はタグなし、他は `<name>` タグで囲まれる
- ランタイム変数は run開始時に凍結する: `CODING_AGENT`（pi固定）、`FILE_READ_TOOL`（`read` または `bash`。skillファイルを読める選択ツールがないときは未提供）、`SKILL_READ_PHRASE`（read なら `the read tool to load`、bash なら `bash to load`。pi の案内文の言い回し差異を吸収する）、`MODEL`・`PROVIDER`（run のコンテキストから取得できるときのみ）、`CWD`（run の cwd、バックスラッシュをスラッシュへ正規化）、`README_PATH`・`DOCS_PATH`・`EXAMPLES_PATH`（実行中pi の README・docs・examples のパス）
- 正本ファイルの `variables` と同名のランタイム変数があるときはランタイム値を優先する
- 正本の既定文面（このリポジトリの `dotfiles/.agents/SYSTEM_PROMPT.yaml`）は基準版とは異なる独自文面であり、`docs` を定義しない
- 正本テンプレートの反映は送信時置換と同様に transcript を書き換えない
