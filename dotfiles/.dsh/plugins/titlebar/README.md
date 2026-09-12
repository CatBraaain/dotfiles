# dotfiles-dsh-titlebar

Port of the pi `titlebar` extension to a dsh web client plugin.
Behavior contract: **SPEC.md** (Japanese, the review artifact).

## What it does

Keeps the browser tab title in step with the current session's agent state:
a braille spinner while the agent runs, a static `⏸` while a question /
approval / directory-picker wait is pending, and the plain title while idle.

- **Host half** (`src/index.ts`): a no-op. The web UI has no terminal title,
  so the port targets `document.title`; the host only provides the bundle row
  that makes dsh load the package.
- **Client half** (`src/client/`, prebuilt `lib/client.js`): a React-free
  controller subscribing to `ctx.sessions.list` (current selection +
  `running`) and `ctx.uiSession.pendingInteractions` (who waits on the user).
  The mark precedence is asking > running, because dsh keeps `running: true`
  during a pending question.

## Design notes

- **Base title stays stock**: dsh's `DocumentTitle`
  (`@deepseek-ai/dsh-client-ui-layout`) owns
  `{session title} — {product title}`. This plugin only writes a leading
  state mark and recognizes its own mark back out of the live title
  (`splitMarkedTitle`), so the two writers never need to agree on the base
  string. A stock rewrite during a marked state is corrected within one
  spinner tick (100 ms); while idle the plugin writes at most once per
  transition.
- **No React / no slots**: both state sources are plain snapshot
  observables (`ObservableSnapshot`), so the controller runs on bare
  subscriptions with an injectable clock/timer/title host (unit-tested).
  `ctx.effect` ties the controller's teardown (unsubscribe, timer, title
  restore) to the plugin fiber.
- **Scope**: the currently selected session only (`list.current`), matching
  the stock title's scope. Other sessions' state never leaks into the title.

## Install

Registered statically in the profile manifest: append the plugin to both
`dependencies` and `dsh.profile.bundles` in
`dotfiles/.dsh/profiles/web/package.json`, then run `chezmoi apply`. Restart
dsh afterwards (bundle patches are fixed at startup). Nothing else to
configure.

## Build

`run_build.sh` rebuilds `dist/index.js` on every `chezmoi apply`; the client
bundle is not rebuilt by it — `lib/client.js` is committed. To rebuild it
after editing `src/client/`:

```sh
cd dotfiles/.dsh/plugins/titlebar
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser --external react \
  --banner 'window.__ModuleLoader__.load({ id: "dotfiles-dsh-titlebar", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

This wraps the cjs bundle in the `window.__ModuleLoader__.load({ id, factory })`
handoff required by `@deepseek-ai/dsh-client-modules`. The bundle keeps
`react` external even though it never imports it, matching the committed
pattern of the other client halves.

## Differences from the pi titlebar

- **Surface** — pi wrote the terminal title via `ctx.ui.setTitle()` in TUI
  mode only; dsh has no TUI profile and no title API, so the equivalent
  surface is the browser tab title.
- **Base title** — pi rendered `π - {session name}` itself; here the base
  (`{session title} — {product title}`) stays owned by dsh and only the mark
  is added.
- **Input wait detection** — pi used `ui_prompt_start` / `ui_prompt_end`
  events; dsh has no such pair, so the wait state comes from the pending
  interactions snapshot (`SessionPendingInteraction`), covering question,
  plan-review, approval, and directory-picker waits uniformly.
- **Spinner source** — pi toggled on `agent_start` / `agent_end`; here the
  running flag is the session list snapshot (`SessionSummary.running`), the
  same fact source the stock sidebar dot uses.
- **Scope** — pi was single-session by construction; here only the currently
  selected session is reflected, other sessions are ignored.

## Unverified at runtime

The browser tab title has not been verified with a live dsh session: the
controller follows stock first-party patterns (`ctx.sessions` /
`ctx.uiSession` snapshot observables, per their `.d.ts` contracts), and
`bunx tsc` / `bun test` / `bun build` all pass, but no live dsh run has
exercised them yet.

## Development

```sh
cd dotfiles/.dsh/plugins/titlebar
bunx tsc --noEmit    # typecheck (global @deepseek-ai/* via tsconfig paths)
bun test             # unit tests (pure logic only; no dsh runtime needed)
```

No `@types/react` is needed: the client half imports nothing from React.
`src/types/bun-test.d.ts` is the ambient shim for the tests, mirroring the
other plugins.
