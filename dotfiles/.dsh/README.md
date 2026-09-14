# .dsh

dsh（DeepSeek Harness）関係のファイル。

## ポリシー

- dsh は **`web` プロファイルのみ**使用する。他のプロファイルは作らない・ブートしない
- プラグイン（bundle）の追加先も常に web プロファイル

## 構成

- `AGENTS.md.symlink` — `~/.dsh/AGENTS.md` への symlink。正本は `dotfiles/.agents/AGENTS.md`（pi の global 指示 `~/.pi/agent/AGENTS.md` と同一内容）。dsh 組み込みの `dsh-agent-instructions`（default 有効）が user-global 指示として各セッションの最初の request に注入する
- `plugins/` — 自作プラグイン（dsh bundle）のソース。`~/.dsh/plugins/` へ展開される。展開先は手動編集しない。エントリは TS で書き、`exports` はビルド済みの `./dist/index.js` を指す（Node は `node_modules` 内の `.ts` を実行できないため）
- `plugins/run_build.sh` — 全プラグインの一括ビルドと依存インストール（chezmoi run script。apply 時に plugins dir を CWD に、各プラグインの plugin dir 内で `bun install` し、`src/index.ts` を持つプラグインを順に `bun build` する。ビルドは mtime 条件で、`dist/index.js` より新しい `src/` のファイル（または `run_build.sh` 自身）があるときだけ再ビルドする。変更が無い apply では `dist/` が書き換わらないため、profile 側の `bun install` も再リンクなしの no-op になる。shebang は chezmoi の `exec(3)` 直接実行に必須）
- `profiles/web/run_bun_install.sh` — 依存のインストール（chezmoi run script。apply 時に profile dir を CWD で `bun install` を実行する。install の要否にかかわらず毎回、hoist された `@deepseek-ai/dsh-tools` を closure（global 実体）への symlink に張り替える。`package.json` / `bun.lock` が stamp（`node_modules/.bun-install-stamp`）より新しいときだけ install し、変更が無い apply では bun install をスキップする。bun は `file:` 依存を中身が変わらなくても毎回再リンクするため、スキップしないと毎回 `+` リストが出て数秒かかる）
- `profiles/web/package.json` — プラグイン一覧。`dependencies`（取得元）、`dsh.profile.bundles`（読み込み順）、`trustedDependencies`（lifecycle script を許可する依存）の3つを管理する
- `test/` — dsh 本体を起動せずに plugin の web UI の見た目を検証する fixture（`.chezmoiignore` で展開対象外）。詳しくは `test/README.md`

run script の実行順序は target path の辞書順。`.dsh/plugins/...` は `.dsh/profiles/...` より先にソートされるため、プラグインのビルド → プロファイルへの install 再リンクの順が保たれる。

client half（`src/client/`）を持つプラグインの browser bundle は `run_build.sh` の対象外で、`lib/client.js` をリポジトリにコミットして運用する。`src/client/` を編集したときは、そのプラグイン dir で次のコマンドで再ビルドする:

```sh
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser --external react \
  --banner 'window.__ModuleLoader__.load({ id: "<plugin id>", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

`<plugin id>` はプラグインの package name（例: `dotfiles-dsh-session-list`）。banner / footer は `@deepseek-ai/dsh-client-modules` が要求する `window.__ModuleLoader__.load({ id, factory })` handoff で、`react` は shell の frozen module table で解決する external `require("react")` のまま残す。

`~/.dsh/profiles/web/` のその他のファイル（`cordis.yml`、`cordis.patch.yml`、`bun.lock`、`node_modules`）は dsh / bun の生成物。

install は bun を使う。pnpm は `file:` 依存の copy 時に `.gitignore` を除外リストとして使うため、`dist` を `.gitignore` に書いたプラグインは `dist/` が `node_modules` に欠落し、dsh の起動が plugin ロードで失敗する。

bun は `file:` 依存を profile の `node_modules` に per-file シムリンクで入れる。Node は import 元ファイルの実パス（`~/.dsh/plugins/<plugin>/` 配下）から依存を解決するため、profile 側に hoist された依存はプラグインからは見えない。プラグインの `dependencies` は plugin dir 内の `node_modules` にインストールして初めて解決される（`run_build.sh` が apply 時に実行する）。

bun は plugin の transitive 依存を profile 直下 `node_modules` に hoist する。dsh-base は `tools` サービスの mount 時に bare specifier `@deepseek-ai/dsh-tools` を profile dir 起点で解決するため、hoist された実コピーが `~/.dsh/profiles/node_modules`（global インストールの closure）を遮蔽して `@deepseek-ai/dsh-agent-loop`（global 側）と別インスタンスになる。`TOOL_RUNTIME_SCHEDULER` は Symbol でインスタンスごとに一意のため、agent-loop の `ctx.tools[TOOL_RUNTIME_SCHEDULER]` lookup が外れ、tool 呼び出しを伴う turn がすべて `Cannot read properties of undefined (reading 'prepare')` で失敗する。`run_bun_install.sh` が install の直後に hoist されたパスを closure の実体への symlink に張り替えるのはこのため。

lifecycle script はデフォルトで実行しない。実行が必要な依存が増えたら `trustedDependencies` に追記する（現状は空で、`@google/genai` と `protobufjs` の script は実行不要と判断済み）。

## プラグインの追加・更新

1. 自作なら `plugins/` にソースを置く。プラグイン自身の依存はその `package.json` の `dependencies` に書く。リモートなら `dependencies` に spec を書く（npm: `^1.2.3`、git: `github:user/repo#main`）
2. `profiles/web/package.json` の `dependencies` と `dsh.profile.bundles` に追記
3. `chezmoi apply` が run script でプラグインをビルドし、依存をインストールする（全プラグイン一括。1 プラグインずつは不要）

- `file:` 依存（プラグイン → profile）の中身はシムリンクなので常に最新。`run_build.sh` が plugin dir の依存も apply 時に install するので手動工程はない
- リモートの範囲指定（`^1.2.3`）の最新化は profile dir で `bun update`。ピン指定（`1.2.3`）なら package.json のバージョン編集が必須
- `dsh plugin add` は内部で pnpm を呼ぶため使わない。plugin の追加・更新はこの package.json 編集 + apply で行う

## 設定の当て先

| ファイル | 役割 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | web プロファイルでの個人の上書きレイヤー。全バンドル層の後に適用される |

注意: プロファイル側の `cordis.yml`・`cordis.patch.yml` は `.yml` 固定。`.yaml` にリネームしても読まれず、空ファイルが自動再生成される。バンドル側 `package.json` の `dsh.bundle.patch` はパス宣言なので拡張子は自由。
