# .dsh

dsh（DeepSeek Harness）関係のファイル。

## ポリシー

- dsh は **`web` プロファイルのみ**使用する。他のプロファイルは作らない・ブートしない
- プラグイン（bundle）の追加先も常に web プロファイル

## 構成

- `AGENTS.md.symlink` — `~/.dsh/AGENTS.md` への symlink。正本は `dotfiles/.agents/AGENTS.md`（pi の global 指示 `~/.pi/agent/AGENTS.md` と同一内容）。dsh 組み込みの `dsh-agent-instructions`（default 有効）が user-global 指示として各セッションの最初の request に注入する
- `plugins.exact/` — 自作プラグイン（dsh bundle）のソース。`~/.dsh/plugins/` へ展開される。`exact` 属性付きのため plugins dir 直下の source 管理外エントリ（旧 `run_build.sh` など）は apply 時に削除される。展開先は手動編集しない。エントリは TS で書き、`exports` はビルド済みの `./dist/index.js` を指す（Node は `node_modules` 内の `.ts` を実行できないため）
- `plugins.exact/run_after_build.sh` — 全プラグインの build と依存 install（chezmoi run script。`run_after_` により全ターゲットの適用後に plugins dir を CWD として実行される。各 plugin の依存を plugin dir 内へ `bun install` し、`dist/index.js` がないか、`src/` 配下のファイル（`*.test.ts` を除く）が出力より新しい plugin だけ `bun build` する。plugin dir 内の `dist/`・`node_modules/` は exact の掃除対象外である。shebang は chezmoi の `exec(3)` 直接実行に必須）
- `profiles/web/run_after_bun_install.sh` — 依存のインストール（chezmoi run script。`run_after_` 修飾子により全ターゲットの適用後に profile dir を CWD で `bun install --ignore-scripts` を実行する。stamp（`node_modules/.bun-install-stamp`）が無い、または `package.json` / `bun.lock` が stamp より新しいときだけ install して stamp を更新し、変更が無い apply では bun install をスキップする。bun は `file:` 依存を中身が変わらなくても毎回再リンクするため、スキップしないと毎回 `+` リストが出て数秒かかる）
- `profiles/web/package.json` — プラグイン一覧。`dependencies`（取得元）、`dsh.profile.bundles`（読み込み順）、`trustedDependencies`（lifecycle script を許可する依存）の3つを管理する
- `test/` — dsh 本体を起動せずに plugin の web UI の見た目を検証する fixture（`.chezmoiignore` で展開対象外）。詳しくは `test/README.md`

通常の run script は target path の辞書順で apply の途中に実行され、`run_after_` 付きは全ターゲットの適用後に実行される。ビルド（`run_after_build.sh`）は after で実行するため、plugin の `src/` が全て展開されてから bundle される。profile の `run_after_bun_install.sh` による依存インストールはビルドに後続するが（after フェイズ内では target path 順で plugins/ のビルドが先）、`file:` 依存は per-file シムリンクで中身を常に最新に見せるため順序は問題にならない。

client half（`src/client/`）を持つプラグインの browser bundle は `run_after_build.sh` の対象外で、`lib/client.js` をリポジトリにコミットして運用する。`src/client/` を編集したときは、そのプラグイン dir で次のコマンドで再ビルドする:

```sh
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser \
  --external react --external '@deepseek-ai/*' \
  --banner 'window.__ModuleLoader__.load({ id: "<plugin id>", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

`<plugin id>` はプラグインの package name（例: `dotfiles-dsh-session-list`）。banner / footer は `@deepseek-ai/dsh-client-modules` が要求する `window.__ModuleLoader__.load({ id, factory })` handoff で、`react` と `@deepseek-ai/*` は shell の frozen module table で解決する external `require(...)` のまま残す。`@deepseek-ai/*` を external にするのは、client bundle に npm の `@deepseek-ai/*` 実体を inline すると primitives の markdown / shiki 依存（dynamic import と CSS import）まで bundle され plugin の devDependencies では解決できず、ビルドが失敗するため。実行時の解決は shell が先に load 済みの bundle（`dsh-client-ui-primitives` は `dsh-client-ui-sidebar` が require する）に依存する。

`~/.dsh/profiles/web/` のその他のファイル（`cordis.yml`、`cordis.patch.yml`、`bun.lock`、`node_modules`）は dsh / bun の生成物。

install は bun を使う。pnpm は `file:` 依存の copy 時に `.gitignore` を除外リストとして使うため、`dist` を `.gitignore` に書いたプラグインは `dist/` が `node_modules` に欠落し、dsh の起動が plugin ロードで失敗する。

bun は `file:` 依存を profile の `node_modules` に per-file シムリンクで入れる。Node は import 元ファイルの実パス（`~/.dsh/plugins/<plugin>/` 配下）から依存を解決するため、profile 側に hoist された依存はプラグインからは見えない。プラグインの `dependencies` は plugin dir 内の `node_modules` にインストールして初めて解決される（`run_after_build.sh` が apply 時に実行する）。

bun は plugin の transitive 依存を profile 直下 `node_modules` に hoist する。dsh-base は `tools` サービスの mount 時に bare specifier `@deepseek-ai/dsh-tools` を profile dir 起点で解決するため、hoist された実コピーが `~/.dsh/profiles/node_modules`（global インストールの closure）を遮蔽して `@deepseek-ai/dsh-agent-loop`（global 側）と別インスタンスになる。`TOOL_RUNTIME_SCHEDULER` は Symbol でインスタンスごとに一意のため、agent-loop の `ctx.tools[TOOL_RUNTIME_SCHEDULER]` lookup が外れ、tool 呼び出しを伴う turn がすべて `Cannot read properties of undefined (reading 'prepare')` で失敗する。`run_after_bun_install.sh` は依存インストールのみを行い、この hoisted path の symlink 修正は行わない。

lifecycle script はデフォルトで実行しない。実行が必要な依存が増えたら `trustedDependencies` に追記する（現状は空で、`@google/genai` と `protobufjs` の script は実行不要と判断済み）。

## プラグインの追加・更新

1. 自作なら `plugins.exact/` にソースを置く。プラグイン自身の依存はその `package.json` の `dependencies` に書く。リモートなら `dependencies` に spec を書く（npm: `^1.2.3`、git: `github:user/repo#main`）
2. `profiles/web/package.json` の `dependencies` と `dsh.profile.bundles` に追記
3. `chezmoi apply` が run script でプラグインをビルドし、依存をインストールする（全プラグイン一括。1 プラグインずつは不要）

- `file:` 依存（プラグイン → profile）の中身はシムリンクなので常に最新。`run_after_build.sh` が plugin dir の依存も apply 時に install するので手動工程はない
- リモートの範囲指定（`^1.2.3`）の最新化は profile dir で `bun update`。ピン指定（`1.2.3`）なら package.json のバージョン編集が必須
- `dsh plugin add` は内部で pnpm を呼ぶため使わない。plugin の追加・更新はこの package.json 編集 + apply で行う

## 設定の当て先

| ファイル | 役割 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | web プロファイルでの個人の上書きレイヤー。全バンドル層の後に適用される |

注意: プロファイル側の `cordis.yml`・`cordis.patch.yml` は `.yml` 固定。`.yaml` にリネームしても読まれず、空ファイルが自動再生成される。バンドル側 `package.json` の `dsh.bundle.patch` はパス宣言なので拡張子は自由。
