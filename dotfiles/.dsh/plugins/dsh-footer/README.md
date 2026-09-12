# dotfiles-dsh-footer

Browser client bundle that keeps the current session id visible in the dsh web
UI. Behavior contract: **SPEC.md** (Japanese, the review artifact).

## What it does

Registers one list entry into the `conversation.composer.dock` slot (session
scope) and renders `session: <id>` with the full, untruncated session id in
dim text (the same `--dsw-alias-label-tertiary` tone as the neighboring stock
StatsPills row). The id comes from the session-scope slot standard props
(`sessionId`), so it follows session creation/switching with no host-side
wiring, no config file, and no locale dictionaries. To disable the display,
remove the plugin from the profile — there is no ON/OFF setting by design.

## Install

Registered statically in the profile manifest: append the plugin to both
`dependencies` and `dsh.profile.bundles` in
`dotfiles/.dsh/profiles/web/package.json`, then run `chezmoi apply`. Restart
dsh afterwards (bundle patches are fixed at startup — only user-layer patches
reload live). Nothing else to configure.

## Build

The host half (`src/index.ts`) is an empty `apply` that only keeps the
`cordis.patch.yml` row loadable; `run_build.sh` builds it to `dist/index.js`
on every `chezmoi apply`, exactly like the other local plugins.

The client bundle is **not** rebuilt by `run_build.sh` (it only handles node
entries); `lib/client.js` is committed. To rebuild it after editing
`src/client/`:

```sh
cd dotfiles/.dsh/plugins/dsh-footer
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser --external react \
  --banner 'window.__ModuleLoader__.load({ id: "dotfiles-dsh-footer", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

This wraps the cjs bundle in the `window.__ModuleLoader__.load({ id, factory })`
handoff required by `@deepseek-ai/dsh-client-modules`: `react` stays an
external `require("react")` resolved through the shell's frozen module table,
and the factory returns the `{ apply, inject }` exports. No sourcemap is
generated (optional per the loader contract).

## Differences from the pi footer

This ports only the session-id line of the pi footer extension
(`dotfiles/.pi/agent/extensions.exact/footer`):

- **Placement** — the pi footer shows `session: <id>` right-aligned on its top
  line; here it sits in the composer dock (`conversation.composer.dock`),
  below the input bar, alongside the stock StatsPills row.
- **Scope** — every other pi footer item (cwd/branch, token usage, context
  usage, model, extension statuses) is out of scope.
- **Session usage totals** — the stock StatsPills already renders whole-log
  token totals and cache-hit from the `tokenUsage` projection; this plugin
  does not duplicate them.

## Unverified at runtime

The browser display has not been verified with a live dsh web session: this
is an out-of-tree client plugin registering into a stock first-party slot,
and no such registration has been exercised here yet. The first live check
should confirm that the entry appears under the composer and re-renders on
session switch.

## Development

```sh
cd dotfiles/.dsh/plugins/dsh-footer
bunx tsc --noEmit    # typecheck (global @deepseek-ai/* via tsconfig paths)
```

`@types/react` is not installed (the typecheck environment resolves only the
global `~/.bun/install/global/node_modules`); `src/types/react.d.ts` carries a
minimal ambient `react` declaration covering the `createElement` surface this
plugin uses. Delete it once `@types/react` becomes available.
