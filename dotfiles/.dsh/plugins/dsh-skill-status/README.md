# dotfiles-dsh-skill-status

Port of the pi `skill-status` extension to a dsh host + web client plugin.
Behavior contract: **SPEC.md** (Japanese, the review artifact).

## What it does

Keeps the names of successfully used skills visible above the composer:
`🎯 skills: <name>, <name>` in gray, first-use order, clipped with an
ellipsis, hidden while no skill has been used yet.

- **Host half** (`src/index.ts`): watches every live session's `skill` tool
  (`tool/call` / `tool/result` session events) and appends one log-only
  `skill-status/used` event `{ name }` per first successful use — deferred to
  a microtask because `session.append` cannot re-enter the open
  `session/event` publication window. On the first event seen for a session,
  the tracker seeds itself from the logged prefix, so a host restart
  mid-session neither double-appends nor loses an in-flight `skill` call.
  Event type and payload are declared by declaration merge into
  `SessionEventMap`, the same pattern `dsh-hook-protocol` uses for `hook/*`.
- **Client half** (`src/client/`, prebuilt `lib/client.js`): registers a
  Conversation Definition folding `skill-status/used` events — history pages
  included — into a `skill-status` view-target snapshot, and one
  `conversation.input.dock` entry rendering it via `useSyncExternalStore`.
  Sessions are independent by construction: the events are session-scoped,
  so switching sessions switches the display and an untouched session shows
  nothing.

## Install

Registered statically in the profile manifest: append the plugin to both
`dependencies` and `dsh.profile.bundles` in
`dotfiles/.dsh/profiles/web/package.json`, then run `chezmoi apply`. Restart
dsh afterwards (bundle patches are fixed at startup). Nothing else to
configure.

## Build

The host entry must stay a **single self-contained module**: `run_build.sh`
builds each plugin with `--external '*'`, which externalizes relative imports
too, so a multi-file entry would emit a broken `dist/index.js` that still
imports `./something.ts`. (`dsh-agents` and `model-sync` currently have
exactly that latent breakage; `bun build --packages=external` would fix
them.) `run_build.sh` rebuilds `dist/index.js` on every `chezmoi apply`.

The client bundle is **not** rebuilt by `run_build.sh` (it only handles node
entries); `lib/client.js` is committed. To rebuild it after editing
`src/client/`:

```sh
cd dotfiles/.dsh/plugins/dsh-skill-status
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser --external react \
  --banner 'window.__ModuleLoader__.load({ id: "dotfiles-dsh-skill-status", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

This wraps the cjs bundle in the `window.__ModuleLoader__.load({ id, factory })`
handoff required by `@deepseek-ai/dsh-client-modules`: `react` stays an
external `require("react")` resolved through the shell's frozen module table,
and the factory returns the `{ apply, inject }` exports.

The event-type literal is duplicated between the host entry and
`src/client/event.ts` (the host must not import relative modules); a unit
test pins the two literals equal.

## Differences from the pi skill-status

- **Success definition** — pi inspects `read` tool results for skill paths
  and explicit `/skill:` commands; here the `skill` tool's own
  success/failure (`tool/result` `error` / `isError`) decides. A skill name
  merely mentioned in a message still changes nothing.
- **Explicit commands** — dsh normalizes `/skill:<name>` gestures into the
  same `skill` tool path, so explicit and automatic uses are recorded
  identically; pi additionally tracked the command form before the tool ran.
- **Event envelope** — `skill-status/used` is an out-of-repo plugin event
  outside dsh's `KNOWN_SESSION_EVENT_TYPES`. The current build's read path
  accepts it, but `Session.append` cannot stamp the envelope's `ignorable`
  forward-compatibility marker, so a future harness enforcing that marker
  strictly could refuse to resume logs containing these events (inherent
  limitation of the extension point today).
- **History restore** — the display restores from the client's loaded event
  window (tail page + live), not the whole log; a skill used long before the
  loaded window appears only after paging further back.

## Unverified at runtime

The browser display and the host event append have not been verified with a
live dsh session: the Conversation Definition / view-target registration and
the `conversation.input.dock` entry follow stock first-party patterns
(`dsh-client-ui-trajectory`, the queue dock), and `bunx tsc`/`bun test`/
`bun build` all pass, but no live dsh run has exercised them yet.

## Development

```sh
cd dotfiles/.dsh/plugins/dsh-skill-status
bunx tsc --noEmit    # typecheck (global @deepseek-ai/* via tsconfig paths)
bun test             # unit tests (pure logic only; no dsh runtime needed)
```

`@types/react` is not installed (the typecheck environment resolves only the
global `~/.bun/install/global/node_modules`); `src/types/react.d.ts` carries
a minimal ambient `react` declaration covering the `createElement` /
`useSyncExternalStore` surface this plugin uses. Delete it once `@types/react`
becomes available. `src/types/bun-test.d.ts` is the equivalent shim for the
tests.
