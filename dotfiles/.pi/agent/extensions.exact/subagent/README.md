# Subagent

Spawn an isolated child `pi` process to run a single task in its own context
window. Pure orchestration infrastructure — no personas, no agent files.

The child's **thinking streams to the user** in real time; only the child's
**final text is returned to the parent**. Cancellation propagates: SIGTERM,
then SIGKILL after 5s.

## Features

- **Isolated context**: the child runs in a separate `pi` process
- **Streaming output**: tool calls and thinking stream as they happen
- **Markdown rendering**: final output rendered with proper formatting (expanded view)
- **Abort support**: Ctrl+C propagates to kill the child process

## Structure

```
subagent/
├── README.md       # This file
├── SPEC.md         # Minimization spec
├── index.ts        # The extension (entry point)
└── index.test.ts   # Unit tests for exported helpers and orchestration
```

## Installation

From the repository root, symlink the extension:

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/dotfiles/.pi/agent/extensions.exact/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
```

## Usage

```
Use the subagent tool with task: "Find all authentication code"
```

## Tool Parameters

Single mode only.

| `model` | string? | `--model` | Model override |
| `cwd` | string? | — | Working directory (defaults to the parent's `cwd`) |

```
pi --mode json -p --no-session [--model X]
```

with `Task: <task>` as the final argument.

## Skill Discovery

The child keeps the **same skill auto-discovery as the parent** (global +
project skills). There are no `--skill` / `--no-skills` / persona-shaping
options — if you need to restrict skills, do it at the project level.

## Output Display

**Collapsed view** (default):
- Status icon (`✓` / `✗`) and child label
- Last ~10 items as one-line previews

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls (generic one-line preview: `→ toolName {args json}`)
- Final output rendered as Markdown

Every tool call renders the **same** generic one-line preview; there is no
per-tool formatting.

## Child Labels

Each result is shown with a label derived from the run options: the **model
name** when given, otherwise the generic `task`.

## Error Handling

- **Exit code != 0**: tool returns an error with stderr / output
- **`stopReason: "error"`**: LLM error propagated with the error message
- **`stopReason: "aborted"`**: user abort (Ctrl+C) kills the subprocess and
  the run throws

There is **no timeout** — the child is stopped only when the parent is
cancelled. The escalation order is SIGTERM, then SIGKILL after 5s.

## Tests

```
bun --install=auto run index.test.ts
```

The tests fake `pi` by swapping the spawn seam (`__spawn`) and replaying
JSON-mode lines over stdout, so no real `pi` is spawned.
