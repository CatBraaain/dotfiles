# vscode-custom-patch 要件

この文書は、dotfiles が配布する VS Code 拡張 `vscode-custom-patch`（workbench.html へのカスタムスクリプト注入の保証）と同梱 CLI の要件を、利用者と開発者に向けて定める。

## 背景

ソース管理ビューの自動折りたたみ（`scm-collapse`）のようなカスタムスクリプトを workbench で動かすには、スクリプト内容を workbench.html へ埋め込む必要がある。VS Code の更新が html を初期化するため、埋め込みは消え、適用し直しが繰り返されていた。以前は Custom CSS and JS Loader 拡張と settings の `vscode_custom_css.imports` で管理していたが、依存をやめ、plugins folder を唯一の供給源とする仕組みに置き換えた。

## 目的

カスタムスクリプトの workbench.html への注入を、apply の完了時と VS Code の起動時に保証すること。plugins folder の内容で有効・無効を動的に切り替えられること。

## 構成

| 要素 | 役割 |
| --- | --- |
| `vscode-custom-patch-plugins/` | 注入するスクリプトと CLI の配置場所。home に展開され、中身が有効・無効の唯一の状態 |
| `vscode-custom-patch-plugins/<name>/` | plugin のソース（`src/entry.ts`）。build hook が `<name>.js` にバンドルした後、dist から除去される |
| `vscode-custom-patch-plugins/build-plugins.build.ts` | plugins 内の全 plugin folder をバンドルする build hook |
| `vscode-custom-patch-plugins/ensure-patch.apply.ts` | apply hook。適用後にこの folder でエンジンを実行する |
| `vscode-custom-patch/cli.js` | 外部実行可能なエンジン入口。既定の plugins folder は隣接する `vscode-custom-patch-plugins` |
| 拡張本体（VSIX） | 起動のたびに注入を保証する |
| `patch.data.ts` | エンジン。CLI・拡張・apply hook で共有する |

## 要件・制約

- 注入は Custom CSS and JS Loader 拡張に依存しない
- エンジンは `plugins/` 内の `.js` と `.css` をファイル名順に連結し、`.js` は `<script>`、`.css` は `<style>` として埋め込む
- apply hook は適用の後の applyライフサイクルでエンジンを実行し、注入を保証する
- 拡張は起動のたびにエンジンを実行し、埋め込みが plugins と一致しない場合は焼き込み直し、通知の再起動で有効化する
- plugins folder が空・不在の場合、または CLI の remove が実行された場合は、バックアップから元 html を復元してパッチを剥がす
- バックアップがない場合は剥がさず、警告を出して維持する
- 書き込みできない場合は処理を諦めて警告を出す。CLI と apply hook は正常終了し、拡張は異常終了しない
- plugins のファイルが読めない場合はエラーにする。不完全な焼き込みで古い内容が動き続けるのを防ぐためである
- パッチの形式（マーカー、セッションID、CSP meta の除去、バックアップ `workbench.<セッションID>.bak-custom-css`）は、過去の Loader 由来のパッチと互換に保つ
- 拡張が plugins folder を探す位置は、ユーザー設定ディレクトリ直下の `vscode-custom-patch-plugins` である
- apply hook は同じ位置に展開された plugins folder を対象にする。両者は `vscode/` 配下で隣接するため、展開後も隣接が保たれる
- 対象は VS Code のデスクトップ版のインストール配置（Windows と Linux）である

## 受け入れ条件

- `just apply` 後の最初の VS Code 起動で、通知なしに plugins の内容が有効になっている
- VS Code を更新して起動すると、通知の再起動によりパッチが復活する
- plugins から削除して apply した後の最初の起動で、そのスクリプトが無効になっている
- `vscode-custom-patch/cli.js remove` の実行と再起動により、パッチが外れる
- パッチが fresh な状態では、起動時も apply 時も何も起きない
