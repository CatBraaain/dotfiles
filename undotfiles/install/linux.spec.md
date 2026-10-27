# Linux install spec

`undotfiles/install/linux.ts` の観測可能な振る舞いの仕様。対象は、BunでCLIを実行するときの、`undotfiles/install/linux.config.yaml` に書かれた環境構成から、ホストのグローバルパッケージと指定コマンドの実行結果への同期である。読者は、このspecだけを読んで要件を承認するユーザーと、実装・テストの担当者。

- 対応プラットフォーム: Linux。
- 実行形式: `bun undotfiles/install/linux.ts <sync|diff>`。引数は`sync`または`diff`の1つだけを受け付ける。
- 引数の省略または追加、`sync`・`diff`以外の引数は、使用法を出力して終了コード0以外で終了する。
- 実行には、リポジトリルートの`.env`に`INSTALL_PROFILE=personal|work`で宣言したマシン種別のマーキングを必須とする。`.env`が存在しない、`INSTALL_PROFILE`が未定義、値が`personal`・`work`以外のときは、マーキングエラーを出力して異常終了し、パッケージ操作と`run`の実行を行わない。マーキングの値は、`sync`と`diff`が適用する設定配列（`work`または`personal`）とPersonal-only Handler（後述）の振る舞いを決める。それ以外の項目では、マーキングの値は振る舞いを変えない。
- `sync` はパッケージ操作と`run`の実行の前に、`sudo -v` で認証する。認証に失敗したときは異常終了し、パッケージ操作と`run`の実行を行わない。以後のsudo呼び出しはsudoの通常の認証キャッシュを利用し、有効期限が切れた場合は再入力を求めることがある。
- `diff` はsudoを実行しない。
- `just install` は `sync` を実行する入口とする。`setup.sh`はBootstrapの外部呼び出し元であり、このspecの対象外とする。
- パッケージ値はバージョン指定を含められる。Install / Ensure Phaseでは、宣言的Managerの各パッケージ値を、導入済みかどうかにかかわらずバックエンドのinstall操作へ渡す。`apt`と`flatpak`は未導入のパッケージだけをinstallする。バージョン指定がない値の最新化と、指定がある値への同期は、対象Managerの管理方式に従いバックエンドに委譲する。
- `sync` と `diff` は、状態取得、パッケージ操作、Custom Handler、`run`の失敗を記録して後続処理を続ける。すべての処理後、失敗が1件以上あれば終了コード0以外で終了する。

## 設定

設定ファイルは`linux.ts`と同じディレクトリにある`linux.config.yaml`である。トップレベルは`work`と`personal`をキーとするマップで、`work`配列は全マシン共通のインストール対象、`personal`配列はpersonalプロファイルのマシンで`work`配列に追加するインストール対象とする。`sync`と`diff`は、workプロファイルでは`work`配列だけを、personalプロファイルでは`work`配列と`personal`配列をこの順で連結したものを対象にする。配列の各要素はキーが1つだけのマップとし、その値は1つの文字列とする。`apt`以外の項目では、連結後の配列の順序がInstall / Ensure Phaseの実行順序を表す。`apt`項目はこの順序によらず、Install / Ensure Phaseの先頭でまとめて処理する。

| キー | 値 | 管理方式 |
| --- | --- | --- |
| `apt` | Debianパッケージ指定 | 存在保証 |
| `flatpak` | FlatpakアプリID | 存在保証 |
| `uv` | Pythonパッケージ指定 | 宣言的 |
| `bun` | npmパッケージ指定 | 宣言的 |
| `cargo` | Rust binary crateのパッケージ指定 | 宣言的 |
| `go` | Go toolのパッケージパス | 宣言的 |
| `brew` | Homebrew Formula名 | 宣言的 |
| `brew-cask` | Homebrew Cask名 | 宣言的 |
| `custom` | Custom Handler名 | Handlerによる存在保証 |
| `run` | シェルコマンド | 毎回実行 |

設定の例:

    work:
      - apt: build-essential
      - uv: ruff
      - bun: prettier
      - run: "git config --global init.defaultBranch main"
    personal:
      - custom: blender

パッケージキーの値は、対応するバックエンドが受け付けるパッケージ指定として扱う。各Managerは、その指定からバックエンドが導入対象として識別するパッケージ識別子を解決する。バージョン指定はこの識別子を変えず、導入するバージョンだけを指定する。

設定ファイルが存在しない、YAMLとして読めない、トップレベルが`work`と`personal`をキーとするマップでない、トップレベルにその2キー以外のキーがある、`work`と`personal`の両方に要素がない、配列の要素が単一キーのマップではない、値が文字列ではない、またはキーが表にない設定は無効である。`sync` と `diff` は設定エラーを出力して異常終了し、パッケージ操作と`run`の実行を行わない。

## Personal-only Handler

`custom` Handlerのうち、linux.tsがPersonal-only Handlerとして定義している名前をPersonal-only Handlerとする。現在のPersonal-only Handlerは`blender`である。Personal-only Handlerはpersonalプロファイルのマシンでのみ目的状態を持つため、その名前を`work`配列に含めてはならない。

- `sync`では、workプロファイルの実行で`work`配列にPersonal-only Handlerの名前があるとき、その項目はHandlerを実行せず失敗として記録する。また、Uninstall Phaseの最後に、導入済みのPersonal-only Handlerの管理下パスの削除を実行する。
- `diff`では、workプロファイルの実行で`work`配列にPersonal-only Handlerの名前があるとき、その位置で失敗として記録する。また、表示の最後に、導入済みのPersonal-only Handlerを`remove custom: {name}`として表示し、未導入なら表示しない。
- personalプロファイルでは、Personal-only Handlerは通常の`custom` Handlerと同じ振る舞いをする。

## Desired State

`uv`、`bun`、`cargo`、`go`、`brew`、`brew-cask`の値から得られるパッケージ識別子の集合を、それぞれのDeclarative ManagerのDesired Stateとする。`cargo`のパッケージ指定はcrates.ioのcrate名または`crate@version`とし、Desired Stateのパッケージ識別子は`@version`より前のcrate名とする。各Managerは、現在のグローバル状態とこのDesired Stateとの差分を管理する。`brew`の現在状態は`brew leaves`で取得し、他のFormulaの依存先であるFormulaを削除対象に含めない。`cargo`の現在状態は`cargo install --list`で取得する。`go`の現在状態は`gup list --json`で取得する。Managerの状態取得に失敗したときは、そのManagerのUninstall Phaseの削除を行わず、失敗として記録する。

`apt`と`flatpak`はDesired Stateにないパッケージを削除しない。`custom`と`run`はパッケージのDesired Stateを持たない。Custom Handlerの個別の目的状態は、この共通契約の対象外とする。`drawio`、`android-sdk`、`blender`、`musescore`、`openwhispr`、`rustdesk`、`surge-xt`、`generaluser-gs`は目的状態を保証する。

`blender`の目的状態は、download.blender.orgの最新安定版releaseのlinux-x64 tarballを`/opt/blender-{version}-linux-x64`（`{version}`は`数字.数字.数字`）へ展開し、`/usr/local/bin/blender`がその中の`blender`実行ファイルへのsymlinkであることとする。同じrelease versionが既に`/opt`に展開済みなら再取得せず、symlinkが目的と異なるときだけ張り直す。workプロファイルでの削除対象は、`/usr/local/bin/blender`のsymlink先が`/opt/blender-{version}-linux-x64/blender`に一致するときのsymlinkと、`/opt`直下で`blender-{version}-linux-x64`に一致するディレクトリであり、それ以外のblender関連パスは管理外として削除しない。releaseの一覧の取得に失敗した場合、またはx86_64以外のLinuxで実行した場合は失敗として記録する。

`openwhispr`の目的状態は、OpenWhisprのx86_64 Linux向け最新GitHub releaseに含まれる`.deb`を導入し、既に同じrelease versionが導入済みなら再導入しないこととする。releaseの取得に失敗した場合、またはx86_64以外のLinuxで実行した場合は失敗として記録する。

`rustdesk`の目的状態は、RustDeskのx86_64 Linux向け最新GitHub releaseに含まれる`.deb`（`rustdesk-{version}-x86_64.deb`）を導入し、既に同じrelease versionが導入済みなら再導入しないこととする。releaseの取得に失敗した場合、またはx86_64以外のLinuxで実行した場合は失敗として記録する。

`surge-xt`の目的状態は、Surge XTのx86_64 Linux向け最新GitHub release（`surge-synthesizer/releases-xt`）に含まれる`.deb`（`surge-xt-linux-x64-{version}.deb`）を導入し、既に同じrelease versionが導入済みなら再導入しないこととする。releaseの取得に失敗した場合、またはx86_64以外のLinuxで実行した場合は失敗として記録する。

`generaluser-gs`の目的状態は、`~/.local/share/soundfonts/GeneralUser-GS.sf2`が`mrbumpy409/GeneralUser-GS`の`main`ブランチの同名ファイルと同一内容（git blob hash一致）であることとする。既に同一内容なら再取得しない。ダウンロード後のblob hashが一致しない場合は失敗として記録する。

`musescore`は個人用の`personal`配列に置くCustom Handlerとする。目的状態は、公式GitHub release `musescore/MuseScore`の`v4.7.6`にある`MuseScore-Studio-4.7.6.261022093-x86_64.AppImage`をFUSE不要の方式で展開した内容が`/opt/musescore-4.7.6-x86_64/`にあり、`/usr/local/bin/musescore`が、その中の`AppRun`を絶対パスで呼び出して引数をそのまま渡す実行可能なwrapperであることとする。メニュー登録と既定のファイル関連付けは変更しない。wrapperの内容は次の2行と末尾の改行に完全一致するものとする。

```bash
#!/usr/bin/env bash
exec "/opt/musescore-4.7.6-x86_64/AppRun" "$@"
```

| 条件 | 結果 |
| --- | --- |
| x86_64以外のLinux | 失敗として記録し、取得・配置を行わない |
| 配置先が実ディレクトリで、その`AppRun`が実行可能なファイル。wrapperは存在しない | 固定版が導入済みと判定し、release照会・取得・展開を行わない |
| 目的の内容の通常ファイルwrapperと既存配置がある | 特権で配置を確認する。配置先はsymlinkでないディレクトリ、`AppRun`はsymlinkでない実行可能な通常ファイルであり、配置内の全エントリはroot:root所有で、全ディレクトリはgroup・otherから書き込み不可、エントリの種類はディレクトリ・通常ファイル・symlinkだけの場合に限り、権限を修復する。通常ファイルのgroup・other書き込み権限が残る配置は、配置先トップにgroup・other双方の通過権限がない場合だけ修復可能とし、既に通過可能な配置では拒否する。一般ユーザーから`AppRun`を確認できない配置もこの条件で判定し、取得・展開は行わない。条件を満たさなければ配置を維持して失敗として記録する |
| 配置先が存在しない | 固定名のAppImageと同releaseの`checksums.sha256.txt`を取得する。対象ファイル名に完全一致する1行の有効なSHA-256とAppImageのSHA-256が一致した場合だけ展開する。展開先の`AppRun`が実行可能なファイルであることを確認してから、完成したディレクトリを配置先へ公開する |
| 配置先がsymlink、または配置先が存在して導入済み・修復可能のどちらにも該当しない | 既存の配置先を維持し、失敗として記録する |
| wrapperが存在しない | 目的のwrapperを作成する |
| wrapperが目的の内容と一致する通常ファイルで、実行可能 | wrapperを変更しない |
| wrapperが目的の内容と一致する通常ファイルで、実行不可 | 内容を維持し、実行権限を修復する |
| wrapperのパスがsymlink、通常ファイル以外、または内容が目的と異なる | 管理外のパスとして維持し、取得・配置前に失敗として記録する |
| 取得・checksum照合・展開・配置に失敗 | 失敗として記録し、未完成の展開を導入済みと判定しない |

新規配置の公開時と既存配置の権限修復時には、配置内の全ディレクトリを全ユーザーから読み取り・通過可能にし、通常ファイルを全ユーザーから読み取り可能にする。既にいずれかの実行ビットがある通常ファイルは全ユーザーから実行可能にし、実行ビットのない通常ファイルには実行権限を追加しない。ディレクトリ・通常ファイルからgroup・otherの書き込み権限を除去する。symlinkをたどって権限を変更しない。新規配置は外部から通過できないstaging内で権限を完成させてから公開する。既存配置の修復では、トップのgroup・otherアクセスを制限し、配下の補正を完了した後にトップの読み取り・通過権限を最後に公開する。

管理範囲は固定版の配置先とwrapperだけとし、別版・別経路のMuseScore、楽譜、ユーザー設定は変更しない。`diff`では共通のCustom Handler表示規則に従い、`custom: musescore`を表示する。

`opendesign`の目的状態は、次の3つを保証することとする。

- `~/mirrors/open-design`が`nexu-io/open-design`のcloneである。
- リポジトリ内のdaemonとwebのbuild成果物（`apps/daemon/dist/cli.js`と`apps/web/out/index.html`）がある。
- リポジトリにcdしてから`corepack pnpm exec od`を実行するwrapperが`~/.local/bin/od`にある。

既存のcloneの更新は対象外とする。

`tmp-disk`の目的状態は、次の2つを保証することとする。

- `tmp.mount` unitがmaskedであり、`/tmp`がtmpfsとしてマウントされないこと。
- `/etc/tmpfiles.d/tmp.conf`が`q /tmp 1777 root root 2d`であり、systemd-tmpfilesの定期掃除で、2日以上更新のない`/tmp`直下のエントリが削除されること。

## sync

`sync` は、Install / Ensure Phase、状態取得、Uninstall Phaseの順で環境を同期する。

### 1. Install / Ensure Phase

最初に設定配列から全`apt`項目を収集し、1つのバッチとして処理する。その後、`apt`項目を除いた設定配列を先頭から末尾へ処理する。`flatpak`、`uv`、`bun`、`cargo`、`go`、`brew`、`brew-cask`では、配列上で連続する同じキーの項目を1つのバックエンド操作にまとめる。`custom`と`run`はまとめない。異なるキーが挟まれたあとに再び同じキーが現れた場合は、別のバッチとして処理する。`go install`は同一バッチ内の引数でバージョンsuffixが一致している必要があり、不一致のときはバックエンドが失敗する。宣言的Managerと`run`の各項目は、導入済みかどうかにかかわらず実行する。

| キー | 振る舞い |
| --- | --- |
| `apt` | 設定配列中の全パッケージ値から解決したDebianパッケージ名について`dpkg-query -W`で導入済みか確認し、未導入のものだけを1回のinstall操作で導入する。全対象が導入済みなら何もしない。未導入のものがあるときだけ、install操作の前に`sudo apt update`を1回実行する。 |
| `flatpak` | 各アプリIDについて`flatpak info --user`で導入済みか確認し、未導入のものだけinstall操作を実行する。バッチ内の対象がすべて導入済みなら何もしない。未導入のものがあるときだけ、最初の`flatpak`バッチ処理前に`flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo`を1回実行する。 |
| `uv` | 指定されたPythonパッケージごとに `uv tool install -q` を実行する。連続する`uv`項目は1つの処理単位にまとめるが、1パッケージずつ実行する。導入済みの already installedメッセージは出ない。 |
| `bun` | 指定されたnpmパッケージに対して `bun add -g --silent` を実行する。`bun add` の installed要約は出ない。 |
| `cargo` | 指定されたRust binary crateに対して `cargo install --quiet` を実行する。既定のインストールルートにある導入済みcrateはCargoの判定に従って最新化または維持する。 |
| `go` | 指定されたGo toolに対して`go install`を実行する。バージョンsuffixがない値には`@latest`を付けて実行する。 |
| `brew` | 指定されたFormulaに対して `HOMEBREW_NO_ENV_HINTS=1 brew install --quiet` を実行する。already-installed警告、reinstall案内、Homebrew の環境ヒントと進捗表示は出ない。 |
| `brew-cask` | 指定されたCaskに対して `HOMEBREW_NO_ENV_HINTS=1 brew install --quiet --cask` を実行する。Not upgrading警告、Homebrew の環境ヒントと進捗表示は出ない。 |
| `custom` | 名前に対応するCustom Handlerを呼び出し、Handlerが定義する目的状態を保証する。`blender`はPersonal-only Handlerであり、workプロファイルでは実行せず（Personal-only Handlerの節）、personalプロファイルではdownload.blender.orgの最新安定版linux-x64 tarballを`/opt`へ展開し、`/usr/local/bin/blender`からblender実行ファイルへのsymlinkを保証する。`openwhispr`はGitHub releaseの`.deb`を`sudo apt install -y`で導入する。`rustdesk`と`surge-xt`もGitHub releaseの`.deb`を同様に導入する。`generaluser-gs`は`mrbumpy409/GeneralUser-GS`の`main`ブランチの`GeneralUser-GS.sf2`を`~/.local/share/soundfonts/`へダウンロードする。名前に対応するHandlerがなければ失敗として記録する。 |
| `run` | 指定されたコマンドを`bash -c`で実行する。同期ごとに必ず実行する。 |

### 2. State Read

各Declarative Managerの現在状態を取得する。状態取得に失敗したManagerは、そのManagerのUninstall Phaseを行わず、失敗として記録する。

### 3. Uninstall Phase

各Declarative Managerで、現在のグローバル状態にあり、そのManagerのDesired Stateにない項目を削除する。

| Manager | 削除対象 | 削除の単位 |
| --- | --- | --- |
| uv | Desired StateにないPythonパッケージ | uvごとにまとめて処理 |
| bun | Desired Stateにないグローバルnpmパッケージ | bunごとにまとめて処理 |
| cargo | Desired StateにないRust binary crate | `cargo uninstall`でcrate群として処理 |
| go | Desired StateにないGo tool | gupごとにまとめて処理 |
| brew | Desired StateにないFormula | Formula群として処理 |
| brew-cask | Desired StateにないCask | Cask群として処理 |

Uninstall Phaseは、設定ファイル内の要素順序に従わない。Managerはキー名のアルファベット順、`brew-cask`、`brew`、`bun`、`cargo`、`go`、`uv`で処理する。`apt`、`flatpak`、`run`はこのフェーズで処理しない。workプロファイルでは、このフェーズの最後に、導入済みの各Personal-only Handlerの管理下パスの削除を実行する（`blender`の削除対象は`blender`の目的状態の節に従う）。personalプロファイルではPersonal-only Handlerの削除を行わない。

## diff

`diff` はホストを変更しない。Declarative Managerでは、現在のグローバル状態とDesired Stateの差を、Uninstall Phaseと同じManager名のアルファベット順で削除予定として表示する。状態取得に失敗したManagerの差分は表示しない。次に、Install / Ensure Phaseの予定を設定配列の順序で1要素ずつ表示する。状態取得に失敗したManagerのパッケージ項目は、この予定にも含めない。`apt`で`dpkg-query -W`により導入済みと確認できた項目、および`flatpak`で`flatpak info --user`により導入済みと確認できた項目は表示しない。それ以外のパッケージ項目は、導入済みかどうかにかかわらずinstall / update予定として表示する。`custom`と`run`は配列上の位置で、同期時に呼び出すHandlerまたは実行するコマンドとして表示する。未知のCustom Handlerもその位置で表示して失敗を記録する。workプロファイルでは、`work`配列内のPersonal-only Handlerはその位置で失敗を記録し、加えて表示の最後に、導入済みのPersonal-only Handlerを`remove custom: {name}`として表示する。状態取得の失敗は記録し、他の項目の表示を続ける。

差分の有無にかかわらず、失敗がなければ`diff`は終了コード0で終了する。設定エラーは処理せずに異常終了する。
