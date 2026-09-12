# dotfiles-dsh-zai-concurrency-retry

Host-side port of the pi `zai-concurrency-retry` extension. Behavior
contract: **SPEC.md** (Japanese, the review artifact).

Z.AI coding plans reject concurrent requests with business codes 1302 /
1305 (HTTP 429 whose body text surfaces in the `agent/request-error` failure
message). The limit is account-wide, so neither dsh-llm-retry's budgeted
short backoff nor dsh-agents' model fallback can recover it. This plugin
owns those failures in the `agent/request-error` waterfall: it waits out an
exponential backoff and answers `{kind: 'retry'}`, unbounded, until the
request finally goes through or the user aborts.

- **Detection** — provider `zai` / `zai-coding-cn` plus message patterns
  (`code":"130x"` raw JSON, `rate limit reached for requests`,
  `temporarily overloaded`, both case-insensitive). Quota codes (1113,
  1308–1321) are excluded and keep flowing to the regular rate-limit
  fallback (dsh-agents cooldown + model fallback, dsh-llm-retry budget).
- **Backoff** — `5s × 2^(n-1)` capped at 60s, ±20% symmetric jitter, where n
  is the consecutive failure count of the current retry chain. A positive
  finite `failure.providerRetryAfterMs` would win verbatim, but
  dsh-llm-pi-ai never sets it today, so the local backoff is the live path.
- **Ownership** — the listener registers with `{prepend: true}` so it runs
  outermost regardless of plugin load order (activation is
  service-availability driven, not bundle order). Non-matching failures fall
  through `next()` to dsh-llm-retry and dsh-agents untouched.
- **State** — per-agent in-memory retry chains keyed by turn+step: the agent
  loop retries inside the same step (`step/start` is not re-appended), so a
  matching turn+step grows the count and any other turn/step restarts at 1.
  Same reset timing as dsh-llm-retry's projection, non-durable like pi's
  module state.

## Install

Registered statically in the profile manifest: append the plugin to both
`dependencies` and `dsh.profile.bundles` in
`dotfiles/.dsh/profiles/web/package.json`, then run `chezmoi apply`. The
build step (run automatically by `dotfiles/.dsh/plugins/run_build.sh`):

```sh
cd dotfiles/.dsh/plugins/dsh-zai-concurrency-retry
bun build src/index.ts --outdir dist --target node --external '*'
```

`src/index.ts` is a single self-contained module on purpose: `--external '*'`
externalizes relative imports too, so a multi-file entry would emit a broken
`dist/index.js` (see the dsh-skill-status README "Build"). No runtime
dependencies; `@deepseek-ai/*` types resolve via tsconfig paths and the
runtime resolves them from the profile closure.

## Usage

Nothing to invoke. While a Z.AI route is concurrency-limited, each failed
request logs one warning:

```
Z.AI concurrency limit on zai (attempt 3); retrying the same step in 20s: …
```

and replays the same step after the wait. An abort mid-wait leaves the
failure terminal.

## Pi differences

- **Single retry loop instead of turn/settled split** — pi retried inside
  the turn (bounded by `retry.maxRetries`) and re-triggered the turn after
  settle (unbounded); dsh's `agent/request-error` waterfall can veto with
  `{kind: 'retry'}` without a bound, which composes to the same unbounded
  behavior with monotonically growing backoff.
- **No Retry-After observation** — pi read the header via
  `after_provider_response`; dsh plugins see only the serializable
  `LlmFailure` facts and dsh-llm-pi-ai never sets `providerRetryAfterMs`,
  so the header is currently unobservable. The override path exists and is
  unit-tested for the day an adapter carries it.
- **Per-agent consecutive count** — pi shared one process-wide counter across
  all sessions; this plugin scopes chains per agent. Parallel agents each
  pace themselves (the ±20% jitter de-synchronizes them), and a count
  restarts when the turn or step advances (pi kept it growing across turns
  until any success, including across a user abort and manual resend).
- **Logger instead of status line** — pi showed a status line / notification
  via `ctx.ui`; the dsh host surface here is one `logger.warn` per retry
  (matching dsh-agents' rate-limit logging). A client bundle rendering the
  wait in the transcript would be a follow-up.

## Development

```sh
cd dotfiles/.dsh/plugins/dsh-zai-concurrency-retry
bun install          # devDependencies only (@types/bun)
bunx tsc --noEmit    # typecheck (global @deepseek-ai/* via tsconfig paths)
bun test             # unit tests for detection / backoff / chain counting
```

Pure logic (detection, retry-after validity, backoff, chain counting) is
exported from `src/index.ts` and tested in `src/index.test.ts`; the glue
(`apply`) is covered by types, not tests.
