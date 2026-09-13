# pre-chezmoi spec

`pre-chezmoi.ts` の観測可能な振る舞いの仕様。対象は、リポジトリルートで Bun ランタイムにより `bun pre-chezmoi.ts` を実行したときの、入力（`dotfiles/` ツリーと実行プラットフォーム）から出力（`dist/` ツリーと終了コード）への変換。`dist/` は chezmoi の sourceDir として扱われる。読者は、この spec だけを読んで要件を承認するオーナーと、実装・テストの担当者。

- プラットフォーム: Windows（`process.platform === "win32"`）と、それ以外（Linux / macOS）の2種。
- 経路表記: 本文のパスはリポジトリルートからの相対パス。
- `*.merge.local.{json,yaml,toml}` は git 管理外（`.gitignore`）。`*.merge.{json,yaml,toml}` は git 管理する共有レイヤー。

## 変換の順序

実行ごとに、次の順で変換する。

1. dist 再構築
2. ローカルフック実行
3. パス移動（プラットフォーム別）
4. dot 変換
5. exact 変換
6. executable 変換
7. symlink 変換
8. merge 変換

## 1. dist 再構築

`dist/` を削除し、`dotfiles/` の完全なコピーとして作り直す。任意の階層の `node_modules/` はコピーしない。前回実行で `dist/` にあった内容は残らない。

## 2. ローカルフック実行

`dotfiles/` 以下に、名前が `.pre-chezmoi.ts` と完全一致する通常ファイルを置くと、ローカルフックとして扱う。ローカルフックは、フォルダ固有のファイルを `dist/` へ生成するためのものである。

```text
dotfiles/.pi/agent/.pre-chezmoi.ts
```

フック自身は `dist/` へそのままコピーされる。chezmoi は source directory 内の `.` で始まるエントリを、`.chezmoi` で始まるものを除いて無視するため、`dist/` に残ったフックは chezmoi の apply 対象にならない。フックが生成した `.pre-chezmoi.ts` も同様に chezmoi の対象外であり、新しいフックとして実行しない。

### 2.1 実行方法

各フックを次のコマンドで、独立した子プロセスとして実行する。

```text
bun <absolute path to hook-file>
```

検出時に source 側フックの絶対パスを確定し、その絶対パスを `bun` へ渡す。

- `cwd`: platform 移動前の、フックを置いたフォルダに対応する `dist/` 内のフォルダ
- 環境変数: 通常の親プロセス環境をそのまま継承する
- 追加の環境変数、専用 API、設定ファイルは提供しない
- フックは `process.cwd()` を生成物の出力先として使う
- フック自身の source ファイルは `import.meta.dir` から参照できる

root のフック `dotfiles/.pre-chezmoi.ts` の `cwd` は `dist/` である。

フックは対応する `dist/` フォルダ以下へファイルを生成する。生成物の名前は既存の人間向け記法を使う。この出力範囲はフック作者が守る契約であり、`pre-chezmoi.ts` はパス検証やサンドボックスを行わない。

```ts
import { writeFile } from "node:fs/promises";

await writeFile("generated.exact/config", "value\n");
```

### 2.2 検出と順序

1. `dotfiles/` を再帰的に走査する。
2. `node_modules/` 以下は走査しない。
3. `.pre-chezmoi.ts` と完全一致する通常ファイルを検出する。
4. 検出したフックを、フックの親ディレクトリの相対パスでソートし、一つずつ実行する。比較はパスを `/` で分割した各要素を JavaScript の文字列比較（UTF-16 コード単位の昇順）で行い、片方が他方の接頭辞なら短い方を先にする。
5. 同じフックを一度の実行で複数回起動しない。
6. フックが生成した `.pre-chezmoi.ts` は新しいフックとして検出・実行しない。

この順序により、親フォルダのフックは子フォルダのフックより先に実行される。

### 2.3 生成物と既存変換

フックは既存の platform・dot・exact・executable・symlink・merge 変換より先に実行する。そのため、フックが生成したファイルにも既存変換が適用される。platform 移動の対象フォルダに置いたフックの生成物も、通常の source ファイルと同じように platform 移動の対象になる。

ローカルフックで生成した ChezMoi の `run_before` ファイルも他の生成物と同じ既存変換を受け、変換後の名前で `dist/` に残る。ローカルフックは `run_before` より前に、`pre-chezmoi.ts` の実行中に完了する。

### 2.4 成功と失敗

すべてのローカルフックと既存変換が成功したとき、生成された `dist/` を出力として終了コード `0` で終了する。フックがない場合の結果は、ローカルフック機能を追加する前と同じである。

次のいずれかが起きたとき、終了コード `0` 以外で終了する。

- フックが終了コード `0` 以外で終了した
- フックがシグナルで終了した
- フックまたは既存変換でエラーが発生した

フックのエラーには、`dotfiles/` からの相対パスを含める。フックの stdout と stderr は親プロセスの同じ出力へ転送する。

エラー発生後は後続のフックと既存変換を実行しない。`dist/` の rollback、build 間の lock、staging による原子的な置換は行わない。エラー時の `dist/` は処理途中の状態になり得る。

### 2.5 例

入力:

```text
dotfiles/.pi/agent/.pre-chezmoi.ts
dotfiles/.pi/agent/config.exact/placeholder
```

フックが `cwd` に次を生成する:

```text
generated.exact/settings.json
```

既存変換後の出力:

```text
dist/dot_pi/agent/.pre-chezmoi.ts          # そのまま残り、chezmoi の対象外
dist/dot_pi/agent/exact_generated/settings.json
dist/dot_pi/agent/exact_config/placeholder
```

## 3. パス移動

下表の移動元エントリ（ファイルまたはディレクトリ）を、実行プラットフォームの配置先（`dist/` からの相対パス）へ移動する。配置先が既に存在するときは置き換える。移動元エントリが `dist/` に存在しない行は何も起きない。表にないエントリは、`dist/` 直下または元の階層に置かれたままになる。

| 移動元エントリ | Windows | それ以外 |
| --- | --- | --- |
| docker | AppData/Roaming/Docker | .docker/desktop |
| erdtree | AppData/Roaming/erdtree | .config/erdtree |
| gemini | .gemini | 移動しない |
| git-cliff | AppData/Roaming/git-cliff | .config/git-cliff |
| localsend/settings.merge.json | AppData/Roaming/LocalSend/settings.merge.json | .local/share/org.localsend.localsend_app/shared_preferences.merge.json |
| mise | .config/mise | 移動しない |
| nushell | AppData/Roaming/nushell | 移動しない |
| obs-studio | AppData/Roaming/obs-studio | 移動しない |
| powershell | Documents/PowerShell | 移動しない |
| windows-terminal | AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState | 移動しない |
| roo | .roo | 移動しない |
| rtk | 移動しない | .config/rtk |
| sharex | Documents/ShareX | 移動しない |
| vscode | AppData/Roaming/Code/User | 移動しない |
| zed | AppData/Roaming/Zed | .config/zed |

パス移動では、ディレクトリだけでなくファイルも扱う。

## 4. dot 変換

`dist/` 内の、名前が `.` で始まるすべてのエントリ（ファイル・ディレクトリ両方、深さは問わない）の名前の先頭 `.` を `dot_` へ変える。入れ子のドットエントリは親も子も変換する。パスに `.chezmoi` を含むエントリと、名前が `.pre-chezmoi` で始まるエントリはそのまま。

| 入力                      | 出力                         |
| ------------------------- | ---------------------------- |
| `.bashrc`                 | `dot_bashrc`                 |
| `.config`（ディレクトリ） | `dot_config`                 |
| `.config/.gitconfig`      | `dot_config/dot_gitconfig`   |
| `.chezmoiignore`          | `.chezmoiignore`（そのまま） |
| `.pre-chezmoi.ts`         | `.pre-chezmoi.ts`（そのまま） |
| `.pre-chezmoi.test.ts`    | `.pre-chezmoi.test.ts`（そのまま） |
| `.pre-chezmoi.skills.yaml` | `.pre-chezmoi.skills.yaml`（そのまま） |

## 5. exact 変換

`dist/` 内の、名前が `.exact` で終わるディレクトリの名前から `.exact` を除き、先頭に `exact_` を付ける。名前が `.exact` で終わるファイルはそのまま。

dot 変換の後に行うため、`.xxx.exact` の形のディレクトリは `exact_dot_xxx` になる。

| 入力                                     | 出力                        |
| ---------------------------------------- | --------------------------- |
| `.pi/agent/skills.exact`（ディレクトリ） | `dot_pi/agent/exact_skills` |
| `.pi.exact`（ディレクトリ）              | `exact_dot_pi`              |
| `memo.exact`（ファイル）                 | `memo.exact`（そのまま）    |

## 6. executable 変換

`dist/` 内の、名前が `.executable` で終わるファイルの名前から `.executable` を除き、先頭に `executable_` を付ける。

| 入力                    | 出力                    |
| ----------------------- | ----------------------- |
| `run_foo.sh.executable` | `executable_run_foo.sh` |

## 7. symlink 変換

`dist/` 内の、名前が `.symlink` で終わるファイルの名前から `.symlink` を除き、先頭に `symlink_` を付ける。ファイルの内容は書き換えない。パスに `.chezmoi` を含むエントリは dot 変換と同じく対象外。

| 入力                 | 出力                 |
| -------------------- | -------------------- |
| `AGENTS.md.symlink`  | `symlink_AGENTS.md`  |
| `.foo.symlink`       | `symlink_dot_foo`    |

dot 変換の後に行うため、`.xxx.symlink` の形のファイルは `symlink_dot_xxx` になる。これは chezmoi が許可する source 名の prefix 順序（`symlink_` → `dot_`）と一致する。

`symlink_` 付きファイルは chezmoi の symlink source として扱われる。末尾の改行 1 つを除いた内容がリンク先になり、相対パスは symlink が置かれるディレクトリから解決される。例: `dot_pi/agent/symlink_AGENTS.md` の内容 `../../.agents/AGENTS.md` は `~/.agents/AGENTS.md` を指す。

## 8. merge 変換

JSON/YAML/TOML の設定ファイルを、ホーム現状とリポジトリ側レイヤーから **pre-chezmoi 実行時に** 合成し、`dist/` へ完成形を書き出す。chezmoi modify template（`modify_*`）は生成しない。

### 8.1 入力ファイルの種類

同一ディレクトリ内で、出力ファイル名 `<name>.{json,yaml,toml}` に対し、次の sidecar を使う。

| ファイル                                   | 管理      | 役割                                       |
| ------------------------------------------ | --------- | ------------------------------------------ |
| `<name>.{json,yaml,toml}`                  | git       | plain base（リポジトリのベース本体。任意） |
| `<name>.merge.{json,yaml,toml}`            | git       | 共有 merge レイヤー（任意）                |
| `<name>.merge.local.{json,yaml,toml}`      | gitignore | マシン固有 merge レイヤー（任意）          |

`<name>.merge.{json,yaml,toml}` または `<name>.merge.local.{json,yaml,toml}` のどちらかが存在するとき、その `<name>.{json,yaml,toml}` は **merge ターゲット** となる。

merge ターゲットでないファイルは、従来どおり `dist/` へそのまま残す。

### 8.2 ターゲット解決

merge ターゲットごとに、次を決める。

- **出力パス**: sidecar と同じディレクトリの `<name>.{json,yaml,toml}`
- **ホームパス**: `chezmoi target-path -c chezmoi.yaml dist/<出力パス>` の stdout（末尾改行除去）。chezmoi の destination 既定（`~`）に従う。

sidecar 名から `<name>` への対応:

| sidecar                      | `<name>`     |
| ---------------------------- | ------------ |
| `foo.merge.json`             | `foo.json`   |
| `foo.merge.local.yaml`       | `foo.yaml`   |
| `foo.merge.toml`             | `foo.toml`   |
| `foo.merge.local.toml`       | `foo.toml`   |

同一 `<name>` に sidecar が複数あるときは 1 ターゲットにまとめる。

### 8.3 レイヤーと適用順

merge ターゲットごとに、存在するレイヤーだけを次の順で合成する。合成の起点は `{}`（JSON・TOML。YAML パース結果が null/undefined のときも `{}` 扱い）。

| 順  | レイヤー    | ソース                                                                                  |
| --- | ----------- | --------------------------------------------------------------------------------------- |
| 1   | ホーム      | §8.2 のホームパス。ファイルが存在しない・空のとき `{}`                                  |
| 2   | plain base  | 同ディレクトリの `<name>.{json,yaml,toml}`（merge / merge.local ではないファイル）      |
| 3   | merge       | `<name>.merge.{json,yaml,toml}`                                                         |
| 4   | merge.local | `<name>.merge.local.{json,yaml,toml}`                                                   |

後段レイヤーほど優先される。

各レイヤーへの適用は §9（パッチ適用）に従う。

### 8.4 dist への出力

merge ターゲットごとに:

1. §8.3 の合成結果を §9.4 の canonical 形式で `<name>.{json,yaml,toml}` に書き出す。
2. 入力として使った sidecar（`*.merge.*`, `*.merge.local.*`）を `dist/` から削除する。
3. plain base の `<name>.{json,yaml,toml}` が存在したとき、それも `dist/` から削除する（完成形のみ残す）。

`dist/` には sidecar も plain base の生ファイルも残らない。完成形 `<name>.{json,yaml,toml}` だけが残る。

### 8.5 対象外

次は merge 変換の対象外とし、`dist/` にそのまま残す。

- sidecar を持たない plain ファイル
- sidecar を持たない、リポジトリ内で手書きされた `modify_*` テンプレート（obs-studio 等）

`modify_*` テンプレートにも §8.1 の一般則が適用される。sidecar を置いた `modify_*` は merge ターゲットとなり、手書きテンプレートの内容が plain base レイヤーとして合成され、完成形 `modify_*` を `dist/` に書き出す。

### 8.6 例

#### `settings.merge.json` のみ（plain base なし）

```
dotfiles/.pi/agent/settings.merge.json
```

1. dot 変換後: `dist/dot_pi/agent/settings.merge.json`
2. ホーム: `~/.pi/agent/settings.json`（`chezmoi target-path`）
3. 合成: ホーム → merge レイヤー
4. 出力: `dist/dot_pi/agent/settings.json`。`settings.merge.json` は削除

#### `agents.yaml` + `agents.merge.local.yaml`（merge なし）

```
dotfiles/.pi/agent/config.exact/agents.yaml
dotfiles/.pi/agent/config.exact/agents.merge.local.yaml  （gitignore）
```

1. dot 変換後: `dist/dot_pi/agent/exact_config/agents.merge.local.yaml` 等
2. 合成: ホーム → plain base（agents.yaml）→ merge.local
3. 出力: `dist/dot_pi/agent/exact_config/agents.yaml`。sidecar と plain base 生ファイルは削除

#### `config.merge.toml` のみ（plain base なし、パス移動と組合せ）

```
dotfiles/rtk/config.merge.toml
```

1. dist 再構築後: `dist/rtk/config.merge.toml`
2. パス移動（§3）・dot 変換後: `dist/dot_config/rtk/config.merge.toml`
3. ホーム: `~/.config/rtk/config.toml`（`chezmoi target-path`）
4. 合成: ホーム → merge レイヤー
5. 出力: `dist/dot_config/rtk/config.toml`。`config.merge.toml` は削除

#### 全レイヤー

```
foo.json
foo.merge.json
foo.merge.local.json
```

合成: ホーム → plain base → merge → merge.local → `dist/.../foo.json`

## 9. パッチ適用

merge 変換の各レイヤー、および将来同一関数を使う処理は、ここで定義する 1 回分の **パッチ適用** として扱う。

### 9.1 1 レイヤー内の処理順

1. 操作キー（§9.3）をレイヤー内の任意の深さから取り除く。
2. 残りのキーをベースへ深くマージする（§9.2）。
3. 取り除いた操作キーを §9.3 の規則でベースへ適用する。

出力に操作キーは残らない。

### 9.2 深いマージ（通常キー）

同じキーが両方でプレーンオブジェクトのときだけ再帰し、それ以外（スカラー・配列・オブジェクトと非オブジェクトの組合せ）はレイヤー側の値で丸ごと置き換える。片側にだけあるキーの値は維持する。

### 9.3 操作キー（`$append` / `$remove` / `$replace` / `$unset`）

操作キーはレイヤー内の任意のオブジェクトに置ける。キー名が次の形式で、かつ認識条件を満たすものだけが操作キーになる。

```
<local>.$<op>
```

| 部分      | 内容                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `<local>` | そのオブジェクト内での操作対象の相対パス（例: `bundles`, `provider`） |
| `<op>`    | `append` / `remove` / `replace` / `unset` のいずれか                    |

認識条件:

- `<op>` が上表の4種のいずれかである。
- `<local>` が空でない。
- `<local>` に `[` を含まない。

操作キーの `<path>` は、キーを置いたオブジェクトからレイヤーのルートまでの祖先キーを `.` で連結し、`<local>` を末尾に付けたものである。`<path>` に配列インデックス（`[0]` など）は書けない。

認識条件を満たさない `.$` を含むキー（例: `x.$nope`、`a[0].$replace`）は操作キーではなく通常キーとして扱い、深いマージ（§9.2）でそのまま出力に残る。

操作キーの値は、その中をさらに走査せず、そのまま操作の値として扱う。

操作キーだけを含むオブジェクトは通常キーのマージに寄与せず、その祖先キーごと欠落として扱う。

#### 操作の意味

| キー              | `<path>` の値の型 | 値                  | 結果                                                                        |
| ----------------- | ----------------- | ------------------- | --------------------------------------------------------------------------- |
| `<path>.$append`  | 配列              | 要素の配列          | 末尾に追加する。重複していても追加する                                      |
| `<path>.$remove`  | 配列              | マッチャの配列      | 一致する要素をすべて削除する（§9.3 配列表一致）                             |
| `<path>.$remove`  | オブジェクト      | キー名の配列        | 列挙されたキーを削除する                                                    |
| `<path>.$unset`   | 任意              | `true` または値なし | `<path>` が指す値を親から削除する                                           |
| `<path>.$replace` | 任意              | 任意                | `<path>` の値を値で丸ごと置き換える                                         |

`$append` は配列にだけ適用できる。`$remove` は配列とオブジェクトに適用できる。`$replace` と `$unset` は任意の型に適用できる。

#### 同一 `<path>` に複数操作があるとき

同じ `<path>` に対して複数の操作キーがあるとき、次の順で適用し、先に適用した結果を次の操作の入力とする。

1. `<path>.$replace` — 存在するとき、`<path>.$unset` / `<path>.$remove` / `<path>.$append` は無視する
2. `<path>.$unset`
3. `<path>.$remove`
4. `<path>.$append`

同じ `<path>.$<op>` のキーが複数あるとき（同一レイヤー内）、値は配列なら要素を連結し、それ以外は後勝ちで上書きする。

#### 異なる `<path>` 間の適用順

同一レイヤー内に異なる `<path>` の操作キーが複数あるとき、レイヤー内での出現順に path を1つずつ処理し、ある path の操作適用結果を次の path の操作の入力とする。親 path と子 path の両方に操作を書いたとき、出力はレイヤー内での出現順に依存する。

#### 配列要素の一致（`$remove` の削除対象）

マッチャと配列要素が次を満たすとき一致する。

| 配列要素の型             | 一致条件                                                               |
| ------------------------ | ---------------------------------------------------------------------- |
| 文字列・数値・真偽・null | 値が等しい                                                             |
| 配列                     | 長さが等しく、同じ位置の要素が一致する                                 |
| オブジェクト             | キー集合が等しく、各キーの値が一致する（キーの並びは問わない）         |

#### 記述例

共有レイヤーで package を追加:

```jsonc
// settings.merge.json
{
  "packages.$append": [
    {
      "source": "https://github.com/makenotion/skills",
      "skills": ["skills/notion-cli"],
      "extensions": [],
      "prompts": [],
      "themes": [],
    },
  ],
}
```

マシン固有で tiers を上書き:

```yaml
# config.merge.local.yaml
tiers:
  high:
    - provider: cursor
      model: grok-4.6:slow
```

配列から特定 package を除く:

```jsonc
{
  "packages.$remove": [{ "source": "https://github.com/iOfficeAI/OfficeCLI" }],
}
```

ネストで操作キーを書く。次の2つは等価である:

```yaml
# config.merge.local.yaml
dsh:
  profile:
    "bundles.$replace":
      - provider: cursor
```

```yaml
# config.merge.local.yaml
"dsh.profile.bundles.$replace":
  - provider: cursor
```

TOML では `$` を含むキー名を quoted key で書く。quoted key は `.` で分割されないため、祖先キーはテーブルまたは dotted key で表現する。次の2つは等価である:

```toml
# config.merge.local.toml
[dsh.profile]
"bundles.$replace" = [{ provider = "cursor" }]
```

```toml
# config.merge.local.toml
dsh.profile."bundles.$replace" = [{ provider = "cursor" }]
```

### 9.4 出力形式（canonical）

merge ターゲットの完成形は、毎回同一形式で書き出す。

| 形式 | 規則                                               |
| ---- | -------------------------------------------------- |
| JSON | 2 スペースインデント、末尾改行 1 つ、改行コード LF |
| YAML | YAML 形式、改行コード LF                           |
| TOML | TOML 形式、末尾改行 1 つ、改行コード LF            |

JSON の merge / merge.local ファイルおよび plain base の JSON 入力にはコメント（JSONC）を書ける。TOML の merge / merge.local ファイルおよび plain base の TOML 入力にはコメントを書ける。

## エラー

| 条件                                                               | 振る舞い                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `chezmoi target-path` が失敗                                       | その stderr を出力して異常終了（終了コード 0 以外）                        |
| `<path>.$append` の `<path>` が配列でない                          | `merge append requires array at path: <path>` を出力して異常終了           |
| `<path>.$remove` の `<path>` が配列でもオブジェクトでもない        | `merge remove requires array or object at path: <path>` を出力して異常終了 |
| `<path>.$append` / `<path>.$remove` の値が配列でない               | `merge <op> value must be array: <path>.$<op>` を出力して異常終了          |
| `<path>.$remove`（オブジェクト）の値の要素が文字列でない           | `merge remove object keys must be strings: <path>.$<op>` を出力して異常終了 |
| `<path>` がベースに存在しない（`$unset` / `$remove` / `$replace`） | 何もしない（エラーにしない）                                               |
| `<path>` がベースに存在しない（`$append`）                         | `merge append path not found: <path>` を出力して異常終了                   |

## 変換の組み合わせ例

Linux 実行時の `dotfiles/docker/settings-store.merge.json` は、次のように各段階のパスが決まる。

1. dist 再構築: `dist/docker/settings-store.merge.json`
2. パス移動: `dist/.docker/desktop/settings-store.merge.json`
3. dot 変換: `dist/dot_docker/desktop/settings-store.merge.json`
4. merge 変換: `dist/dot_docker/desktop/settings-store.json`（完成形。sidecar は存在しない）

## 移行（旧仕様から）

| 旧                                                  | 新                                      |
| --------------------------------------------------- | --------------------------------------- |
| `*.overwrite.{json,yaml}`                           | `*.merge.local.{json,yaml}`             |
| `*.merge.*` → `modify_*`（chezmoi modify template） | `*.merge.*` → merge レイヤー（§8）      |
| overwrite 変換（ベースへの build 時マージ）         | §8 の plain base レイヤー + merge.local |

`.gitignore` の `*.overwrite.*` は `*.merge.local.*` に置き換える。
