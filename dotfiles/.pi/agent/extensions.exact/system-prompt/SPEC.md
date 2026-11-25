# system-prompt拡張spec

`SYSTEM_PROMPT.yaml` で pi のシステム指示文をカスタマイズし、通常のセッション履歴に記録する拡張の仕様。読者は利用者と実装・検証の担当者。

- run は、ユーザー入力などで処理が始まってから応答が完了するまでの単位。force run は他の拡張が送信用の全文を指定した run。それ以外を通常 run と呼ぶ。
- 正本テンプレートは `~/.agents/SYSTEM_PROMPT.yaml`（配布元は `dotfiles/.agents/SYSTEM_PROMPT.yaml`）。

## 振る舞い

| 条件・状態・入力 | 操作 | 結果 |
| --- | --- | --- |
| セッション開始 | 正本テンプレートを読み込む | 正本がなければ pi 標準の組み立てを使う。不正な YAML、スキーマ不正、必須セクションの欠落は警告し、正本全体を使わない |
| run 開始 / 正本あり | run 開始時の入力で各定義を展開し、pi の公開 API `systemPromptOptions` を通して組み立てに渡す | pi が変更されたセクションだけを通常の `role: system` メッセージとして記録する。削除は `null`、変更がなければ追記しない。通常 run ではこの内容を送信に使う |
| 正本の展開時に未定義変数を参照 | この run では正本全体を使わず警告する | pi 標準の組み立てを使う |
| force run | 通常の `system` 履歴を組み立てる | この拡張は他の拡張が指定した送信用の全文を置き換えない |

カスタムセクションの文面は各 run の開始時に決まる。セクションの順序と、セッションファイルへの書き込み時期は pi に従う。既存の履歴・会話やツール定義は書き換えない。他の拡張が追加したセクションのうち、正本が置き換えないものは保つ。`agent_instructions` は `agents` 拡張が所有し、正本では上書きしない。警告は UI が使える場合は UI、使えない場合は標準エラー出力に表示する。

## 正本テンプレートの DSL

- 必須セクションは `preamble`・`tools`・`rules`・`skills`・`cwd`・`project_context` の6つ。1つでも欠けると正本全体が無効になる（警告して pi 標準の組み立てを使う）。`docs` は任意の文字列で、数値・真偽値・null・配列・リスト定義はスキーマ不正になる。`addendum` は pi が `--append-system-prompt` から注入するため必須外で、正本で定義するとその文に固定される
- 構文は `{{VAR}}`（変数名は `[A-Za-z][A-Za-z0-9_]*`。ランタイム変数は慣習として大文字、リスト項目フィールドは `name`・`description`・`filePath`・`rule`・`path`・`content`）のみ。ループ・条件分岐はない。反復は `sections.<name>` を `each` 持ちオブジェクトにしたときだけ、拡張がランタイムデータへ `each` を適用する。リストセクションは `tools`・`rules`・`project_context`・`skills` の4名のみ（`pre`・`join`・`post`・`empty` は任意）
- 文字列は `{{VAR}}` を展開する。`preamble` はタグなし、その他は `<name>` タグで囲む。展開結果が空文字列の場合は、pi がセクションを保持できるよう空白1文字を本文に使う
- ランタイム変数は run開始時に凍結する: `CODING_AGENT`（pi固定）、`FILE_READ_TOOL`（`read` または `bash`。skillファイルを読める選択ツールがないときは未提供）、`SKILL_READ_PHRASE`（read なら `the read tool to load`、bash なら `bash to load`。pi の案内文の言い回し差異を吸収する）、`MODEL`・`PROVIDER`（run のコンテキストから取得できるときのみ）、`CWD`（run の cwd、バックスラッシュをスラッシュへ正規化）、`README_PATH`・`DOCS_PATH`・`EXAMPLES_PATH`（実行中pi の README・docs・examples のパス）
- 正本ファイルの `variables` と同名のランタイム変数があるときはランタイム値を優先する
- `docs` を定義するとその本文を使う。省略時は pi 標準の `<docs>` を省き、他拡張が定義した `docs` は保つ
- `tools` の項目は選択ツールの名前・説明、`rules` は組み立て済みのルール、`project_context` はコンテキストファイルのパス・内容、`skills` は可視スキルの名前・説明・パス。`skills` の各項目は XML エスケープする。`pre`・`post`・`join`・`empty` は任意。`join` は項目間と `pre`・本文・`post` の間に使う。`tools` の項目がなければ `empty` を本文に使う。`project_context` と `skills` のリストは対象がない場合はセクション自体を省く。`skills` はファイルを読める選択ツールがない場合もセクション自体を省く
