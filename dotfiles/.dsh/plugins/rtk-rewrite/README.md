# dotfiles-rtk-rewrite

dsh host plugin: a bash executor that rewrites every command through
`rtk rewrite` before execution, so read-heavy commands
run through rtk's compact output wrappers and burn fewer tokens. Ported from
the pi extension `rtk.ts` (single source of truth for the rewrite rules is the
`rtk` CLI itself — to add or change rules, edit rtk's Rust registry, not this
plugin).

## How it works

The plugin subclasses the stock `SandboxBashExecutor`
(`@deepseek-ai/dsh-bash-sandbox`) and rewrites `spec.command` in `run` /
`start` before delegating to the parent. Confinement, budgets, timeouts, and
result classification are exactly the stock implementation's; the only delta
is the rewrite.

`cordis.patch.yml` disables the stock `bash-sandbox` row (id-level override,
last write wins) and mounts this package as `bash-rtk` with the same config
shape. Windows rows are untouched (`pwsh-sandbox` keeps serving; `bash-rtk`
is gated off there like the stock row).

## Disable conditions (fail open)

The executor always works; the rewrite only arms when all of the following
hold. Any miss passes the original command through unchanged:

- `rtk` binary in `PATH` at mount time, version >= 0.23.0 (when
  `rtk rewrite` was introduced)
- `RTK_DISABLED` env var is not `1` (checked per command)
- command does not already start with `rtk `
- `rtk rewrite` exits `0` (rewrite) or `3` (advisory rewrite) with non-empty
  stdout within 2 s — exit `1` means "no equivalent", anything else fails
  open

Rewrites are logged under the `bash-rtk` logger with the before/after
command, since the model and the tool transcript only ever see the original
command (the rewrite happens at the executor boundary, not in the tool
input).

## Differences from the pi extension

- Rewrite point: pi mutates the bash tool's input, so the model and the
  transcript see the rewritten command; here only the actually executed
  command changes.
- Coverage: pi hooked the bash tool only; here every `ctx.shell` consumer is
  covered (foreground and background bash, plugin `when` evaluations).
- Disable behavior: pi disabled the whole extension when rtk was missing or
  too old; here the executor keeps serving and only the rewrite disarms.

## Install

Listed in `dotfiles/.dsh/profiles/web/package.json` — add
`dotfiles-rtk-rewrite` to both `dependencies` (as
`file:../../plugins/rtk-rewrite`) and `dsh.profile.bundles`.

## Build

`run_build.sh` builds every plugin's node entry: relative imports are
inlined into `dist/index.js`, and only the bare-specifier externals listed
in the script (`yaml`, `shell-quote`, `@vscode/ripgrep`, `@deepseek-ai/*`,
`@earendil-works/*`) stay external.

## Development

```sh
cd dotfiles/.dsh/plugins/rtk-rewrite
bunx tsc --noEmit
```

Typecheck maps `@deepseek-ai/*` and `@types/node` to the global Bun
`node_modules` via `tsconfig.json` paths/typeRoots; nothing needs to be
installed locally.

Unverified at runtime: the composition swap (patch rows) and the executor
subclass have been typechecked and built, but not exercised in a live dsh
session from this environment.
