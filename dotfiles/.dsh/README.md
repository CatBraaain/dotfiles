# .dsh

dsh（DeepSeek Harness）関係のファイル。

## ポリシー

- dsh は **`web` プロファイルのみ**使用する。他のプロファイルは作らない・ブートしない
- プラグイン（bundle）の追加先も常に web プロファイル

## 構成

- `AGENTS.md.symlink` — `~/.dsh/AGENTS.md` への symlink。正本は `dotfiles/.agents/AGENTS.md`（pi の global 指示 `~/.pi/agent/AGENTS.md` と同一内容）。dsh 組み込みの `dsh-agent-instructions`（default 有効）が user-global 指示として各セッションの最初の request に注入する
- `config/` — `~/.agents/config/` にある共有 agent / sandbox 設定への symlink
- `plugins.exact/` — 自作プラグイン（dsh bundle）のソース。`~/.dsh/plugins/` へ展開される。`exact` 属性付きのため plugins dir 直下の source 管理外エントリ（旧 `run_build.sh` など）は apply 時に削除される。展開先は手動編集しない。エントリは TS で書き、`exports` はビルド済みの `./dist/index.js` を指す（Node は `node_modules` 内の `.ts` を実行できないため）
- `plugins.exact/run_after_build.sh` — 全プラグインの build と依存 install（chezmoi run script。`run_after_` により全ターゲットの適用後に plugins dir を CWD として実行される。各 plugin の依存を plugin dir 内へ `bun install` し、`dist/index.js` がないか、`src/` 配下のファイル（`*.test.ts` を除く）が出力より新しい plugin だけ `bun build` する。plugin dir 内の `dist/`・`node_modules/` は exact の掃除対象外である。shebang は chezmoi の `exec(3)` 直接実行に必須）
- `profiles/web/run_after_dsh_plugin_install.sh` — 外部プラグインの自動導入（chezmoi run script。`run_after_` 修飾子により全ターゲットの適用後に profile dir を CWD として、Codex Auth、CommandCode provider UI、CommandCode provider の `dsh plugin --profile web add --force --ignore-scripts` を毎回実行する。いずれかが失敗した場合は apply を失敗させる。dsh CLI は profile dir で pnpm を実行し、成功後に `dsh.profile.bundles` を依存状態へ同期する）
- `profiles/web/package.json` — 静的に管理するプラグインの依存と読み込み順。`dependencies`（取得元）、`dsh.profile.bundles`（読み込み順）、`trustedDependencies`（lifecycle script を許可する依存）の3つを管理する。毎回更新する外部プラグインは run script を正本とする
- `profiles/web/pnpm-workspace.yaml` — dsh CLI の profile 依存解決設定。`nodeLinker: hoisted` と `autoInstallPeers: false` により、framework の peer import を shared fallback へ解決する
- `test/` — dsh 本体を起動せずに plugin の web UI の見た目を検証する fixture（`.chezmoiignore` で展開対象外）。詳しくは `test/README.md`

通常の run script は target path の辞書順で apply の途中に実行され、`run_after_` 付きは全ターゲットの適用後に実行される。ビルド（`run_after_build.sh`）は after で実行するため、plugin の `src/` が全て展開されてから bundle される。profile の `run_after_dsh_plugin_install.sh` による外部プラグイン追加はビルドに後続する。`file:` 依存はビルド後の plugin package を pnpm が profile の package tree に配置するため、順序は問題にならない。

client half（`src/client/`）を持つプラグインの browser bundle は `run_after_build.sh` の対象外で、`lib/client.js` をリポジトリにコミットして運用する。`src/client/` を編集したときは、そのプラグイン dir で次のコマンドで再ビルドする:

```sh
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser \
  --external react --external '@deepseek-ai/*' \
  --banner 'window.__ModuleLoader__.load({ id: "<plugin id>", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

`<plugin id>` はプラグインの package name（例: `dotfiles-dsh-session-list`）。banner / footer は `@deepseek-ai/dsh-client-modules` が要求する `window.__ModuleLoader__.load({ id, factory })` handoff で、`react` と `@deepseek-ai/*` は shell の frozen module table で解決する external `require(...)` のまま残す。`@deepseek-ai/*` を external にするのは、client bundle に npm の `@deepseek-ai/*` 実体を inline すると primitives の markdown / shiki 依存（dynamic import と CSS import）まで bundle され plugin の devDependencies では解決できず、ビルドが失敗するため。実行時の解決は shell が先に load 済みの bundle（`dsh-client-ui-primitives` は `dsh-client-ui-sidebar` が require する）に依存する。

`~/.dsh/profiles/web/` のその他のファイル（`cordis.yml`、`cordis.patch.yml`、`pnpm-lock.yaml`、`node_modules`）は dsh / pnpm の生成物。

profile の依存管理は公式 CLI に合わせる。`run_after_dsh_plugin_install.sh` は profile dir で `dsh plugin --profile web add --force --ignore-scripts` を実行して外部プラグインを毎回更新する。これは内部で pnpm を実行し、`pnpm-workspace.yaml` の `nodeLinker: hoisted` / `autoInstallPeers: false` 設定により dsh framework の peer import を `$DSH_HOME/profiles/node_modules` の共有 fallback へ解決させる。`--force` により外部プラグインの既存インストールを再評価し、`--ignore-scripts` により依存のlifecycle scriptを実行しない。plugin のソースから `dist/` を生成する処理と、plugin 自身の build 依存を入れる処理には既存どおり Bun を使う。

`file:` 依存は dsh CLI が profile の package tree に配置する。local plugin の `.gitignore` では `dist/` を除外しないため、pnpm の copy 後も build 成果物が残る。dsh 本体の framework package は profile 直下に別実体として hoist されず、`pnpm-workspace.yaml` の設定により Node の親ディレクトリ探索で `$DSH_HOME/profiles/node_modules` の共有 fallback から解決される。plugin のソースと build 依存は `run_after_build.sh` が管理する。

lifecycle script はデフォルトで実行しない。実行が必要な依存が増えたら `trustedDependencies` に追記する（現状は空で、`@google/genai` と `protobufjs` の script は実行不要と判断済み）。

## プラグインの追加・更新

1. 自作なら `plugins.exact/` にソースを置く。プラグイン自身の依存はその `package.json` の `dependencies` に書く
2. 静的に管理する plugin は `profiles/web/package.json` の `dependencies` と `dsh.profile.bundles` に追記する
3. 毎回更新する外部 plugin は `profiles/web/run_after_dsh_plugin_install.sh` に `dsh plugin --profile web add --force --ignore-scripts` を追加する。外部 plugin の依存宣言は package.json に重複記載しない
4. `chezmoi apply` が run script で自作 plugin をビルドし、profile の run script で外部 plugin を追加・更新する

- `file:` 依存は profile の package tree に配置される。`run_after_build.sh` が plugin dir の build を apply 時に行うので手動工程はない
- `dsh plugin --profile web add` は profile dir で pnpm を実行し、成功後に bundle を依存状態へ同期する
- 外部 plugin は最新版取得を優先するため、profile の固定lockfileだけでは更新を抑制しない

## 設定の当て先

| ファイル | 役割 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | web プロファイルでの個人の上書きレイヤー。全バンドル層の後に適用される |

注意: プロファイル側の `cordis.yml`・`cordis.patch.yml` は `.yml` 固定。`.yaml` にリネームしても読まれず、空ファイルが自動再生成される。バンドル側 `package.json` の `dsh.bundle.patch` はパス宣言なので拡張子は自由。
