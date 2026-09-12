# dotfiles-dsh-agents

Port of the pi `agents` extension for dsh: a host half plus a small browser
display half. Behavior contract: **SPEC.md** (Japanese, the review artifact).
Reads `~/.dsh/config/agents.yaml` (same schema as pi's
`~/.pi/agent/config/agents.yaml`) and provides:

- **Agent definitions** — `systemPrompt` as a persona section, `tools` as
  agent-scoped `tools.restrict`, `/agent <name>` switching with follow-up message
- **Class routing** — per-class ordered model candidates with `when` shell
  guards, cooldown bookkeeping, and per-request re-evaluation via the
  `agent/request` waterfall
- **429 / QUOTA fallback** — `agent/request-error` marks the failed route with a
  cooldown (`providerRetryAfterMs` first, 30 min default) and retries on the
  next live candidate; no candidate means the failure stays terminal
- **`subagent` tool** — pi-compatible `task` / `agent` / (ignored) `cwd`
  parameters over the in-process one-shot subagent seam, with the pi
  per-parent 2-slot FIFO limit
- **Vision delegation** — while the resolved route cannot take images, a scoped
  `read_image` shadow delegates the image to a vision-class one-shot child and
  returns its textual report
- **Agent/class display** (client half) — the pi widget lines
  `🤖 agent: <name>` / `💎 class: <name>` (with a `(manual)` suffix while a
  manual `/model` pick suspends routing) rendered under the composer in the
  web UI, in the same dim tone as the session-id footer

## Client display

The browser half (`src/client/`, prebuilt `lib/client.js`) renders one
composer-dock entry per session. The host claims the `dsh-agents/state`
endpoint on the shared `/api` RPC channel
(`@deepseek-ai/dsh-client-connection`'s `rpc.intercept`); the client component
polls it every 2 s with the session-scope `sessionId` standard prop and shows
the returned `{ managed, agent, className, manual }`. Failed polls keep the
last known state; an unmanaged session renders nothing. There is no config
and no durable session-log write — the state lives in host memory only.

The client bundle is **not** rebuilt by `run_build.sh` (it only handles node
entries); `lib/client.js` is committed. To rebuild it after editing
`src/client/`:

```sh
cd dotfiles/.dsh/plugins/agents
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser --external react \
  --banner 'window.__ModuleLoader__.load({ id: "dotfiles-dsh-agents", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

This is the same `window.__ModuleLoader__.load({ id, factory })` handoff the
other client halves use: `react` stays an external `require` resolved through
the shell's frozen module table. The bundle includes `src/state-rpc.ts` (the
shared endpoint name and payload helpers) — keep that module free of dsh
types so it stays browser-safe.

## Install

Registered statically in the profile manifest: append the plugin to both
`dependencies` and `dsh.profile.bundles` in
`dotfiles/.dsh/profiles/web/package.json`, then run `chezmoi apply`. The
build step:

```sh
cd dotfiles/.dsh/plugins/dsh-agents
bun build src/index.ts --outdir dist --target node \
  --external yaml --external '@deepseek-ai/*' --external '@earendil-works/*'
```

runs automatically from `dotfiles/.dsh/plugins/run_build.sh` on every
`chezmoi apply`, and `profiles/web/run_pnpm_install.sh` links the built entry
into the profile's node_modules. The build bundles the relative imports into
the entry and keeps the listed packages external; they resolve from the
profile closure at runtime — declare every value import that survives the
build in `dependencies` (currently `@deepseek-ai/dsh-llm`,
`@deepseek-ai/dsh-tools`, `yaml`); type-only imports need no declaration.
Restart dsh afterwards (bundle patches are fixed at startup — only user-layer
patches reload live).

## Configuration

`~/.dsh/config/agents.yaml` — the repository copy lives at
`dotfiles/.dsh/config/agents.yaml` (copied verbatim from the pi config, legacy
keys `tiers` / `tier` / `_systemPrompts` / `_when` included; they are ignored by
both harnesses).

```yaml
default: main
classes:
  high:
    - provider: zai
      model: glm-5.3
      when: "date -u +%H | grep -qvE '0[6-9]'"   # exit 0 → candidate alive
    - provider: openai-codex
      model: gpt-5.6-terra
agents:
  main:
    class: high
    tools: ["*"]
    subagents: [senior, junior, vision]
    systemPrompt: ["...", "..."]
```

Validation follows the pi spec (missing `vision`, `junior` delegating to
`vision`, undefined references, bare `!` negations, …). On any violation the
plugin logs the error and registers **nothing** — no commands, tools, routing,
or restrictions.

Provider names in candidates must match routes registered in the dsh
deployment (e.g. a `zai` route through `@deepseek-ai/dsh-llm-pi-ai`'s
`providers` settings). A candidate whose provider/model does not resolve via
`ctx.llm.resolveModelInfo` is skipped like pi's "not in the model registry".

## Usage

| Input | Behavior |
|---|---|
| `dsh --agent junior …` | Initial agent (undefined values warn and fall back to `default`) |
| `dsh --class low …` | Initial class (overrides the agent's default; undefined warns) |
| `/agent junior [message]` | Switch agent: persona/tools/subagent visibility swap, effective class resets to the agent default, manual model selection clears; `message` follows up as a user message |
| `/class low` | Switch effective class and clear manual selection; undefined class is an error |
| `/class` | List classes with the current one (popupSelect is phase 2) |
| `/reload` | Re-read `agents.yaml`; keeps manual selection, effective class, and cooldowns; agents/classes missing from the new config fall back to the initial agent / the agent's default class; a failed load keeps the current config |
| `subagent` tool | `task` (required), `agent` (required, enum = the calling agent's `subagents`), `cwd` (accepted, ignored) |

## Pi differences consumed / remaining

From the parity research's eight pi-difference points:

1. **In-process children** (was: spawned pi processes) — done. SIGTERM/SIGKILL,
   JSON stdout pumping, backpressure, and 0.15 s render throttling all
   disappear into the dsh subagent seam; the tool returns the child's final
   text only.
2. **Call-time `agent` parameter** — kept (plan B): one `subagent` tool with an
   `agent` parameter, shadowing the stock tools.
3. **2-slot limit** — kept: per-parent FIFO semaphore; the waiting placeholder
   text itself is UI (phase 2 client bundle).
4. **Pasted-image auto-delegation** — remaining: chat attachment admission
   still rejects images on incapable routes (stock behavior). Only the
   `read_image` tool path delegates.
5. **Child session storage** — dsh session store (durable, browsable); pi's
   `sessions/<project-key>/subagents/` split and deja-vu indexing do not apply.
6. **429 detection by `status`/`code`** — done: `status === 429` or code
   `RATE_LIMIT`/`QUOTA`; pi's `RATE_LIMIT_ERROR_PATTERNS` text matching and the
   z-ai exception are obsolete because `LlmFailure` normalizes them.
7. **Manual `/model` coexistence** — implemented via a scoped `session/event`
   listener that watches for durable `model/selection` events (details under
   "Runtime verification").
8. **z-ai concurrency retry / retry-finish-error** — remaining: those pi
   extensions are out of scope here.

Additional judgment calls (not in the research list):

- **`/agent:<name>` is impossible in dsh** — command names must match
  `/^[a-z][a-z0-9_-]*$/` (`dsh-commands` registry), so the pi syntax becomes
  `/agent <name>` (with optional message) and `/class <name>`.
- **`cwd` is ignored** — `SubagentStartRequest` has no cwd field; children
  always start in the parent cwd.
- **Unknown tool names are dropped with a warning** — `tools.restrict` throws
  on names absent from the global registry, so pi-only names (e.g.
  `handoff_session`) are filtered out before restricting. An allow list that is
  entirely unknown degrades to "no restriction" plus a warning.
- **Stock delegation tools are hidden** — `subagent`, `subagent_fork`,
  `send_message`, `interrupt_agent`, `list_agents` are denied for every managed
  agent; delegating agents see this plugin's `subagent` in their allow list
  instead (pi agents with a non-empty `subagents` always see the tool).
- **`read_image` shadow follows the route** — the scoped shadow registers when
  the resolved route lacks `image` input modalities (absent modalities count as
  incapable) and unregisters when the route regains image support. On capable
  routes the stock tool serves images natively.
- **429 pre-evaluation** — before answering `{kind:'retry'}` the plugin
  evaluates the next live candidate; with none left the failure stays terminal
  (`next()`), matching pi's "no fallback available" error.
- **Waiting-slot cancellation is checked at admission** — a call waiting for a
  free subagent slot aborts when its slot opens and the signal is already
  aborted; it does not preempt the wait itself.
- **Child routing** — one-shot children get their own routing state (fresh
  cooldowns, the child definition's class), registered from `run.localAgent`
  after `ctx.subagents.start()` resolves, so their own 429s fall back inside
  their class. `maxDepth` is left to the spawn provider's default; deeper
  delegation is gated by tool visibility (children of leaf agents never see the
  `subagent` tool).

## Runtime verification still needed

1. **`--agent` / `--class` passing the web-app commander parser** — dsh-cmdline
   hands unknown flags through, but the booted app may reject them and exit.
2. **One-shot prompt image blocks** — `ImageBlock` is type-legal in
   `SubagentStartRequest.prompt`; whether the spawn provider delivers it to the
   child's model request (and how modality is enforced there) needs a live run.
3. **`model/selection` watch details** — the plugin treats every
   `model/selection` session event as a manual pick (the plugin itself never
   appends one) and clears the manual flag on `/agent` or `/class`. A resumed
   session's historical selection does **not** re-arm the flag (in-memory
   only); whether that matches perceived behavior needs a live check.
4. **Routing-listener timing for spawned children** — the child state is
   registered after `start()` resolves; if the child's first request races
   ahead, its first request runs on the statically passed `agentOptions`
   instead of a re-evaluated candidate.
5. **read_image shadow timing** — the shadow flips inside `agent/request`, so
   a same-step schema assembly may briefly show the stock tool; the delegation
   itself is unaffected.
6. **Browser agent/class display** — the `dsh-agents/state` intercept and the
   composer-dock entry have not been exercised against a live dsh web
   session. The first live check should confirm that the entry appears under
   the composer, that `/agent` / `/class` switches show up within one 2 s
   poll, and that unmanaged sessions render nothing.

## Development

```sh
cd dotfiles/.dsh/plugins/agents
bun install          # devDependencies only (@types/bun, yaml for tests)
bunx tsc --noEmit    # typecheck (global @deepseek-ai/* via tsconfig paths)
bun test             # unit tests for config/routing/tool-allowlist/subagent-slots/state-rpc and the client half
bun build src/index.ts --outdir dist --target node \
  --external yaml --external '@deepseek-ai/*' --external '@earendil-works/*'
```

Pure logic (config validation, candidate picking, cooldowns, tool-list
translation, slot semaphore, the state RPC payload) lives in `src/*.ts` beside
its `*.test.ts` and imports no dsh types. `src/index.ts` is glue only and is
covered by types, not tests; the client half keeps its display logic in
`src/client/{format,controller,apply}.ts` and tests those.
