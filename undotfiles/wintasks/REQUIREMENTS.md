# wintasks REQUIREMENTS

この文書は、Windows のスケジュールタスクを YAML で宣言的に管理する wintasks CLI の要件を、この構成を利用・保守する user と開発者に向けて、解決する課題と期待する成果を定める。

## 課題

Windows のスケジュールタスクを YAML の desired state として同期する構成が、環境構築設定を一元管理する dotfiles リポジトリの中に存在しない。

## 目的

Windows のスケジュールタスクを YAML の desired state として宣言し、dotfiles リポジトリ内で完結する軽量な構成で Task Scheduler に同期できるようにする。

## 期待する成果

- cron / startup / boot / once / now のトリガーを YAML で宣言できる。cron 式は Task Scheduler のトリガー表現へ自動変換される
- `just wintasks` の実行で、mount folder 配下のタスクが YAML の定義に一致する。差分があるタスクだけが登録・更新・削除され、差分がないタスクは更新されない
- タスク定義は `wintasks.yaml` に書き、その形式を `wintasks.schema.json` で定める
- CLI オプション、タスクパス規則、XML 生成、diff 表示、エラー・終了コードを備える

## 制約

- TypeScript で実装し、ランタイムは bun を使う。構成は `undotfiles/wintasks/` に置く
- 公開はしない。個人利用の構成として管理する
- CLI は管理者権限へ自動昇格しない
