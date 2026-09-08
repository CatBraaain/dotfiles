# pre-chezmoi spec

`pre-chezmoi.ts` の観測可能な振る舞いの仕様。対象は、リポジトリルートで Bun ランタイムにより `bun pre-chezmoi.ts` を実行したときの、入力（`dotfiles/` ツリーと実行プラットフォーム）から出力（`dist/` ツリーと終了コード）への変換。`dist/` は chezmoi の sourceDir として扱われる。読者は、この spec だけを読んで要件を承認するオーナーと、実装・テストの担当者。

- プラットフォーム: Windows（`process.platform === "win32"`）と、それ以外（Linux / macOS）の2種。
- 経路表記: 本文のパスはリポジトリルートからの相対パス。

## 変換の順序

実行ごとに、次の順で変換する。

1. dist 再構築
2. パス移動（プラットフォーム別）
3. overwrite 変換
4. merge 変換
5. dot 変換
6. exact 変換
7. executable 変換

## 1. dist 再構築

`dist/` を削除し、`dotfiles/` をコピーして作り直す。任意の階層の `node_modules/` はコピーしない。前回実行で `dist/` にあった内容は残らない。

## 2. パス移動

`dist/` 直下の、下表のディレクトリを、実行プラットフォームの配置先（`dist/` からの相対パス）へ移動する。配置先が既に存在するときは置き換える。移動元ディレクトリが `dist/` に存在しない行は何も起きない。セルが「移動しない」の組合せと表にないディレクトリは、`dist/` 直下に置かれたままになる。

| ディレクトリ | Windows | それ以外 |
| --- | --- | --- |
| docker | AppData/Roaming/Docker | .docker/desktop |
| erdtree | AppData/Roaming/erdtree | .config/erdtree |
| gemini | .gemini | 移動しない |
| git-cliff | AppData/Roaming/git-cliff | .config/git-cliff |
| mise | .config/mise | 移動しない |
| nushell | AppData/Roaming/nushell | 移動しない |
| obs-studio | AppData/Roaming/obs-studio | 移動しない |
| powershell | Documents/PowerShell | 移動しない |
| windows-terminal | AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState | 移動しない |
| roo | .roo | 移動しない |
| sharex | Documents/ShareX | 移動しない |
| vscode | AppData/Roaming/Code/User | 移動しない |
| zed | AppData/Roaming/Zed | .config/zed |

## 3. overwrite 変換

`dist/` 内のすべての `*.overwrite.json` / `*.overwrite.yaml`（深さは問わない）を、同階層のベースファイル（ファイル名から `.overwrite` を除いたもの）へマージし、overwrite ファイルは削除する。

### 3.1 処理順序

各 overwrite ファイルは、次の順でベースへ反映する。

1. 操作キー（キー名が `<path>.$<op>` 形式のもの）を overwrite から取り除く。
2. 残りのキーをベースへ深くマージする（§3.2）。
3. 取り除いた操作キーを、§3.3 の規則でベースへ適用する。

出力のベースファイルに、操作キーは残らない。

### 3.2 深いマージ（通常キー）

同じキーが両方でプレーンオブジェクトのときだけ再帰し、それ以外（スカラー・配列・オブジェクトと非オブジェクトの組合せ）は overwrite 側の値で丸ごと置き換える。片側にだけあるキーの値は維持する。

```
dotfiles/.foo/settings.json            {"a":1,"nested":{"x":1,"y":2},"list":[1,2]}
dotfiles/.foo/settings.overwrite.json  {"nested":{"y":9,"z":3},"list":[3]}

→ dist/.foo/settings.json = {"a":1,"nested":{"x":1,"y":9,"z":3},"list":[3]}
  overwrite ファイルは dist に存在しない
```

### 3.3 操作キー（`$append` / `$remove` / `$replace` / `$unset`）

操作キーは、キー名が次の形式のときだけ認識する。

```
<path>.$<op>
```

| 部分 | 内容 |
| --- | --- |
| `<path>` | ドット区切りのパス（例: `packages`, `tiers.high`, `retry.provider`） |
| `<op>` | `append` / `remove` / `replace` / `unset` のいずれか |

`<path>` に配列インデックス（`[0]` など）は書けない。

#### 操作の意味

`<path>` が指す値の型と `<op>` の組合せで、次の操作を行う。

| キー | `<path>` の値の型 | 値 | 結果 |
| --- | --- | --- | --- |
| `<path>.$append` | 配列 | 要素の配列 | 末尾に追加する。既存要素と重複する追加要素はスキップする（配列要素の一致） |
| `<path>.$remove` | 配列 | マッチャの配列 | 一致する要素をすべて削除する（配列要素の一致） |
| `<path>.$remove` | オブジェクト | キー名の配列 | 列挙されたキーを削除する |
| `<path>.$unset` | 任意 | `true` または値なし | `<path>` が指す値を親から削除する |
| `<path>.$replace` | 任意 | 任意 | `<path>` の値を値で丸ごと置き換える |

`$append` は配列にだけ適用できる。`$remove` は配列とオブジェクトに適用できる。`$replace` と `$unset` は任意の型に適用できる。

#### 同一 `<path>` に複数操作があるとき

同じ `<path>` に対して複数の操作キーがあるとき、次の順で適用し、先に適用した結果を次の操作の入力とする。

1. `<path>.$replace` — 存在するとき、`<path>.$unset` / `<path>.$remove` / `<path>.$append` は無視する
2. `<path>.$unset`
3. `<path>.$remove`
4. `<path>.$append`

同じ `<path>.$<op>` のキーが複数あるとき（同一 overwrite ファイル内）、値は配列なら要素を連結し、それ以外は後勝ちで上書きする。

#### 配列要素の一致（`$append` の重複判定と `$remove` の削除対象）

| 配列要素の型 | 一致条件 |
| --- | --- |
| 文字列 | 完全一致 |
| オブジェクト | `source` プロパティの値が一致 |

#### 例

マシン固有で `packages` に notion を足す:

```jsonc
// settings.merge.overwrite.json
{
  "packages.$append": [
    {
      "source": "https://github.com/makenotion/skills",
      "skills": ["skills/notion-cli"],
      "extensions": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

配列から特定 package を除く:

```jsonc
{
  "packages.$remove": [{ "source": "https://github.com/iOfficeAI/OfficeCLI" }]
}
```

オブジェクトからキーを除く:

```jsonc
{
  "tiers.$remove": ["high"]
}
```

フィールドごと消す（`tiers.$remove: ["high"]` と同等）:

```jsonc
{
  "tiers.high.$unset": true
}
```

配列を全置換:

```jsonc
{
  "enabledModels.$replace": ["zai/**", "openrouter/**"]
}
```

操作キーと通常キーの併用:

```jsonc
{
  "theme": "light",
  "packages.$append": [{ "source": "https://github.com/makenotion/skills", ... }]
}
```

→ `theme` は §3.2 で深くマージされ、`packages` は §3.3 で末尾追加される。

ベースファイルの書き出し形式: JSON は 2 スペースインデント・末尾改行。YAML は YAML 形式。

## 4. merge 変換

`dist/` 内のすべての `*.merge.json` / `*.merge.yaml`（深さは問わない）を、同階層の chezmoi modify template へ変換し、merge ファイルは削除する。

| 入力 | 生成物 |
| --- | --- |
| `*.merge.json` | 同階層の `modify_*.json`（`*` は `.merge` を除いたファイル名） |
| `*.merge.yaml` | 同階層の `modify_*.yaml` |

生成された modify template を chezmoi が適用するとき、ホームの実ファイル（`~` 側）は次の内容へ更新される。

- 実ファイルの現在の内容と merge ファイルの内容を深くマージした結果。
- 同じキーが両方でプレーンオブジェクトのときだけ再帰し、それ以外（スカラー・配列・オブジェクトと非オブジェクトの組合せ）は merge ファイル側の値で丸ごと置き換える。実ファイルにだけあるキーは維持する。
- 実ファイルが存在しない・空のときは、merge ファイルの内容そのまま。
- JSON の merge ファイルにはコメント（JSONC）を書ける。

## 5. dot 変換

`dist/` 内の、名前が `.` で始まるすべてのエントリ（ファイル・ディレクトリ両方、深さは問わない）の名前の先頭 `.` を `dot_` へ変える。入れ子のドットエントリは親も子も変換する。パスに `.chezmoi` を含むエントリはそのまま。

| 入力 | 出力 |
| --- | --- |
| `.bashrc` | `dot_bashrc` |
| `.config`（ディレクトリ） | `dot_config` |
| `.config/.gitconfig` | `dot_config/dot_gitconfig` |
| `.chezmoiignore` | `.chezmoiignore`（そのまま） |

## 6. exact 変換

`dist/` 内の、名前が `.exact` で終わるディレクトリの名前から `.exact` を除き、先頭に `exact_` を付ける。名前が `.exact` で終わるファイルはそのまま。

dot 変換の後に行うため、`.xxx.exact` の形のディレクトリは `exact_dot_xxx` になる。

| 入力 | 出力 |
| --- | --- |
| `.pi/agent/skills.exact`（ディレクトリ） | `dot_pi/agent/exact_skills` |
| `.pi.exact`（ディレクトリ） | `exact_dot_pi` |
| `memo.exact`（ファイル） | `memo.exact`（そのまま） |

## 7. executable 変換

`dist/` 内の、名前が `.executable` で終わるファイルの名前から `.executable` を除き、先頭に `executable_` を付ける。名前が `.executable` で終わるディレクトリはそのまま。

| 入力 | 出力 |
| --- | --- |
| `bin/setup.executable`（ファイル） | `bin/executable_setup` |
| `bin.executable`（ディレクトリ） | `bin.executable`（そのまま） |

## エラー

| 条件 | 振る舞い |
| --- | --- |
| overwrite 変換でベースファイルが存在しない | `overwrite target not found: <dist/ から始まるパス>` を出力して異常終了（終了コード 0 以外） |
| 操作キーの形式が `<path>.$<op>` に合わない | `invalid overwrite op key: <キー名>` を出力して異常終了 |
| `<op>` が `append` / `remove` / `replace` / `unset` 以外 | 上記と同じ |
| `<path>` に `[` を含む | 上記と同じ |
| `<path>.$append` の `<path>` が配列でない | `overwrite append requires array at path: <path>` を出力して異常終了 |
| `<path>.$remove` の `<path>` が配列でもオブジェクトでもない | `overwrite remove requires array or object at path: <path>` を出力して異常終了 |
| `<path>.$append` / `<path>.$remove` の値が配列でない | `overwrite <op> value must be array: <キー名>` を出力して異常終了 |
| `<path>.$remove`（オブジェクト）の値の要素が文字列でない | `overwrite remove object keys must be strings: <キー名>` を出力して異常終了 |
| `<path>` がベースに存在しない（`$unset` / `$remove` / `$replace`） | 何もしない（エラーにしない） |
| `<path>` がベースに存在しない（`$append`） | 親パスが存在し値が配列ならその配列へ追加。親が存在しない、または値が配列でないときは `overwrite append path not found: <path>` を出力して異常終了 |

## 変換の組み合わせ例

Linux 実行時の `dotfiles/docker/settings-store.merge.json` は、次のように各段階のパスが決まる。

1. dist 再構築: `dist/docker/settings-store.merge.json`
2. パス移動: `dist/.docker/desktop/settings-store.merge.json`
3. merge 変換: `dist/.docker/desktop/modify_settings-store.json`
4. dot 変換: `dist/dot_docker/desktop/modify_settings-store.json`
