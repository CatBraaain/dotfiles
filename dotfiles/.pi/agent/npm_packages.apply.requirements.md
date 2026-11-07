# npm_packages requirements

pi agent の npm packages の宣言と `~/.pi/agent/npm/` への実インストールの整合を、`just apply` で自動的に保つことを目的とする。対象は apply フック `npm_packages.apply.ts` と、dotfiles の保守担当者向けの要件である。

## 背景

pi は `pi install npm:<名前>` で `~/.pi/agent/npm/` へパッケージをインストールし、宣言を `settings.json` の `packages` に書き込む。宣言を `pi remove` を経由せずに外したとき、インストール済みの依存と lockfile が `~/.pi/agent/npm/` に残留する。hook はこの残留を解消する。

## 要件

- apply ライフサイクルで `~/.pi/agent/` を current directory として実行する
- `settings.json` の `packages` に宣言された `npm:` パッケージのみを `~/.pi/agent/npm/` に残す
- 宣言に対応しない依存は pi 本体と同じ uninstall コマンドで除去する
- packages に宣言されていて未インストールのパッケージのインストールは pi 本体が次回起動時に行う。hook は uninstall のみを行う
- 宣言が読めないとき（`settings.json` または `npm/package.json` が不正な JSON）は依存を消さず、非0 で終了する

## 受け入れ条件

- `just apply` の後、`~/.pi/agent/npm/package.json` の依存が `settings.json` の `packages` の `npm:` 宣言と一致する
- 宣言が読めない場合、`~/.pi/agent/npm/` は更新されず、apply が非0 で終了する
