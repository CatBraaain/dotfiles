import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { realBwrapTest } from "../guardrails/bwrap-test-support.ts";
import toolsExtension from "./index.ts";
import { requestBackgroundBash } from "./background-bash.ts";

const TEMP_ROOT = "/tmp/work/dotfiles/bash-cancellation-tests";

function isRunning(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "fixture condition did not become true");
    await sleep(10);
  }
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
    hasUI: false,
    thinkingLevel: "off",
  } as unknown as ExtensionToolContext;
  toolsExtension(
    {
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
    const pidPath = join(directory, "pid");
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (isRunning(pid)) process.kill(-pid, "SIGKILL");
      await waitUntil(() => !isRunning(pid));
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const route of ["registered", "background"] as const) {
  realBwrapTest(
    `${route} Bash waits for the cancelled shell and prevents a late overwrite`,
    async () => {
      await withBashRuntime(async ({ directory, bash, context }) => {
        const controller = new AbortController();
        const pidPath = join(directory, "pid");
        const statePath = join(directory, "state");
        const releasePath = join(directory, "release");
        const childPidPath = join(directory, "childpid");
        const command = `(i=0; while [ "$i" -lt 240 ]; do if [ -e ${releasePath} ]; then printf stale > ${statePath}; break; fi; i=$((i+1)); sleep 0.025; done) & printf '%s' "$!" > ${childPidPath}; printf '%s' "$$" > ${pidPath}; wait`;
        const pending =
          route === "registered"
            ? bash.execute("old", { command }, controller.signal, undefined, context).then(
                () => {
                  throw new Error("cancelled command completed");
                },
                (error: unknown) => {
                  assert.match(String(error), /aborted/);
                },
              )
            : requestBackgroundBash({
                id: "old",
                params: { command },
                context,
                signal: controller.signal,
              }).then(async (outcome) => {
                assert.equal(outcome.status, "aborted");
                await outcome.executionSettled;
              });
        try {
          await waitUntil(() => existsSync(pidPath));
          const pid = Number(readFileSync(pidPath, "utf8"));
          const childPid = Number(readFileSync(childPidPath, "utf8"));
          controller.abort();
          await pending;
          const runningAfterSettlement = isRunning(pid);
          const childRunningAfterSettlement = isRunning(childPid);
          await bash.execute(
            "replacement",
            { command: `printf current > ${statePath}` },
            undefined,
            undefined,
            context,
          );
          writeFileSync(releasePath, "release");
          await waitUntil(() => !isRunning(pid) && !isRunning(childPid));
          assert.equal(
            runningAfterSettlement,
            false,
            "execution settled while its shell was running",
          );
          assert.equal(
            childRunningAfterSettlement,
            false,
            "execution settled while an ordinary child was running",
          );
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
    `${route} Bash preserves SDK timeout and waits for its shell`,
    async () => {
      await withBashRuntime(async ({ directory, bash, context }) => {
        const pidPath = join(directory, "pid");
        const params = { command: `printf '%s' "$$" > ${pidPath}; sleep 10`, timeout: 0.2 };
        if (route === "registered") {
          await assert.rejects(
            bash.execute("timeout", params, undefined, undefined, context),
            /Command timed out after 0.2 seconds/,
          );
        } else {
          const outcome = await requestBackgroundBash({ id: "timeout", params, context });
          assert.equal(outcome.status, "failed");
          if (outcome.status === "failed")
            assert.match(String(outcome.error), /Command timed out after 0.2 seconds/);
          await outcome.executionSettled;
        }
        const pid = Number(readFileSync(pidPath, "utf8"));
        assert.equal(isRunning(pid), false);
      });
    },
    20_000,
  );

  realBwrapTest(
    `${route} cancellation retains the SDK boundary for setsid descendants`,
    async () => {
      await withBashRuntime(async ({ directory, bash, context }) => {
        const controller = new AbortController();
        const pidPath = join(directory, "pid");
        const statePath = join(directory, "state");
        const releasePath = join(directory, "release");
        const detached = `printf '%s' "$$" > ${pidPath}; i=0; while [ "$i" -lt 240 ]; do if [ -e ${releasePath} ]; then printf detached > ${statePath}; break; fi; i=$((i+1)); sleep 0.025; done`;
        const command = `setsid bash -c '${detached}' >/dev/null 2>&1 & wait`;
        const pending =
          route === "registered"
            ? bash
                .execute("detached", { command }, controller.signal, undefined, context)
                .catch((error: unknown) => {
                  assert.match(String(error), /aborted/);
                })
            : requestBackgroundBash({
                id: "detached",
                params: { command },
                context,
                signal: controller.signal,
              }).then(async (outcome) => {
                assert.equal(outcome.status, "aborted");
                await outcome.executionSettled;
              });
        try {
          await waitUntil(() => existsSync(pidPath));
          const pid = Number(readFileSync(pidPath, "utf8"));
          controller.abort();
          await pending;
          assert.equal(
            isRunning(pid),
            true,
            "SDK-independent descendants retain their existing lifetime",
          );
          writeFileSync(releasePath, "release");
          await waitUntil(() => !isRunning(pid));
          assert.equal(readFileSync(statePath, "utf8"), "detached");
        } finally {
          controller.abort();
          writeFileSync(releasePath, "release");
          await pending;
        }
      });
    },
    20_000,
  );
}

realBwrapTest(
  "a successful daemon survives cancellation of a separate Bash request",
  async () => {
    await withBashRuntime(async ({ directory, bash, context }) => {
      const pidPath = join(directory, "pid");
      const releasePath = join(directory, "release");
      const daemon = `printf '%s' "$$" > ${pidPath}; i=0; while [ "$i" -lt 360 ]; do [ -e ${releasePath} ] && break; i=$((i+1)); sleep 0.025; done`;
      const result = await bash.execute(
        "daemon",
        { command: `setsid bash -c '${daemon}' >/dev/null 2>&1 &` },
        undefined,
        undefined,
        context,
      );
      assert.equal(result.isError, undefined);
      await waitUntil(() => existsSync(pidPath));
      const pid = Number(readFileSync(pidPath, "utf8"));
      const controller = new AbortController();
      const pending = bash.execute(
        "other",
        { command: "echo ready >&2; sleep 10" },
        controller.signal,
        () => controller.abort(),
        context,
      );
      await assert.rejects(pending, /aborted/);
      assert.equal(isRunning(pid), true);
      writeFileSync(releasePath, "release");
      await waitUntil(() => !isRunning(pid));
    });
  },
  20_000,
);
