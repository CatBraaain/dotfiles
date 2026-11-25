# vscode-custom-patch 要件

この文書は、dotfiles が配布するデスクトップ版 VS Code 拡張 `vscode-custom-patch` と同梱 CLI の要件を、利用者と開発者に向けて定める。

## 目的

Explorer で入口ファイルを見つけやすくする。擬似的なファイルネストに頼らず、各フォルダで対象のファイルだけを優先表示する。Agent Kit による SCM のリポジトリ自動選択も使える状態に保つ。

## 同梱パッチ

- `sort-explorer` は、同じフォルダの一覧に表示される `index.ts`、`index.md`、`index.mdx` を他のファイルより先に並べる。既定の並び順ではフォルダが先で、優先ファイル同士とその他のファイルは、それぞれ従来の順序を保つ。フォルダとファイルを混在させる `mixed` は標準の順序を使う。
- 優先表示のために対象の `index.*` に他のファイルをネストしない。ほかの `explorer.fileNesting.patterns` は従来どおり適用する。
- SCM ブリッジは、Agent Kit が SCM に表示するリポジトリの選択を可能にする。
- 以前の HTML 注入がある場合は、バックアップから元の HTML を復元する。各同梱パッチは、対応する VS Code の処理を特定できた場合だけ適用する。

## 構成

| 要素 | 役割 |
| --- | --- |
| `src/` | 拡張とパッチエンジンのソース |
| `bun run build` | VSIX、CLI、Linux 向けの適用スクリプトを組み立てる。プロジェクト内の `dist/` が既定の出力先 |
| `vscode-custom-patch.build.ts` | 成果物をキャッシュから復元するか `build` を実行し、dotfiles 側の `dist/` に配置する |
| `vscode-custom-patch.apply.ts` | `DOTFILES_DIST_DIR` の VSIX を同期し、Linux では `inject`、Windows では同梱 CLI を呼ぶ |
| `vscode-custom-patch/cli.js` | パッチを適用・解除する CLI。同梱パッチを既定とし、引数で HTML 注入用の別フォルダも指定できる |

## 要件・制約

- 注入は Custom CSS and JS Loader 拡張に依存しない
- エンジンは `plugins/` 内の `.js` と `.css` をファイル名順に連結し、`.js` は `<script>`、`.css` は `<style>` として埋め込む
- apply フックは他の拡張の同期とは独立して動く。対象ごとに VSIX のインストールに成功したか、インストールが不要と確認できたときだけ注入する
- Windows では VSIX の同期に使った `code` が指すインストールにだけ注入する。場所が特定できない場合は理由を出し、起動時の再適用に任せる
- 拡張は起動時に同梱パッチの適用状態を確認し、変更した場合は通知で再起動を促す
- CLI の `remove` は同梱パッチを解除する。`remove` または空・不在のフォルダを明示した `ensure` は、HTML 注入もバックアップから復元する
- バックアップがない場合は剥がさず、警告を出して維持する
- 書き込みできない場合、apply フックは理由を出して注入を見送る。次回起動時の再適用は拡張が試みる。CLI を単独で実行した場合は失敗を返す
- plugins のファイルが読めない場合はエラーにする。不完全な焼き込みで古い内容が動き続けるのを防ぐためである
- パッチの形式（マーカー、セッションID、CSP meta の除去、バックアップ `workbench.<セッションID>.bak-custom-css`）は、過去の Loader 由来のパッチと互換に保つ
- 旧ホームフォルダ `vscode-custom-patch-plugins/` は自動で参照・削除しない
- ビルド入力が同じならキャッシュから成果物を復元する。VSIX は未インストール、または前回成功時とパッケージ内容が異なる場合にインストールする。同一バージョンでも内容が異なれば更新する
- 対象は VS Code のデスクトップ版のインストール配置（Windows と Linux）である

## 受け入れ条件

- Linux デスクトップ版と Windows 版は、それぞれの OS の apply で適用できた場合、最初の起動またはリロードで同梱パッチが有効になり、パッチによる再リロード通知が出ない
- WSL の apply は Windows 版に対して VSIX の同期も注入も実行しない
- VS Code を更新して起動すると、通知の再起動によりパッチが復活する
- 変更なしの apply は再ビルド・再インストールなしで完了する。インストールに失敗した更新は次回再試行する
- `node vscode-custom-patch/cli.js remove` で、現在の workbench からパッチが外れる
- パッチが fresh な状態では、起動時も apply 時も何も起きない
