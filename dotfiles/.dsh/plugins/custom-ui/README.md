# dotfiles-dsh-custom-ui

dsh web UI の composer 周りを簡素化する自作 bundle plugin。挙動の契約は **SPEC.md**(レビュー対象)。

## What it does

- **既定 effort のフォールバック**(host half)— `agent/request` waterfall で、明示選択のないリクエストへ選択モデルの advertised effort の最大レベル(max → xhigh → high …、off は対象外)を積む。この bundle は `dotfiles-dsh-agents` より前に読み込まれ、`next()` 経由で class routing 後の route に効く
- **composer のモデル選択 control を非表示**(client half)— single slot `conversation.input.model` に空 occupant を後から登録して stock の ModelSelect を shadow する
- **New Session 画面の chip 行を非表示**(client half)— workspace chip と agent preset chip は内蔵要素(slot ではない)のため、`[class*="heroWorkspaceRow"]` を `display:none` にする `<style>` を注入する
- **Ctrl+K → Ctrl+M で /model popup**(client half)— document の capture keydown で chord を待ち受け、1 秒以内の Ctrl+M で現在セッションの `/model` popupSelect を `commandUi.popupFor(actx).open(...)` で開く。options/onSelect は `modelDirectories` の共有 directory から組む(実体は `/model` コマンドと同一の画面)

## Install

Registered statically in the profile manifest: add `dotfiles-dsh-custom-ui` to both `dependencies` and `dsh.profile.bundles` in `dotfiles/.dsh/profiles/web/package.json` (bundle order matters — keep it before `dotfiles-dsh-agents`, after `@deepseek-ai/dsh-web-app`), then run `chezmoi apply`. Restart dsh afterwards.

## Build

The host half (`src/index.ts`) is built to `dist/index.js` by `run_build.sh` on every `chezmoi apply`, like the other local plugins.

The client bundle is **not** rebuilt by `run_build.sh` (it only handles node entries); `lib/client.js` is committed. To rebuild it after editing `src/client/`:

```sh
cd dotfiles/.dsh/plugins/custom-ui
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser --external react \
  --banner 'window.__ModuleLoader__.load({ id: "dotfiles-dsh-custom-ui", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

The banner/footer wraps the cjs bundle in the `window.__ModuleLoader__.load({ id, factory })` handoff required by `@deepseek-ai/dsh-client-modules`, with `react` resolved through the shell's frozen module table.

## Development

```sh
cd dotfiles/.dsh/plugins/custom-ui
bunx tsc --noEmit    # typecheck (global @deepseek-ai/* via tsconfig paths)
bun test             # unit tests for the pure logic (default-effort / popup-logic)
```
