import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { realBwrapTest } from "../guardrails/bwrap-test-support.ts";
import toolsExtension from "./index.ts";

const TEMP_ROOT = "/tmp/work/dotfiles/bash-cancellation-tests";

/** Host pids of processes whose command line contains `marker` (sandbox pids are namespace-local). */
function markerProcesses(marker: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) pids.push(Number(entry));
    } catch {}
  }
  return pids;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "fixture condition did not become true");
    await sleep(10);
  }
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** A loop that records `outcome` once `releasePath` exists, running under argv[0] = `marker`. */
function loopCommand(marker: string, statePath: string, releasePath: string, outcome: string) {
  const loop = `i=0; while [ "$i" -lt 240 ]; do if [ -e ${releasePath} ]; then printf ${outcome} > ${statePath}; break; fi; i=$((i+1)); sleep 0.025; done`;
  return `bash -c ${shellQuote(`exec -a ${marker} bash -c ${shellQuote(loop)}`)}`;
}

/** Runs `command` detached and waits until its argv[0] equals `marker`. */
function detachedCommand(marker: string, command: string) {
  return `setsid ${command} >/dev/null 2>&1 & pid=$!; until [ "$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null | cut -d' ' -f1)" = ${shellQuote(marker)} ]; do :; done`;
}

async function withBashRuntime(
  test: (fixture: {
    directory: string;
    bash: ToolDefinition;
    context: ExtensionToolContext;
  }) => Promise<void>,
): Promise<void> {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const directory = mkdtempSync(join(TEMP_ROOT, "run-"));
  const config = join(directory, "config.yaml");
  writeFileSync(
    config,
    'read:\n  - allow: "*"\nwrite:\n  - allow: /tmp\ncommands:\n  - .*:\n      - allow: []\n',
  );
  const definitions = new Map<string, ToolDefinition>();
  const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
  const context = {
    modelRegistry: {},
    sessionManager: { getSessionId: () => "fixture" },
    hasUI: false,
    thinkingLevel: "off",
  } as unknown as ExtensionToolContext;
  context.executeTool = async (name, args, options) => {
    assert.equal(name, "bash");
    const params = args as { command: string; timeout?: number };
    const toolCall = { type: "toolCall" as const, id: "nested-bash", name, arguments: params };
    try {
      const result = await definitions
        .get(name)!
        .execute(toolCall.id, params, options?.signal, undefined, context);
      return { toolCall, result, isError: result.isError === true };
    } catch (error) {
      return {
        toolCall,
        result: {
          content: [{ type: "text" as const, text: String(error) }],
          details: {},
          isError: true,
        },
        isError: true,
      };
    }
  };
  toolsExtension(
    {
      events: createEventBus(),
      registerTool(definition: ToolDefinition) {
        definitions.set(definition.name, definition);
      },
      on(name: string, handler: (event: unknown, context: unknown) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      getThinkingLevel() {
        return "off";
      },
    } as unknown as ExtensionAPI,
    config,
  );
  try {
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    await test({ directory, bash: definitions.get("bash")!, context });
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectAbortedVia(
  route: "registered" | "context",
  bash: ToolDefinition,
  context: ExtensionToolContext,
  command: string,
  signal: AbortSignal,
) {
  const aborted = (error: unknown) => assert.match(String(error), /aborted/);
  return route === "registered"
    ? bash.execute("aborted", { command }, signal, undefined, context).then(() => {
        throw new Error("cancelled command completed");
      }, aborted)
    : context.executeTool("bash", { command }, { signal }).then((outcome) => {
        assert.equal(outcome.isError, true);
        assert.match(JSON.stringify(outcome.result.content), /aborted/);
      });
}

for (const route of ["registered", "context"] as const) {
  realBwrapTest(
    `${route} Bash waits for the cancelled shell and prevents a late overwrite`,
    async () => {
      await withBashRuntime(async ({ directory, bash, context }) => {
        const controller = new AbortController();
        const marker = "rtw-cancelled-loop";
        const statePath = join(directory, "state");
        const releasePath = join(directory, "release");
        const command = `(${loopCommand(marker, statePath, releasePath, "stale")}) & wait`;
        const pending = expectAbortedVia(route, bash, context, command, controller.signal);
        try {
          await waitUntil(() => markerProcesses(marker).length > 0);
          controller.abort();
          await pending;
          await waitUntil(() => markerProcesses(marker).length === 0);
          await bash.execute(
            "replacement",
            { command: `printf current > ${statePath}` },
            undefined,
            undefined,
            context,
          );
          assert.equal(readFileSync(statePath, "utf8"), "current");
          writeFileSync(releasePath, "release");
          await sleep(100);
          assert.equal(readFileSync(statePath, "utf8"), "current");
        } finally {
          controller.abort();
          writeFileSync(releasePath, "release");
          await pending.catch(() => {});
        }
      });
    },
    20_000,
  );

  realBwrapTest(
    `${route} Bash preserves SDK timeout and leaves no process behind`,
    async () => {
      await withBashRuntime(async ({ bash, context }) => {
        const marker = "rtw-timeout-sleep";
        const params = { command: `exec -a ${marker} sleep 10`, timeout: 0.2 };
        if (route === "registered") {
          await assert.rejects(
            bash.execute("timeout", params, undefined, undefined, context),
            /Command timed out after 0.2 seconds/,
          );
        } else {
          const outcome = await context.executeTool("bash", params);
          assert.equal(outcome.isError, true);
          assert.match(
            JSON.stringify(outcome.result.content),
            /Command timed out after 0.2 seconds/,
          );
        }
        await waitUntil(() => markerProcesses(marker).length === 0);
      });
    },
    20_000,
  );

  realBwrapTest(
    `${route} cancellation leaves no setsid descendants behind`,
    async () => {
      await withBashRuntime(async ({ directory, bash, context }) => {
        const controller = new AbortController();
        const marker = "rtw-setsid-loop";
        const statePath = join(directory, "state");
        const releasePath = join(directory, "release");
        const detached = detachedCommand(
          marker,
          loopCommand(marker, statePath, releasePath, "detached"),
        );
        const pending = expectAbortedVia(
          route,
          bash,
          context,
          `${detached}; wait`,
          controller.signal,
        );
        try {
          await waitUntil(() => markerProcesses(marker).length > 0);
          controller.abort();
          await pending;
          await waitUntil(() => markerProcesses(marker).length === 0);
          writeFileSync(releasePath, "release");
          await sleep(100);
          assert.equal(
            existsSync(statePath),
            false,
            "a detached process must not outlive its request",
          );
        } finally {
          controller.abort();
          writeFileSync(releasePath, "release");
          await pending.catch(() => {});
        }
      });
    },
    20_000,
  );
}

realBwrapTest(
  "a daemon from a completed request does not survive, and the worker keeps serving",
  async () => {
    await withBashRuntime(async ({ directory, bash, context }) => {
      const marker = "rtw-daemon-loop";
      const statePath = join(directory, "state");
      const releasePath = join(directory, "release");
      const daemon = detachedCommand(
        marker,
        loopCommand(marker, statePath, releasePath, "detached"),
      );
      const result = await bash.execute(
        "daemon",
        { command: `${daemon}; echo started` },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.isError, undefined);
      assert.equal(textOf(result), "started\n");
      await waitUntil(() => markerProcesses(marker).length === 0);
      writeFileSync(releasePath, "release");
      await sleep(100);
      assert.equal(existsSync(statePath), false);
      const next = await bash.execute(
        "other",
        { command: "echo alive" },
        undefined,
        undefined,
        context,
      );
      assert.equal(textOf(next), "alive\n");
    });
  },
  20_000,
);
