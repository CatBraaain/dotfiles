import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";
import {
  executeGuardedTool,
  type GuardedToolContext,
  type GuardedToolRequest,
} from "../guardrails/execute.ts";
import { Guardrail } from "../guardrails/guardrail.ts";
import { SandboxRunner } from "../guardrails/sandbox-runner.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1cAAAAASUVORK5CYII=",
  "base64",
);
const visionModel = {
  provider: "fixture",
  id: "vision",
  input: ["text", "image"],
} as GuardedToolContext["model"];

const entrypoint = fileURLToPath(new URL("./read.ts", import.meta.url));

function withFixture(test: (fixture: ReturnType<typeof createFixture>) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "guardrails-windows-read-"));
    try {
      await test(createFixture(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createFixture(root: string) {
  const denied = join(root, "denied");
  const credentials = join(root, "credentials-fixture");
  for (const directory of [denied, credentials]) {
    mkdirSync(directory);
    writeFileSync(join(directory, "protected"), png);
  }
  const config = join(root, "guardrails.yaml");
  writeFileSync(
    config,
    `read:\n  - allow: "*"\n  - deny: ${JSON.stringify(denied)}\ncredentials:\n  - ${JSON.stringify(credentials)}\nwrite: []\ncommands:\n  - ".*":\n      - deny: []\n`,
  );
  const guardrail = new Guardrail(root, config);
  const runner = new SandboxRunner(root, () => {
    throw new Error("Windows read must not build bwrap arguments");
  });
  const context = {
    hasUI: false,
    model: visionModel,
    async executeTool() {
      throw new Error("Windows read must not call another tool");
    },
  } as GuardedToolContext;
  function read(path: string, overrides: Partial<GuardedToolRequest> = {}) {
    return executeGuardedTool(guardrail, runner, root, {
      id: "windows-read-fixture",
      toolName: "read",
      params: { path },
      context,
      executor: { entrypoint, data: { supportsImages: !overrides.context } },
      ...overrides,
    });
  }
  return { root, denied, credentials, guardrail, runner, read };
}

describe.skipIf(process.platform !== "win32")("Windows native read without Bash", () => {
  it(
    "reads text with line offsets even when the filename has an image extension",
    withFixture(async ({ root, read }) => {
      const path = join(root, "text.png");
      writeFileSync(path, "first\nsecond");
      const result = await read(path, { params: { path, offset: 2, limit: 1 } });
      assert.deepEqual(result.content, [{ type: "text", text: "second" }]);
    }),
  );

  it(
    "returns SVG as text",
    withFixture(async ({ root, read }) => {
      const path = join(root, "icon.svg");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
      writeFileSync(path, svg);
      assert.deepEqual((await read(path)).content, [{ type: "text", text: svg }]);
    }),
  );

  it(
    "uses the full-read worker for skills",
    withFixture(async ({ root, read }) => {
      const path = join(root, "SKILL.md");
      const text = "first\nsecond";
      writeFileSync(path, text);
      const result = await read(path, {
        params: { path, offset: 2, limit: 1 },
      });
      assert.equal(result.structuredContent, text);
    }),
  );

  it(
    "rejects a text executor that does not accept the opened file",
    withFixture(async ({ root, read }) => {
      const path = join(root, "note.txt");
      const entrypoint = join(root, "executor.ts");
      writeFileSync(path, "fixture");
      writeFileSync(entrypoint, "export {};");
      await assert.rejects(
        read(path, { executor: { entrypoint } }),
        /does not support an opened file/,
      );
    }),
  );

  const imageFixtures = [
    ["png", png.toString("hex"), "image/png"],
    ["tiff", "49492a0008000000000000000000", "image/tiff"],
    [
      "ico",
      "00000100010001010000010020004400000016000000" + png.toString("hex"),
      "image/vnd.microsoft.icon",
    ],
    ["avif", "00000018667479706176696600000000617669666d696631", "image/avif"],
    ["heic", "00000018667479706865696300000000686569636d696631", "image/heic"],
  ];

  for (const [format, hex, mimeType] of imageFixtures) {
    it(
      `returns original ${format} bytes and MIME without a filename extension`,
      withFixture(async ({ root, read }) => {
        const path = join(root, "image");
        const bytes = Buffer.from(hex!, "hex");
        writeFileSync(path, bytes);
        const result = await read(path, {
          params: { path, offset: 999, limit: 1 },
        });
        assert.deepEqual(result.content, [
          { type: "image", data: bytes.toString("base64"), mimeType },
        ]);
      }),
    );
  }

  it(
    "returns the delegation message instead of an image for a text-only model",
    withFixture(async ({ root, read }) => {
      const path = join(root, "image");
      writeFileSync(path, png);
      const result = await read(path, { context: { hasUI: false, model: undefined } });
      assert.equal(result.isError, true);
      assert.equal(result.content.length, 1);
      assert.match((result.content[0] as { text: string }).text, /vision agent/);
    }),
  );

  it(
    "requires authorization of the opened file even when the spelling is unchanged",
    withFixture(async ({ root, guardrail, read }) => {
      const path = join(root, "note.txt");
      writeFileSync(path, "fixture");
      const authorize = guardrail.authorizePath.bind(guardrail);
      let checks = 0;
      guardrail.authorizePath = async (operation, candidate, context) => {
        assert.equal(candidate, path);
        if (++checks === 2) throw new Error("Opened file was denied");
        return authorize(operation, candidate, context);
      };
      await assert.rejects(read(path), /Opened file was denied/);
    }),
  );

  it(
    "reads the authorized open file when an allowed junction changes during authorization",
    withFixture(async ({ root, guardrail, runner }) => {
      const first = join(root, "first");
      const second = join(root, "second");
      const junction = join(root, "junction");
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(join(first, "fixture"), png);
      writeFileSync(join(second, "fixture"), "other text");
      symlinkSync(first, junction, "junction");
      const result = await runner.runWindowsRead(
        { path: join(junction, "fixture") },
        {
          executor: { entrypoint, data: { supportsImages: true } },
          authorize: async (candidate, signal) => {
            assert.equal(candidate, join(first, "fixture"));
            await guardrail.authorizePath("read", candidate, { hasUI: false }, signal);
            rmSync(junction);
            symlinkSync(second, junction, "junction");
          },
        },
      );
      assert.deepEqual(result.content, [
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
      ]);
    }),
  );

  it(
    "does not return a file overwritten while authorization is pending",
    withFixture(async ({ root, guardrail, read }) => {
      const path = join(root, "text");
      writeFileSync(path, "text");
      const authorize = guardrail.authorizePath.bind(guardrail);
      let checks = 0;
      guardrail.authorizePath = async (operation, candidate, context) => {
        const result = await authorize(operation, candidate, context);
        if (++checks === 2) writeFileSync(path, png);
        return result;
      };
      await assert.rejects(read(path), /File changed before read/);
    }),
  );

  it(
    "does not save a read grant when authorization of the opened file is cancelled",
    withFixture(async ({ root, runner }) => {
      const path = join(root, "text");
      writeFileSync(path, "fixture");
      const config = join(root, "ask.yaml");
      writeFileSync(config, `read:\n  - ask: ${JSON.stringify(path)}\n`);
      const guardrail = new Guardrail(root, config);
      const shown = Promise.withResolvers<void>();
      const decision = Promise.withResolvers<boolean>();
      const authorizationDone = Promise.withResolvers<void>();
      const controller = new AbortController();
      const reason = new Error("Read cancelled");
      const result = runner.runWindowsRead(
        { path },
        {
          signal: controller.signal,
          authorize: async (candidate, signal) => {
            try {
              await guardrail.authorizePath(
                "read",
                candidate,
                {
                  hasUI: true,
                  ui: {
                    confirm: async () => {
                      shown.resolve();
                      return decision.promise;
                    },
                  },
                },
                signal,
              );
            } finally {
              authorizationDone.resolve();
            }
          },
        },
      );
      try {
        await Promise.race([shown.promise, result]);
        controller.abort(reason);
        await assert.rejects(result, (error) => error === reason);
      } finally {
        decision.resolve(true);
      }
      await authorizationDone.promise;
      await assert.rejects(
        guardrail.authorizePath("read", path, { hasUI: false }),
        /Access requires confirmation/,
      );
    }),
  );

  it(
    "rejects UNC paths without attempting to authorize the opened file",
    withFixture(async ({ runner }) => {
      await assert.rejects(
        runner.runWindowsRead(
          { path: "\\\\localhost\\fixture-share\\test.txt" },
          {
            authorize: async () => {
              throw new Error("Should not authorize a UNC path");
            },
          },
        ),
        /requires a verifiable drive-letter path/,
      );
    }),
  );

  for (const target of ["denied", "credentials"] as const) {
    it(
      `refuses ${target} before detection even through a directory junction`,
      withFixture(async (fixture) => {
        const directory = fixture[target];
        const junction = join(fixture.root, "junction");
        symlinkSync(directory, junction, "junction");
        for (const path of [join(directory, "protected"), join(junction, "protected")]) {
          await assert.rejects(fixture.read(path), /Access denied|Cannot verify Windows path/);
        }
      }),
    );
  }
});
