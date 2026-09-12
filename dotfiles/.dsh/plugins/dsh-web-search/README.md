# dotfiles-dsh-web-search

Port of the pi `web-search` extension to a dsh provider plugin. Behavior
contract: **SPEC.md** (the oracle).

Registers two providers on the web seam (`ctx.web`, `@deepseek-ai/dsh-web`):

- **search** (`camoufox-openserp`) — renders SERPs with camoufox via
  `playwright-cli`, parses them with openserp. Engines fall back
  google → duckduckgo → bing; results are capped to `maxResults` (default 10).
- **fetch** (`camoufox-trafilatura`) — Reddit posts via feed/embed/oEmbed,
  StackOverflow questions via the StackExchange API/question feed, everything
  else via camoufox render + `trafilatura --markdown`. Returns
  `body: { kind: "text", content }`, `statusCode: 200`.

Both providers serialize same-kind requests internally (search and fetch run
in parallel to each other). `apply` primes the resident servers
(`bun server.mjs` + `openserp serve`) fire-and-forget; an already-running
server (e.g. started by pi) is reused as-is.

## Configuration

Patch-row `config` (priority: config > environment variable > default):

| key | env | default |
|---|---|---|
| `camoufoxBaseUrl` | `CAMOUFOX_BASE_URL` | `ws://127.0.0.1:9378/camoufox` |
| `openserpBaseUrl` | `OPENSERP_BASE_URL` | `http://127.0.0.1:7000` |

`available()` requires the `bun`, `openserp`, and `playwright-cli` binaries on
PATH plus the camoufox browser executable (`CAMOUFOX_EXECUTABLE_PATH`, default
`~/.cache/camoufox/camoufox-bin`). No network access.

## Layout

- `src/index.ts` — the whole plugin. **A single self-contained module on
  purpose**: `run_build.sh` builds with `--external '*'`, which externalizes
  relative imports too, so a multi-file entry would emit a broken
  `dist/index.js`.
- `server.mjs` — the camoufox server, shipped in the package root outside the
  bundle. Spawned as `bun server.mjs` (cwd = package root) with the resolved
  base URL passed through the child `CAMOUFOX_BASE_URL`. Its imports
  (`camoufox-js`) resolve through bun's auto-install of the declared
  dependency when no local `node_modules` is present; on bun it uses the
  built-in `bun:sqlite` instead of `better-sqlite3`.
- `playwright-cli.config.json` — generated at runtime in the package root
  (kept in sync with the resolved camoufox base URL before each render).

## Profile wiring

The `web` profile lists this package statically in
`dotfiles/.dsh/profiles/web/package.json`: a `file:` dependency plus an entry
in `dsh.profile.bundles`, which joins `cordis.patch.yml` into the profile.

## Development

```sh
cd dotfiles/.dsh/plugins/dsh-web-search
bun install          # dev/test dependencies (trustedDependencies: [])
bunx tsc --noEmit    # typecheck
bun test             # unit tests (pure logic + provider contract; no dsh runtime)
bun build src/index.ts --outdir dist --target node --external '*'
```

Runtime value imports (`WebError` from `@deepseek-ai/dsh-web`, `z` from
`@deepseek-ai/schemastery`) stay external in `dist/index.js` and resolve
through the profile's node_modules, like the other local plugins.
