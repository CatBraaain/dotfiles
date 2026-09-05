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

## 1. dist 再構築

`dist/` を削除し、`dotfiles/` の完全なコピーとして作り直す。前回実行で `dist/` にあった内容は残らない。

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

## 3. overwrite 変換

`dist/` 内のすべての `*.overwrite.json` / `*.overwrite.yaml`（深さは問わない）を、同階層のベースファイル（ファイル名から `.overwrite` を除いたもの）へ深くマージし、overwrite ファイルは削除する。

マージの規則: 同じキーが両方でプレーンオブジェクトのときだけ再帰し、それ以外（スカラー・配列・オブジェクトと非オブジェクトの組合せ）は overwrite 側の値で丸ごと置き換える。片側にだけあるキーの値は維持する。

```
dotfiles/.foo/settings.json            {"a":1,"nested":{"x":1,"y":2},"list":[1,2]}
dotfiles/.foo/settings.overwrite.json  {"nested":{"y":9,"z":3},"list":[3]}

→ dist/.foo/settings.json = {"a":1,"nested":{"x":1,"y":9,"z":3},"list":[3]}
  overwrite ファイルは dist に存在しない
```

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

## エラー

| 条件 | 振る舞い |
| --- | --- |
| overwrite 変換でベースファイルが存在しない | `overwrite target not found: <dist/ から始まるパス>` を出力して異常終了（終了コード 0 以外） |

## 変換の組み合わせ例

Linux 実行時の `dotfiles/docker/settings-store.merge.json` は、次のように各段階のパスが決まる。

1. dist 再構築: `dist/docker/settings-store.merge.json`
2. パス移動: `dist/.docker/desktop/settings-store.merge.json`
3. merge 変換: `dist/.docker/desktop/modify_settings-store.json`
4. dot 変換: `dist/dot_docker/desktop/modify_settings-store.json`
