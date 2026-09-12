# .dsh

dsh（DeepSeek Harness）関係のファイル。

## ポリシー

- dsh は **`web` プロファイルのみ**使用する。他のプロファイルは作らない・ブートしない
- プラグイン（bundle）の追加先も常に web プロファイル

## 構成

- `plugins/` — 自作プラグイン（dsh bundle）のソース。`~/.dsh/plugins/` へ展開される。展開先は手動編集しない。エントリは TS で書き、`exports` はビルド済みの `./dist/index.js` を指す（Node は `node_modules` 内の `.ts` を実行できないため）
- `plugins/run_build.sh` — 全プラグインの一括ビルド（chezmoi run script。apply 時に plugins dir を CWD に `src/index.ts` を持つプラグインを順に `bun build` する。shebang は chezmoi の `exec(3)` 直接実行に必須）
- `profiles/web/package.json` — プラグイン一覧。`dependencies`（取得元）と `dsh.profile.bundles`（読み込み順）の**両方**に書く
- `profiles/web/run_bun_install.sh` — 依存のインストール（chezmoi run script。apply 時に profile dir を CWD に `bun install` を実行する）
- `profiles/web/package.json` — プラグイン一覧。`dependencies`（取得元）、`dsh.profile.bundles`（読み込み順）、`trustedDependencies`（lifecycle script を許可する依存）の3つを管理する

run script の実行順序は target path の辞書順。`.dsh/plugins/...` は `.dsh/profiles/...` より先にソートされるため、プラグインのビルド → プロファイルへの install 再リンクの順が保たれる。

`~/.dsh/profiles/web/` のその他のファイル（`cordis.yml`、`cordis.patch.yml`、`bun.lock`、`node_modules`）は dsh / bun の生成物。

install は bun を使う。pnpm は `file:` 依存の copy 時に `.gitignore` を除外リストとして使うため、`dist` を `.gitignore` に書いたプラグインは `dist/` が `node_modules` に欠落し、dsh の起動が plugin ロードで失敗する。bun は `.gitignore` を参照せず、再 install で常に node_modules をソースと再同期する。

lifecycle script はデフォルトで実行しない。実行が必要な依存が増えたら `trustedDependencies` に追記する（現状は空で、`@google/genai` と `protobufjs` の script は実行不要と判断済み）。

## プラグインの追加・更新

1. 自作なら `plugins/` にソースを置く。リモートなら `dependencies` に spec を書く（npm: `^1.2.3`、git: `github:user/repo#main`）
2. `profiles/web/package.json` の `dependencies` と `dsh.profile.bundles` に追記
3. `chezmoi apply` が run script でプラグインをビルドし、依存をインストールする（全プラグイン一括。1 プラグインずつは不要）

- `file:` 依存は install を実行した時点のディレクトリ内容が copy される。`bun install` を再実行すれば常に最新に同期される（apply 時はビルド → install の順で自動で走るので手動工程はない）
- リモートの範囲指定（`^1.2.3`）の最新化は profile dir で `bun update`。ピン指定（`1.2.3`）なら package.json のバージョン編集が必須
- `dsh plugin add` は内部で pnpm を呼ぶため使わない。plugin の追加・更新はこの package.json 編集 + apply で行う

## 設定の当て先

| ファイル | 役割 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | web プロファイルでの個人の上書きレイヤー。全バンドル層の後に適用される |

注意: プロファイル側の `cordis.yml`・`cordis.patch.yml` は `.yml` 固定。`.yaml` にリネームしても読まれず、空ファイルが自動再生成される。バンドル側 `package.json` の `dsh.bundle.patch` はパス宣言なので拡張子は自由。
