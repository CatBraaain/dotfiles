# .dsh

dsh（DeepSeek Harness）関係のファイル。

## ポリシー

- dsh は **`web` プロファイルのみ**使用する。他のプロファイルは作らない・ブートしない
- プラグイン（bundle）の追加先も常に web プロファイル

## 構成

- `plugins/` — 自作プラグイン（dsh bundle）のソース。`~/.dsh/plugins/` へ展開される。展開先は手動編集しない。エントリは TS で書き、`exports` はビルド済みの `./dist/index.js` を指す（Node は `node_modules` 内の `.ts` を実行できないため）
- `plugins/run_build.sh` — 全プラグインの一括ビルド（chezmoi run script。apply 時に plugins dir を CWD に `src/index.ts` を持つプラグインを順に `bun build` する。shebang は chezmoi の `exec(3)` 直接実行に必須）
- `profiles/web/package.json` — プラグイン一覧。`dependencies`（取得元）と `dsh.profile.bundles`（読み込み順）の**両方**に書く
- `profiles/web/run_pnpm_install.sh` — 依存のインストール（chezmoi run script。apply 時に profile dir を CWD に自動実行される）
- `profiles/web/pnpm-workspace.merge.yaml` — `~/.dsh/profiles/web/pnpm-workspace.yaml` の merge レイヤー。pre-chezmoi がホーム現状（dsh / pnpm が書いた base 設定や pnpm が scaffold したエントリ）にこのレイヤーを合成し、chezmoi 管理の完成形を作る

run script の実行順序は target path の辞書順。`.dsh/plugins/...` は `.dsh/profiles/...` より先にソートされるため、プラグインのビルド → プロファイルへの install 再リンクの順が保たれる。

`~/.dsh/profiles/web/` のその他のファイル（`cordis.yml`、`cordis.patch.yml`、`pnpm-lock.yaml`、`node_modules`）は dsh / pnpm の生成物。

build script を持つ依存が増えると pnpm が `pnpm-workspace.yaml` へ placeholder 付きでエントリを scaffold し、未判断のままでは install がエラーになる。判断したら `pnpm-workspace.merge.yaml` の `allowBuilds` に `true` / `false` で追記する（レイヤー優先は merge > ホーム）。

## プラグインの追加・更新

1. 自作なら `plugins/` にソースを置く。リモートなら `dependencies` に spec を書く（npm: `^1.2.3`、git: `github:user/repo#main`）
2. `profiles/web/package.json` の `dependencies` と `dsh.profile.bundles` に追記
3. `chezmoi apply` が run script でプラグインをビルドし、依存をインストールする（全プラグイン一括。1 プラグインずつは不要）

- `file:` は install 時のスナップショットのため、プラグインのソース更新後は script を再実行する。自作プラグインは apply 時にビルド → install が自動で走るので手動工程はない
- リモートの範囲指定（`^1.2.3`）の最新化は profile dir で `pnpm update`。ピン指定（`1.2.3`）なら package.json のバージョン編集が必須

## 設定の当て先

| ファイル | 役割 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | web プロファイルでの個人の上書きレイヤー。全バンドル層の後に適用される |

注意: プロファイル側の `cordis.yml`・`cordis.patch.yml` は `.yml` 固定。`.yaml` にリネームしても読まれず、空ファイルが自動再生成される。バンドル側 `package.json` の `dsh.bundle.patch` はパス宣言なので拡張子は自由。
