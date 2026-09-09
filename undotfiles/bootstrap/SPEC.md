# Bootstrap spec

`undotfiles/bootstrap/bootstrap.ts` の観測可能な振る舞いの仕様。対象は、BunでCLIを実行するときの、`undotfiles/bootstrap/config.yaml` に書かれた環境構成から、ホストのグローバルパッケージと指定コマンドの実行結果への同期である。読者は、このspecだけを読んで要件を承認するオーナーと、実装・テストの担当者。

- 対応プラットフォーム: Linux。
- 実行形式: `bun undotfiles/bootstrap/bootstrap.ts <sync|diff>`。引数は`sync`または`diff`の1つだけを受け付ける。
- 引数の省略または追加、`sync`・`diff`以外の引数は、使用法を出力して終了コード0以外で終了する。
- `just install` は `sync` を実行する入口とする。`setup.sh`はBootstrapの外部呼び出し元であり、このspecの対象外とする。
- パッケージ値はバージョン指定を含められる。Install / Ensure Phaseでは導入済みかどうかにかかわらず、各パッケージ値をバックエンドのinstall操作へ渡す。バージョン指定がない値の最新化と、指定がある値への同期はバックエンドに委譲する。
- `sync` と `diff` は、状態取得、パッケージ操作、Custom Handler、`run`の失敗を記録して後続処理を続ける。すべての処理後、失敗が1件以上あれば終了コード0以外で終了する。

## 設定

設定ファイルは`bootstrap.ts`と同じディレクトリにある`config.yaml`である。トップレベルは配列で、各要素はキーが1つだけのマップとし、その値は1つの文字列とする。配列の順序はInstall / Ensure Phaseの実行順序を表す。

| キー | 値 | 管理方式 |
| --- | --- | --- |
| `apt` | Debianパッケージ指定 | 最新化保証 |
| `deb-get` | deb-getパッケージ名 | 最新化保証 |
| `uv` | Pythonパッケージ指定 | 宣言的 |
| `bun` | npmパッケージ指定 | 宣言的 |
| `go` | Go toolのパッケージパス | 宣言的 |
| `brew` | Homebrew Formula名 | 宣言的 |
| `brew-cask` | Homebrew Cask名 | 宣言的 |
| `custom` | Custom Handler名 | Handlerによる存在保証 |
| `run` | シェルコマンド | 毎回実行 |

設定の例:

    - apt: build-essential
    - uv: ruff
    - bun: prettier
    - go: golang.org/x/tools/gopls
    - brew: jq
    - brew-cask: visual-studio-code
    - deb-get: code
    - custom: docker
    - run: "git config --global init.defaultBranch main"

パッケージキーの値は、対応するバックエンドが受け付けるパッケージ指定として扱う。各Managerは、その指定からバックエンドが導入対象として識別するパッケージ識別子を解決する。バージョン指定はこの識別子を変えず、導入するバージョンだけを指定する。

設定ファイルが存在しない、YAMLとして読めない、トップレベルが配列ではない、要素が単一キーのマップではない、値が文字列ではない、またはキーが表にない設定は無効である。`sync` と `diff` は設定エラーを出力して異常終了し、パッケージ操作と`run`の実行を行わない。

## Desired State

`uv`、`bun`、`go`、`brew`、`brew-cask`の値から得られるパッケージ識別子の集合を、それぞれのDeclarative ManagerのDesired Stateとする。各Managerは、現在のグローバル状態とこのDesired Stateとの差分を管理する。`brew`の現在状態は`brew leaves`で取得し、他のFormulaの依存先であるFormulaを削除対象に含めない。`go`の現在状態は`gup list --json`で取得する。Managerの状態取得に失敗したときは、そのManagerのUninstall Phaseの削除を行わず、失敗として記録する。

`apt`と`deb-get`はDesired Stateにないパッケージを削除しない。`custom`と`run`はパッケージのDesired Stateを持たない。Custom Handlerの個別の目的状態は、この共通契約の対象外とする。`drawio`と`android-sdk`は目的状態を保証する。

## sync

`sync` は、Install / Ensure Phase、状態取得、Uninstall Phaseの順で環境を同期する。

### 1. Install / Ensure Phase

設定配列を先頭から末尾へ1要素ずつ処理する。同じ種類のキーが離れて配置されても、その位置で処理する。各項目の処理は、対応するパッケージマネージャーやコマンドが導入済みかどうかにかかわらず実行する。

| キー | 振る舞い |
| --- | --- |
| `apt` | 指定されたパッケージのinstall操作を実行する。 |
| `deb-get` | 指定されたパッケージのinstall操作を実行する。初回の`deb-get`項目の処理時に`deb-get version`が成功しなければ、`sudo apt install -y curl lsb-release wget jq`を実行し、公式スクリプトを`curl -fsSL https://raw.githubusercontent.com/wimpysworld/deb-get/main/deb-get | sudo -E bash -s install deb-get`で実行してからパッケージを導入する。 |
| `uv` | 指定されたPythonパッケージのグローバルinstall操作を実行する。 |
| `bun` | 指定されたnpmパッケージのグローバルinstall操作を実行する。 |
| `go` | 指定されたGo toolに対して`go install <パス>@<バージョン>`を実行する。バージョン指定がない値は`@latest`を使う。 |
| `brew` | 指定されたFormulaのinstall操作を実行する。 |
| `brew-cask` | 指定されたCaskのinstall操作を実行する。 |
| `custom` | 名前に対応するCustom Handlerを呼び出し、Handlerが定義する目的状態を保証する。名前に対応するHandlerがなければ失敗として記録する。 |
| `run` | 指定されたコマンドを`bash -c`で実行する。同期ごとに必ず実行する。 |

### 2. State Read

各Declarative Managerの現在状態を取得する。状態取得に失敗したManagerは、そのManagerのUninstall Phaseを行わず、失敗として記録する。

### 3. Uninstall Phase

各Declarative Managerで、現在のグローバル状態にあり、そのManagerのDesired Stateにない項目を削除する。

| Manager | 削除対象 | 削除の単位 |
| --- | --- | --- |
| uv | Desired StateにないPythonパッケージ | uvごとにまとめて処理 |
| bun | Desired Stateにないグローバルnpmパッケージ | bunごとにまとめて処理 |
| go | Desired StateにないGo tool | gupごとにまとめて処理 |
| brew | Desired StateにないFormula | Formula群として処理 |
| brew-cask | Desired StateにないCask | Cask群として処理 |

Uninstall Phaseは、設定ファイル内の要素順序に従わない。Managerはキー名のアルファベット順、`brew-cask`、`brew`、`bun`、`go`、`uv`で処理する。`apt`、`deb-get`、`custom`、`run`はこのフェーズで処理しない。

## diff

`diff` はホストを変更しない。Declarative Managerでは、現在のグローバル状態とDesired Stateの差を、Uninstall Phaseと同じManager名のアルファベット順で削除予定として表示する。状態取得に失敗したManagerの差分は表示しない。次に、Install / Ensure Phaseの予定を設定配列の順序で1要素ずつ表示する。状態取得に失敗したManagerのパッケージ項目は、この予定にも含めない。その他のパッケージ項目は、導入済みかどうかにかかわらずinstall / update予定として表示する。`custom`と`run`は配列上の位置で、同期時に呼び出すHandlerまたは実行するコマンドとして表示する。未知のCustom Handlerもその位置で表示して失敗を記録する。状態取得の失敗は記録し、他の項目の表示を続ける。

差分の有無にかかわらず、失敗がなければ`diff`は終了コード0で終了する。設定エラーは処理せずに異常終了する。
