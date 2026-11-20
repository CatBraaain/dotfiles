# Custom CSS自動再適用 要件

この文書は、dotfiles が配布する VS Code 拡張 `custom-css-reapply`（Custom CSS and JS Loader のパッチ自動再適用）の要件を、利用者と開発者に向けて定める。

## 背景

Custom CSS and JS Loader は、`vscode_custom_css.imports` で指定したファイルの内容を workbench.html へ埋め込む形でカスタムCSS・JS を適用する。この仕組みには次の漏れがある。

- VS Code の更新が workbench.html を初期化し、埋め込みが消える
- 埋め込みには適用時点のファイル内容が焼き込まれるため、imports のファイルを更新して apply しても、再適用するまで古い内容が動き続ける

いずれも利用者には原因が見えず、更新済みの js が反映されない状態が繰り返された。

## 目的

VS Code の更新と imports ファイルの更新のどちらの後も、埋め込みカスタムJS・CSS が利用者の追加操作なしで最新の内容で有効になること。

## 要件・制約

- 再適用は Custom CSS and JS Loader が提供する Reload 処理の実行で行い、VS Code 本体ファイルへの独自のパッチ処理は作らない
- workbench.html の埋め込みが存在しない、または埋め込み内容が imports のファイル内容と一致しない場合、VS Code 起動時に Loader の Reload 処理を自動的に実行する
- 埋め込みが最新の場合、起動時に何もしない
- 再適用の有効化は、Loader の通知から利用者が再起動を選んだ時点で行う
- imports が未設定または解決できない場合、再適用処理は行わない
- Loader 拡張がインストールされていない環境では何もしない
- 対象は同 Loader を使う VS Code のインストール配置（Windows と Linux のデスクトップ版）である

## 受け入れ条件

- VS Code を更新して起動すると、パッチが自動的に再適用され、カスタムJSが有効になっている
- imports の js を更新して apply した後の最初の VS Code 起動で再適用処理が走り、通知から再起動すると新しい内容が有効になっている
- パッチが最新の状態で起動すると、再適用処理は走らない
