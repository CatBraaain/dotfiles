# pre-chezmoi spec

`pre-chezmoi.ts` の観測可能な振る舞いの仕様。対象は、リポジトリルートで Bun ランタイムにより `bun pre-chezmoi.ts` を実行したときの、入力（`dotfiles/` ツリーと実行プラットフォーム）から出力（`dist/` ツリーと終了コード）への変換。`dist/` は chezmoi の sourceDir として扱われる。読者は、この spec だけを読んで要件を承認するオーナーと、実装・テストの担当者。

- プラットフォーム: Windows（`process.platform === "win32"`）と、それ以外（Linux / macOS）の2種。
- 経路表記: 本文のパスはリポジトリルートからの相対パス。
- `*.merge.local.{json,yaml}` は git 管理外（`.gitignore`）。`*.merge.{json,yaml}` は git 管理する共有レイヤー。

## 変換の順序

実行ごとに、次の順で変換する。

1. dist 再構築
2. パス移動（プラットフォーム別）
3. dot 変換
4. exact 変換
5. executable 変換
6. merge 変換

## 1. dist 再構築

`dist/` を削除し、`dotfiles/` の完全なコピーとして作り直す。任意の階層の `node_modules/` はコピーしない。前回実行で `dist/` にあった内容は残らない。

## 2. パス移動

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
| sharex | Documents/ShareX | 移動しない |
| vscode | AppData/Roaming/Code/User | 移動しない |
| zed | AppData/Roaming/Zed | .config/zed |

パス移動では、ディレクトリだけでなくファイルも扱う。

## 3. dot 変換

`dist/` 内の、名前が `.` で始まるすべてのエントリ（ファイル・ディレクトリ両方、深さは問わない）の名前の先頭 `.` を `dot_` へ変える。入れ子のドットエントリは親も子も変換する。パスに `.chezmoi` を含むエントリはそのまま。

| 入力                      | 出力                         |
| ------------------------- | ---------------------------- |
| `.bashrc`                 | `dot_bashrc`                 |
| `.config`（ディレクトリ） | `dot_config`                 |
| `.config/.gitconfig`      | `dot_config/dot_gitconfig`   |
| `.chezmoiignore`          | `.chezmoiignore`（そのまま） |

## 4. exact 変換

`dist/` 内の、名前が `.exact` で終わるディレクトリの名前から `.exact` を除き、先頭に `exact_` を付ける。名前が `.exact` で終わるファイルはそのまま。

dot 変換の後に行うため、`.xxx.exact` の形のディレクトリは `exact_dot_xxx` になる。

| 入力                                     | 出力                        |
| ---------------------------------------- | --------------------------- |
| `.pi/agent/skills.exact`（ディレクトリ） | `dot_pi/agent/exact_skills` |
| `.pi.exact`（ディレクトリ）              | `exact_dot_pi`              |
| `memo.exact`（ファイル）                 | `memo.exact`（そのまま）    |

## 5. executable 変換

`dist/` 内の、名前が `.executable` で終わるファイルの名前から `.executable` を除き、先頭に `executable_` を付ける。

| 入力                    | 出力                    |
| ----------------------- | ----------------------- |
| `run_foo.sh.executable` | `executable_run_foo.sh` |

## 6. merge 変換

JSON/YAML の設定ファイルを、ホーム現状とリポジトリ側レイヤーから **pre-chezmoi 実行時に** 合成し、`dist/` へ完成形を書き出す。chezmoi modify template（`modify_*`）は生成しない。

### 6.1 入力ファイルの種類

同一ディレクトリ内で、出力ファイル名 `<name>.{json,yaml}` に対し、次の sidecar を使う。

| ファイル                         | 管理      | 役割                                       |
| -------------------------------- | --------- | ------------------------------------------ |
| `<name>.{json,yaml}`             | git       | plain base（リポジトリのベース本体。任意） |
| `<name>.merge.{json,yaml}`       | git       | 共有 merge レイヤー（任意）                |
| `<name>.merge.local.{json,yaml}` | gitignore | マシン固有 merge レイヤー（任意）          |

`<name>.merge.{json,yaml}` または `<name>.merge.local.{json,yaml}` のどちらかが存在するとき、その `<name>.{json,yaml}` は **merge ターゲット** となる。

merge ターゲットでないファイルは、従来どおり `dist/` へそのまま残す。

### 6.2 ターゲット解決

merge ターゲットごとに、次を決める。

- **出力パス**: sidecar と同じディレクトリの `<name>.{json,yaml}`
- **ホームパス**: `chezmoi target-path -c chezmoi.yaml dist/<出力パス>` の stdout（末尾改行除去）。chezmoi の destination 既定（`~`）に従う。

sidecar 名から `<name>` への対応:

| sidecar                | `<name>`   |
| ---------------------- | ---------- |
| `foo.merge.json`       | `foo.json` |
| `foo.merge.local.yaml` | `foo.yaml` |

同一 `<name>` に sidecar が複数あるときは 1 ターゲットにまとめる。

### 6.3 レイヤーと適用順

merge ターゲットごとに、存在するレイヤーだけを次の順で合成する。合成の起点は `{}`（JSON）または空（YAML パース結果が null/undefined のとき `{}` 扱い）。

| 順  | レイヤー    | ソース                                                                        |
| --- | ----------- | ----------------------------------------------------------------------------- |
| 1   | ホーム      | §6.2 のホームパス。ファイルが存在しない・空のとき `{}`                        |
| 2   | plain base  | 同ディレクトリの `<name>.{json,yaml}`（merge / merge.local ではないファイル） |
| 3   | merge       | `<name>.merge.{json,yaml}`                                                    |
| 4   | merge.local | `<name>.merge.local.{json,yaml}`                                              |

後段レイヤーほど優先される。

各レイヤーへの適用は §7（パッチ適用）に従う。

### 6.4 dist への出力

merge ターゲットごとに:

1. §6.3 の合成結果を §7.4 の canonical 形式で `<name>.{json,yaml}` に書き出す。
2. 入力として使った sidecar（`*.merge.*`, `*.merge.local.*`）を `dist/` から削除する。
3. plain base の `<name>.{json,yaml}` が存在したとき、それも `dist/` から削除する（完成形のみ残す）。

`dist/` には sidecar も plain base の生ファイルも残らない。完成形 `<name>.{json,yaml}` だけが残る。

### 6.5 対象外

次は merge 変換の対象外とし、`dist/` にそのまま残す。

- sidecar を持たない plain ファイル
- リポジトリ内で手書きされた `modify_*` テンプレート（obs-studio 等）

### 6.6 例

#### `settings.merge.json` のみ（plain base なし）

```
dotfiles/.pi/agent/settings.merge.json
```

1. dot 変換後: `dist/dot_pi/agent/settings.merge.json`
2. ホーム: `~/.pi/agent/settings.json`（`chezmoi target-path`）
3. 合成: ホーム → merge レイヤー
4. 出力: `dist/dot_pi/agent/settings.json`。`settings.merge.json` は削除

#### `config.yaml` + `config.merge.local.yaml`（merge なし）

```
dotfiles/.pi/agent/extensions.exact/agents/config.yaml
dotfiles/.pi/agent/extensions.exact/agents/config.merge.local.yaml  （gitignore）
```

1. exact 変換後: `dist/dot_pi/agent/exact_extensions/agents/config.merge.local.yaml` 等
2. 合成: ホーム → plain base（config.yaml）→ merge.local
3. 出力: `dist/.../config.yaml`。sidecar と plain base 生ファイルは削除

#### 全レイヤー

```
foo.json
foo.merge.json
foo.merge.local.json
```

合成: ホーム → plain base → merge → merge.local → `dist/.../foo.json`

## 7. パッチ適用

merge 変換の各レイヤー、および将来同一関数を使う処理は、ここで定義する 1 回分の **パッチ適用** として扱う。

### 7.1 1 レイヤー内の処理順

1. 操作キー（キー名が `<path>.$<op>` 形式のもの）をレイヤーから取り除く。
2. 残りのキーをベースへ深くマージする（§7.2）。
3. 取り除いた操作キーを §7.3 の規則でベースへ適用する。

出力に操作キーは残らない。

### 7.2 深いマージ（通常キー）

同じキーが両方でプレーンオブジェクトのときだけ再帰し、それ以外（スカラー・配列・オブジェクトと非オブジェクトの組合せ）はレイヤー側の値で丸ごと置き換える。片側にだけあるキーの値は維持する。

### 7.3 操作キー（`$append` / `$remove` / `$replace` / `$unset`）

操作キーは、キー名が次の形式のときだけ認識する。

```
<path>.$<op>
```

| 部分     | 内容                                                                 |
| -------- | -------------------------------------------------------------------- |
| `<path>` | ドット区切りのパス（例: `packages`, `tiers.high`, `retry.provider`） |
| `<op>`   | `append` / `remove` / `replace` / `unset` のいずれか                 |

`<path>` に配列インデックス（`[0]` など）は書けない。

#### 操作の意味

| キー              | `<path>` の値の型 | 値                  | 結果                                                                        |
| ----------------- | ----------------- | ------------------- | --------------------------------------------------------------------------- |
| `<path>.$append`  | 配列              | 要素の配列          | 末尾に追加する。重複していても追加する                                      |
| `<path>.$remove`  | 配列              | マッチャの配列      | 一致する要素をすべて削除する（§7.3 配列表一致）                             |
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

### 7.4 出力形式（canonical）

merge ターゲットの完成形は、毎回同一形式で書き出す。

| 形式 | 規則                                               |
| ---- | -------------------------------------------------- |
| JSON | 2 スペースインデント、末尾改行 1 つ、改行コード LF |
| YAML | YAML 形式、改行コード LF                           |

JSON の merge / merge.local ファイルおよび plain base の JSON 入力にはコメント（JSONC）を書ける。

## エラー

| 条件                                                               | 振る舞い                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `chezmoi target-path` が失敗                                       | その stderr を出力して異常終了（終了コード 0 以外）                        |
| 操作キーの形式が `<path>.$<op>` に合わない                         | `invalid merge op key: <キー名>` を出力して異常終了                        |
| `<op>` が `append` / `remove` / `replace` / `unset` 以外           | 上記と同じ                                                                 |
| `<path>` に `[` を含む                                             | 上記と同じ                                                                 |
| `<path>.$append` の `<path>` が配列でない                          | `merge append requires array at path: <path>` を出力して異常終了           |
| `<path>.$remove` の `<path>` が配列でもオブジェクトでもない        | `merge remove requires array or object at path: <path>` を出力して異常終了 |
| `<path>.$append` / `<path>.$remove` の値が配列でない               | `merge <op> value must be array: <キー名>` を出力して異常終了              |
| `<path>.$remove`（オブジェクト）の値の要素が文字列でない           | `merge remove object keys must be strings: <キー名>` を出力して異常終了    |
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
| `*.merge.*` → `modify_*`（chezmoi modify template） | `*.merge.*` → merge レイヤー（§6）      |
| overwrite 変換（ベースへの build 時マージ）         | §6 の plain base レイヤー + merge.local |

`.gitignore` の `*.overwrite.*` は `*.merge.local.*` に置き換える。
