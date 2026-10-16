# .dsh

dsh（DeepSeek Harness）関係のファイル。

## ポリシー

- dsh は **`web` プロファイルのみ**使用する。他のプロファイルは作らない・ブートしない
- プラグイン（bundle）の追加先も常に webプロファイル

## 構成

- `AGENTS.md.symlink` — `~/.dsh/AGENTS.md` への symlink。正本は `dotfiles/.agents/AGENTS.md`（pi の global指示 `~/.pi/agent/AGENTS.md` と同一内容）。dsh組み込みの `dsh-agent-instructions`（default有効）が user-global指示として各セッションの最初の request に注入する
- `config/` — `~/.agents/config/` にある共有agent / sandbox設定への symlink
- `plugins.exact/` — 自作プラグイン（dsh bundle）のソース。`~/.dsh/plugins/` へ展開される。`exact` 属性付きのためplugins dir直下の source管理外エントリ（旧 `run_build.sh` など）は apply時に削除される。展開先は手動編集しない。エントリは TS で書き、`exports` はビルド済みの `./dist/index.js` を指す（Node は `node_modules` 内の `.ts` を実行できないため）
- `plugins.exact/build.apply.ts` — 全プラグインの build と依存install（dotfiles の apply hook。plugins dir を CWD として実行される。各plugin の `node_modules/.bun-install-stamp` がない、または `package.json`・`bun.lock`（または `bun.lockb`）が stamp より新しい場合だけ plugin dir内で `bun install` し、成功後に stamp を更新する。`dist/index.js` がないか、`src/` 配下のファイル（`*.test.ts` を除く）が出力より新しいplugin だけ `bun build` する。plugin dir内の `dist/`・`node_modules/` は exact の掃除対象外である）
- `plugins.exact/build.spec.md` — `build.apply.ts` の install と bundle build の振る舞い仕様
- `profiles/web/dsh_plugin_install.apply.ts` — dsh CLI による依存のインストール（dotfiles の apply hook。profile dir を CWD として `dsh plugin --profile web install --ignore-scripts` を実行する。stamp（`node_modules/.dsh-plugin-install-stamp`）が無い、または `package.json` / `pnpm-lock.yaml` が stamp より新しいときだけ実行してstamp を更新し、変更が無いapply ではインストールをスキップする。`package.json` が stamp より新しいとき（stamp が無いときを含む）は、hoisted な `node_modules` への残留・混在を避けるため先に `node_modules` を削除してclean installする。dsh CLI は profile dir で pnpm を実行し、成功後に `dsh.profile.bundles` を依存状態へ同期する）
- `profiles/web/package.json` — プラグイン一覧。`dependencies`（取得元）、`dsh.profile.bundles`（読み込み順）、`trustedDependencies`（lifecycle script を許可する依存）の3つを管理する
- `profiles/web/pnpm-workspace.yaml` — dsh CLI の profile依存解決設定。`nodeLinker: hoisted` と `autoInstallPeers: false` により、framework の peer import を shared fallback へ解決する
- `test/` — dsh本体を起動せずに plugin の web UI の見た目を検証するfixture（`remap.data.md` で展開対象外）。詳しくは `test/README.md`

apply hook は全ターゲットの適用後に実行される。ビルド（`build.apply.ts`）は適用後のため、plugin の `src/` が全て展開されてから bundleされる。profile の `dsh_plugin_install.apply.ts` による依存インストールはビルドに後続する。`file:` 依存はビルド後の plugin package を pnpm が profile の package tree に配置するため、順序は問題にならない。

client half（`src/client/`）を持つプラグインの browser bundle は `build.apply.ts` の対象外で、`lib/client.js` をリポジトリにコミットして運用する。`src/client/` を編集したときは、そのプラグインdir で次のコマンドで再ビルドする:

```sh
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser \
  --external react --external '@deepseek-ai/*' \
  --banner 'window.__ModuleLoader__.load({ id: "<plugin id>", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

`<plugin id>` はプラグインの package name（例: `dotfiles-dsh-session-list`）。banner / footer は `@deepseek-ai/dsh-client-modules` が要求する `window.__ModuleLoader__.load({ id, factory })` handoff で、`react` と `@deepseek-ai/*` は shell の frozen module table で解決するexternal `require(...)` のまま残す。`@deepseek-ai/*` を external にするのは、client bundle に npm の `@deepseek-ai/*` 実体を inlineすると primitives の markdown / shiki依存（dynamic import と CSS import）まで bundleされplugin の devDependencies では解決できず、ビルドが失敗するため。実行時の解決は shell が先に load済みの bundle（`dsh-client-ui-primitives` は `dsh-client-ui-sidebar` が requireする）に依存する。

`~/.dsh/profiles/web/` のその他のファイル（`cordis.yml`、`cordis.patch.yml`、`pnpm-lock.yaml`、`node_modules`）は dsh / pnpm の生成物。

profile の依存管理は公式CLI に合わせ、`dsh plugin --profile web install --ignore-scripts` を使う。これは profile dir で pnpm を実行し、`pnpm-workspace.yaml` の `nodeLinker: hoisted` / `autoInstallPeers: false` 設定により dsh framework の peer import を `$DSH_HOME/profiles/node_modules` の共有fallback へ解決させる。`--ignore-scripts` により依存の lifecycle script は実行しない。plugin のソースから `dist/` を生成する処理と、plugin自身の build依存を入れる処理には既存どおりBun を使う。

`file:` 依存は dsh CLI が profile の package tree に配置する。local plugin の `.gitignore` では `dist/` を除外しないため、pnpm の copy後も build成果物が残る。plugin が dsh の framework package（service を提供する `@deepseek-ai/*`）を `dependencies` に書くと、その実体が profile直下へ hoistされ、global側と別module instance になる。`TOOL_RUNTIME_SCHEDULER` のような Symbol は instanceごとに一意のため、service の lookup が外れて `Cannot read properties of undefined (reading 'prepare')` のような tool実行時エラーになる。これを避けるためframework package は `peerDependencies`（typecheck・build用に同じものを `devDependencies` にも）に書き、`pnpm-workspace.yaml` の `autoInstallPeers: false` 設定により Node の親ディレクトリ探索で `$DSH_HOME/profiles/node_modules` の共有fallback から解決させる。plugin のソースと build依存は `build.apply.ts` が管理する。

lifecycle script はデフォルトで実行しない。実行が必要な依存が増えたら `trustedDependencies` に追記する（現状は空で、`@google/genai` と `protobufjs` の script は実行不要と判断済み）。

## プラグインの追加・更新

1. 自作なら `plugins.exact/` にソースを置く。プラグイン自身の依存のうち、dsh の framework package（service を提供する `@deepseek-ai/*`）は `peerDependencies` に書き、typecheck・build用に同じ範囲指定を `devDependencies` にも書く。それ以外の通常library（`yaml`、`schemastery` 等）は `dependencies` に書く。リモート依存は `dependencies` に spec を書く（npm: `^1.2.3`、git: `github:user/repo#main`）
2. dotfiles で管理するplugin は `profiles/web/package.json` の `dependencies` と `dsh.profile.bundles` に追記する
3. `just apply` が dotfiles の apply hook で plugin をビルドし、`dsh plugin --profile web install --ignore-scripts` で profile の依存をインストールする（全plugin一括。1 pluginずつは不要）

- `file:` 依存は profile の package tree に配置される。`build.apply.ts` が plugin dir の build と依存install を apply時に行うので手動工程はない
- リモート依存を dsh CLI で一時的に追加・更新する場合は `dsh plugin --profile web add <package>` / `dsh plugin --profile web update <package>` を使う。ただし dotfiles の `package.json` が正本なので、永続化する変更は source に反映する
- リモートの範囲指定（`^1.2.3`）の最新化は `dsh plugin --profile web update`。ピン指定（`1.2.3`）なら package.json のバージョン編集が必須

## 設定の当て先

| ファイル | 役割 |
| --- | --- |
| `~/.dsh/profiles/web/cordis.patch.yml` | webプロファイルでの個人の上書きレイヤー。全バンドル層の後に適用される |

注意: プロファイル側の `cordis.yml`・`cordis.patch.yml` は `.yml` 固定。`.yaml` にリネームしても読まれず、空ファイルが自動再生成される。バンドル側 `package.json` の `dsh.bundle.patch` はパス宣言なので拡張子は自由。
