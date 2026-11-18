import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { executeGuardedTool, type GuardedToolContext, type GuardedToolRequest } from "./execute.ts";
import { Guardrail } from "./guardrail.ts";
import { SandboxRunner } from "./sandbox-runner.ts";
import { realBwrapTest } from "./bwrap-test-support.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1cAAAAASUVORK5CYII=",
  "base64",
);
const visionModel = { provider: "fixture", id: "vision", input: ["text", "image"] };

function withFixture(test: (fixture: ReturnType<typeof createFixture>) => Promise<void>) {
  return async () => {
    const fixture = createFixture();
    try {
      await test(fixture);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  };
}

function createFixture(commandRules = "") {
  mkdirSync("/tmp/work/dotfiles", { recursive: true });
  const root = mkdtempSync("/tmp/work/dotfiles/image-read-");
  const allowed = join(root, "allowed");
  const denied = join(root, "denied");
  const credentials = join(root, "credentials-fixture");
  for (const directory of [allowed, denied, credentials]) {
    mkdirSync(directory);
    writeFileSync(join(directory, "fixture.png"), png);
  }
  symlinkSync(denied, join(allowed, "denied-alias"), "dir");
  symlinkSync(credentials, join(allowed, "credential-alias"), "dir");
  symlinkSync(allowed, join(root, "allowed-alias"), "dir");
  symlinkSync(join(allowed, "fixture.png"), join(root, "file-alias"));
  const config = join(root, "guardrails.yaml");
  writeFileSync(
    config,
    `read:\n  - allow: "*"\n  - deny: ${denied}\ncredentials:\n  - ${credentials}\nwrite: []\ncommands:\n  - ".*":\n      - allow: []\n${commandRules}`,
  );
  const guardrail = new Guardrail(root, config);
  const runner = new SandboxRunner(root, (mode) => guardrail.buildArgs(mode));
  const context = { hasUI: false, model: visionModel } as GuardedToolContext;
  const bashCommands: string[] = [];
  context.executeTool = async (name, args, options) => {
    assert.equal(name, "bash");
    const params = args as { command: string };
    bashCommands.push(params.command);
    const result = await executeGuardedTool(guardrail, runner, root, {
      id: "nested-bash",
      toolName: "bash",
      params,
      context,
      signal: options?.signal,
    });
    return {
      toolCall: { type: "toolCall", id: "nested-bash", name, arguments: params },
      result,
      isError: result.isError === true,
    };
  };
  function read(path: string, overrides: Partial<GuardedToolRequest> = {}) {
    return executeGuardedTool(guardrail, runner, root, {
      id: "read-fixture",
      toolName: "read",
      params: { path },
      context,
      ...overrides,
    });
  }
  return { root, allowed, denied, credentials, guardrail, runner, context, bashCommands, read };
}

describe("sandboxed image read", () => {
  for (const path of ["allowed/fixture.png", "allowed-alias/fixture.png", "file-alias"]) {
    realBwrapTest(
      `preserves original image bytes through ${path}`,
      withFixture(async (fixture) => {
        const result = await fixture.read(join(fixture.root, path), {
          params: { path: join(fixture.root, path), offset: 999, limit: 1 },
          executor: { entrypoint: join(fixture.root, "must-not-run.ts") },
        });
        assert.deepEqual(result.content, [
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ]);
        assert.equal(fixture.bashCommands.length, 1);
        assert.match(fixture.bashCommands[0]!, /--tmpfs/);
      }),
    );
  }

  for (const alias of ["denied-alias", "credential-alias"]) {
    realBwrapTest(
      `blocks image detection through ${alias}`,
      withFixture(async (fixture) => {
        const result = await fixture.read(join(fixture.allowed, alias, "fixture.png"));
        assert.equal(result.isError, true);
        assert.match(
          result.content[0]?.type === "text" ? result.content[0].text : "",
          /Image detection failed|ERROR|cannot open/,
        );
      }),
    );

    realBwrapTest(
      `masks image bytes if the path changes to ${alias} after detection`,
      withFixture(async (fixture) => {
        const changingPath = join(fixture.allowed, "changing.png");
        symlinkSync(join(fixture.allowed, "fixture.png"), changingPath);
        const executeTool = fixture.context.executeTool!;
        fixture.context.executeTool = async (...args) => {
          const outcome = await executeTool(...args);
          rmSync(changingPath);
          symlinkSync(join(fixture.allowed, alias, "fixture.png"), changingPath);
          return outcome;
        };
        await assert.rejects(fixture.read(changingPath), /ENOENT/);
      }),
    );
  }

  for (const directory of ["denied", "credentials-fixture"]) {
    realBwrapTest(
      `rejects the original ${directory} path before detection`,
      withFixture(async (fixture) => {
        await assert.rejects(
          fixture.read(join(fixture.root, directory, "fixture.png")),
          /Access denied/,
        );
        assert.equal(fixture.bashCommands.length, 0);
      }),
    );
  }

  realBwrapTest(
    "detects extensionless images by content",
    withFixture(async (fixture) => {
      const path = join(fixture.allowed, "no-extension");
      writeFileSync(path, png);
      const result = await fixture.read(path);
      assert.equal(result.content[0]?.type, "image");
    }),
  );

  for (const [format, hex, mimeType] of [
    ["tiff", "49492a0008000000000000000000", "image/tiff"],
    [
      "ico",
      "00000100010001010000010020004400000016000000" + png.toString("hex"),
      "image/vnd.microsoft.icon",
    ],
    ["avif", "00000018667479706176696600000000617669666d696631", "image/avif"],
    ["heic", "00000018667479706865696300000000686569636d696631", "image/heic"],
  ]) {
    realBwrapTest(
      `preserves ${format} bytes and MIME without SDK conversion`,
      withFixture(async (fixture) => {
        const path = join(fixture.allowed, `image.${format}`);
        const bytes = Buffer.from(hex!, "hex");
        writeFileSync(path, bytes);
        const result = await fixture.read(path);
        assert.deepEqual(result.content, [
          { type: "image", data: bytes.toString("base64"), mimeType },
        ]);
      }),
    );
  }

  realBwrapTest(
    "uses content rather than an image extension",
    withFixture(async (fixture) => {
      const path = join(fixture.allowed, "text.png");
      writeFileSync(path, "not an image");
      const result = await fixture.read(path);
      assert.deepEqual(result.content, [{ type: "text", text: "not an image" }]);
    }),
  );

  realBwrapTest(
    "returns SVG through the non-image executor",
    withFixture(async (fixture) => {
      const path = join(fixture.allowed, "icon.svg");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
      writeFileSync(path, svg);
      const result = await fixture.read(path);
      assert.deepEqual(result.content, [{ type: "text", text: svg }]);
    }),
  );

  for (const model of [{ provider: "fixture", id: "text", input: ["text"] }, undefined]) {
    realBwrapTest(
      `does not read additional bytes for ${model?.id ?? "unknown"} models`,
      withFixture(async (fixture) => {
        const originalRunTool = fixture.runner.runTool.bind(fixture.runner);
        fixture.runner.runTool = async (name, params, options) => {
          assert.equal(name, "bash");
          return originalRunTool(name, params, options);
        };
        const result = await fixture.read(join(fixture.allowed, "fixture.png"), {
          context: { ...fixture.context, model } as GuardedToolContext,
        });
        assert.equal(result.isError, true);
        assert.match((result.content[0] as { text: string }).text, /vision agent/);
        assert.ok(result.content.every((part) => part.type !== "image"));
      }),
    );
  }

  it(
    "fails closed without a registered Bash entry point",
    withFixture(async (fixture) => {
      await assert.rejects(
        fixture.read(join(fixture.allowed, "fixture.png"), {
          context: { hasUI: false, model: undefined },
        }),
        /context.executeTool/,
      );
      assert.equal(fixture.bashCommands.length, 0);
    }),
  );

  it("does not hide a denied file command inside bwrap", async () => {
    const fixture = createFixture("  - file:\n      - deny: []\n");
    try {
      await assert.rejects(fixture.read(join(fixture.allowed, "fixture.png")), /Command denied/);
      assert.equal(fixture.bashCommands.length, 0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it(
    "fails closed when the registered Bash rejects the wrapper",
    withFixture(async (fixture) => {
      fixture.context.executeTool = async () => ({
        toolCall: { type: "toolCall", id: "blocked", name: "bash", arguments: {} },
        result: { content: [{ type: "text", text: "blocked" }], details: {} },
        isError: true,
      });
      const result = await fixture.read(join(fixture.allowed, "fixture.png"));
      assert.equal(result.isError, true);
      assert.match(
        result.content[0]?.type === "text" ? result.content[0].text : "",
        /Image detection failed.*blocked/,
      );
    }),
  );

  it(
    "does not start the image worker when aborted after detection",
    withFixture(async (fixture) => {
      const controller = new AbortController();
      fixture.context.executeTool = async () => {
        controller.abort(new Error("cancelled after detection"));
        return {
          toolCall: { type: "toolCall", id: "mime", name: "bash", arguments: {} },
          result: { content: [{ type: "text", text: "image/png" }], details: {} },
          isError: false,
        };
      };
      fixture.runner.runTool = async () => {
        throw new Error("worker must not run");
      };
      const result = await fixture.read(join(fixture.allowed, "fixture.png"), {
        signal: controller.signal,
      });
      assert.equal(result.isError, true);
      assert.strictEqual((result.details as { reason: unknown }).reason, controller.signal.reason);
    }),
  );

  it(
    "does not start image detection when already aborted",
    withFixture(async (fixture) => {
      const signal = AbortSignal.abort(new Error("cancelled"));
      await assert.rejects(
        fixture.read(join(fixture.allowed, "fixture.png"), { signal }),
        /cancelled/,
      );
      assert.equal(fixture.bashCommands.length, 0);
    }),
  );
});

describe("final image read Bash diagnostics", () => {
  for (const mode of ["outer", "inner", "cancel"] as const)
    it(
      `retains the ${mode} MIME response without reading image bytes`,
      withFixture(async (fixture) => {
        const controller = new AbortController();
        const reason = new Error("MIME cancelled");
        const response = {
          toolCall: { type: "toolCall" as const, id: "mime", name: "bash", arguments: {} },
          isError: mode === "outer",
          result: {
            content: [{ type: "text" as const, text: "image/png" }],
            isError: mode === "inner",
            details: { source: "original" },
            structuredContent: { output: "image/png", exit_code: 2, truncated: false },
          },
        };
        fixture.context.executeTool = async () => {
          if (mode === "cancel") controller.abort(reason);
          return response;
        };
        fixture.runner.runTool = async () => {
          throw new Error("image worker must not run");
        };
        const result = await fixture.read(join(fixture.allowed, "fixture.png"), {
          signal: controller.signal,
        });
        assert.equal(result.isError, true);
        const details = result.details as { bash: typeof response; reason: unknown };
        assert.strictEqual(details.bash.result, response.result);
        assert.equal(details.bash.isError, response.isError);
        if (mode === "cancel") assert.strictEqual(details.reason, reason);
      }),
    );
  it(
    "propagates the SDK exception identity through image read",
    withFixture(async (fixture) => {
      const failure = new Error("Expired SDK context");
      fixture.context.executeTool = async () => {
        throw failure;
      };
      await assert.rejects(
        fixture.read(join(fixture.allowed, "fixture.png")),
        (error) => error === failure,
      );
    }),
  );
});
