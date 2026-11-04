# system-prompt拡張spec

pi がモデルへ送るsystem prompt の標準部分を、この拡張が保持する文面と組み立てから生成し、送信時に置き換える拡張の観測可能な振る舞いを定める。併せて、実行中pi の文書・サンプルのパスを環境変数へ公開する振る舞いを定める。読者はこの spec だけを読んで内容を go/no-goするユーザーと、実装・検証の担当者。

- 用語: run は 1回のユーザー入力から応答完了までの処理単位。force run は、いずれかの拡張が run開始時に system prompt全文を指定したrun。それ以外を通常run と呼ぶ。標準部分は pi本体が生成するsystem prompt本文（固定文と tools・rules・docs・AGENTS・skills・cwd等のセクション）。標準部分の後ろに他拡張が付けた文は追記と呼ぶ。
- 正本テンプレート: `~/.agents/SYSTEM_PROMPT.yaml`（正本は `dotfiles/.agents/SYSTEM_PROMPT.yaml`）。標準部分の全必須セクションの文面を `{{VAR}}` テンプレートで定義する正本ファイル。スキーマと DSL仕様は下記「正本テンプレートの DSL」のとおり
- 基準版: この拡張が保持するpi標準生成の文面と組み立て。正本が存在しないか無効な場合に使う。有効な正本があるときは、その文面で標準部分を生成する

## 文書資産の環境変数

この拡張がロードされるpi では、拡張の初期化時にホストSDK の公開APIから取得した絶対パスを、次のプロセス環境変数へ設定する。セッション開始や最初のrun を待たずに利用でき、正本テンプレートの有無・有効性、通常run・force run に左右されない。

| 環境変数 | 設定する値 |
| --- | --- |
| `PI_README_PATH` | ホストの `getReadmePath()` が返すREADMEファイルのパス |
| `PI_DOCS_PATH` | ホストの `getDocsPath()` が返すdocsディレクトリのパス |
| `PI_EXAMPLES_PATH` | ホストの `getExamplesPath()` が返すexamplesディレクトリのパス |

継承された同名の環境変数はホストAPIの値で上書きする。reload等で拡張を再初期化するたびに再設定する。`PI_PACKAGE_DIR` によるホストAPIの既存のパス解決を尊重する。

公開時には資産の存在・種別を検証せず、パスの不備を理由にpi の起動を失敗させない。資産を読む側が存在・種別を確認する。

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
| TUIモードでセッション開始（新規起動・復元） | 折りたたみインジケータ（実効system prompt の総文字数・行数の要約1行）をエディタ下端の widget（エディタとフッターの間。他拡張の上端widget とは別枠）に表示する | `📜 system prompt: <文字数> chars / <行数> lines / click to view` の形式で表示する。全文は自動表示されない。表示は閲覧のみ |
| TUIモード / インジケータ表示中 | ctrl+shift+p、`/system-prompt` コマンド、またはインジケータのクリックで展開する | 展開時点の実効system prompt全文（ctx.getSystemPrompt()）をスクロール可能なオーバーレイで開く。esc・q・Enter で閉じられ、閉じてもセッション継続に影響しない |
| UIなしモード（RPC・JSON・print）でセッション開始 | 何もしない | インジケータも全文表示も発生しない |
| 閲覧表示中・インジケータ表示中 | prompt・tools・transcript を変更しない | 表示は読み取りのみ。閲覧の開閉によって送信内容や履歴は変わらない |
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

インジケータの要約はセッション開始時のプロンプトから作る。全文閲覧のオーバーレイは展開の時点で実効プロンプトを読み直し、それ以降の変更は次の展開まで反映されない。クリックによる展開はマウスイベントを配信するfullscreenモードでのみ機能し、通常モードでは ctrl+shift+p と `/system-prompt` コマンドが常に利用できる。これらの表示は上記の送信時置換の経路と独立して動く。

## 正本テンプレートの DSL

- 必須セクションは `preamble`・`tools`・`rules`・`skills`・`cwd`・`project_context` の6つ。1つでも欠けると正本全体が無効になる（警告 + 基準版）。`docs` は任意の文字列で、数値・真偽値・null・配列・リスト定義はスキーマ不正になる。`addendum` は pi が `--append-system-prompt` から注入するため必須外で、正本で定義するとその文に固定される
- 構文は `{{VAR}}`（変数名は `[A-Za-z][A-Za-z0-9_]*`。ランタイム変数は慣習として大文字、リスト項目フィールドは `name`・`description`・`filePath`・`rule`・`path`・`content`）のみ。ループ・条件分岐はない。反復は `sections.<name>` を `each` 持ちオブジェクトにしたときだけ、拡張がランタイムデータへ `each` を適用する。リストセクションは `tools`・`rules`・`project_context`・`skills` の4名のみ（`pre`・`join`・`post`・`empty` は任意）
- `sections` の値が文字列なら `{{VAR}}` 置換のみ。preamble はタグなし、他は `<name>` タグで囲まれる
- ランタイム変数は run開始時に凍結する: `CODING_AGENT`（pi固定）、`FILE_READ_TOOL`（`read` または `bash`。skillファイルを読める選択ツールがないときは未提供）、`SKILL_READ_PHRASE`（read なら `the read tool to load`、bash なら `bash to load`。pi の案内文の言い回し差異を吸収する）、`MODEL`・`PROVIDER`（run のコンテキストから取得できるときのみ）、`CWD`（run の cwd、バックスラッシュをスラッシュへ正規化）、`README_PATH`・`DOCS_PATH`・`EXAMPLES_PATH`（実行中pi の README・docs・examples のパス）
- 正本ファイルの `variables` と同名のランタイム変数があるときはランタイム値を優先する
- 正本の既定文面（このリポジトリの `dotfiles/.agents/SYSTEM_PROMPT.yaml`）は基準版とは異なる独自文面であり、`docs` を定義しない
- 正本テンプレートの反映は送信時置換と同様に transcript を書き換えない。閲覧オーバーレイは pi本体の実効プロンプト（ctx.getSystemPrompt()）を開くため、正本の反映は含まない
