# vscode-custom-patch 要件

この文書は、dotfiles が配布する VS Code 拡張 `vscode-custom-patch`（workbench.html へのカスタムスクリプト注入の保証）と同梱 CLI の要件を、利用者と開発者に向けて定める。

## 背景

ソース管理ビューの自動折りたたみ（`scm-collapse`）のようなカスタムスクリプトを workbench で動かすには、スクリプト内容を workbench.html へ埋め込む必要がある。VS Code の更新が html を初期化するため、埋め込みは消え、適用し直しが繰り返されていた。以前は Custom CSS and JS Loader 拡張と settings の `vscode_custom_css.imports` で管理していた。

## 目的

同梱する `scm-collapse` を VS Code の workbench.html に注入する。Linux 側は apply 時と起動時、WSL から同期する Windows 側は起動時に注入する。内容を変えずに apply したときは、パッケージの再ビルドと拡張の再インストールを省く。

## 構成

| 要素 | 役割 |
| --- | --- |
| `src/` | 拡張とパッチエンジンのソース |
| `plugins/scm-collapse/` | 同梱するプラグインのソース |
| `bun run build` | 同じプラグイン成果物から VSIX、CLI、注入用の JS を組み立てる。プロジェクト内の `dist/` が既定の出力先 |
| `vscode-custom-patch.build.ts` | 成果物をキャッシュから復元するか `build` を実行し、dotfiles 側の `dist/` に配置する |
| `vscode-custom-patch.apply.ts` | ホーム側で実行する専用フック。`DOTFILES_DIST_DIR` から VSIX と注入用 JS を参照し、Linux 側では `inject` を呼ぶ |
| `vscode-custom-patch/cli.js` | 手動で注入・解除する CLI。同梱スクリプトを既定とし、引数で別フォルダも指定できる |

## 要件・制約

- 注入は Custom CSS and JS Loader 拡張に依存しない
- エンジンは `plugins/` 内の `.js` と `.css` をファイル名順に連結し、`.js` は `<script>`、`.css` は `<style>` として埋め込む
- apply フックは他の拡張の同期とは独立して動く。Linux 側では VSIX の更新に成功したか更新が不要と確認できたときだけ注入する
- 拡張は起動時に埋め込みが同梱内容と異なれば更新し、通知で再起動を促す
- CLI の `remove`、または空・不在のフォルダを明示した `ensure` では、バックアップから元の HTML を復元する
- バックアップがない場合は剥がさず、警告を出して維持する
- 書き込みできない場合は処理を諦めて警告を出す。CLI と apply hook は正常終了し、拡張は異常終了しない
- plugins のファイルが読めない場合はエラーにする。不完全な焼き込みで古い内容が動き続けるのを防ぐためである
- パッチの形式（マーカー、セッションID、CSP meta の除去、バックアップ `workbench.<セッションID>.bak-custom-css`）は、過去の Loader 由来のパッチと互換に保つ
- 旧ホームフォルダ `vscode-custom-patch-plugins/` は自動で参照・削除しない
- ビルド入力が同じならキャッシュから成果物を復元する。VSIX は未インストール、または前回成功時とパッケージ内容が異なる場合にインストールする。同一バージョンでも内容が異なれば更新する
- 対象は VS Code のデスクトップ版のインストール配置（Windows と Linux）である

## 受け入れ条件

- Linux 側では、apply 後の最初の VS Code 起動で、通知なしに同梱スクリプトが有効になっている
- VS Code を更新して起動すると、通知の再起動によりパッチが復活する
- 変更なしの apply は再ビルド・再インストールなしで完了する。インストールに失敗した更新は次回再試行する
- `node vscode-custom-patch/cli.js remove` で、現在の workbench HTML からパッチが外れる
- パッチが fresh な状態では、起動時も apply 時も何も起きない
