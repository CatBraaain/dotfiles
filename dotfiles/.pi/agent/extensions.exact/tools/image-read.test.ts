import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isVisionImageFile } from "./read.ts";
import { describe, it } from "bun:test";
import {
  executeGuardedTool,
  type GuardedToolContext,
  type GuardedToolRequest,
} from "../guardrails/execute.ts";
import { Guardrail } from "../guardrails/guardrail.ts";
import { SandboxRunner } from "../guardrails/sandbox-runner.ts";
import { realBwrapTest } from "../guardrails/bwrap-test-support.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1cAAAAASUVORK5CYII=",
  "base64",
);
const visionModel = { provider: "fixture", id: "vision", input: ["text", "image"] };
const entrypoint = fileURLToPath(new URL("./read.ts", import.meta.url));

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
    `read:\n  - allow: "*"\n  - deny: ${denied}\ncredentials:\n  - ${credentials}\nwrite:\n  - allow: ${allowed}\ncommands:\n  - ".*":\n      - allow: []\n${commandRules}`,
  );
  const guardrail = new Guardrail(root, config);
  const mountArguments: string[][] = [];
  const runner = new SandboxRunner(root, (mode, cwd, readOnly) => {
    const args = guardrail.buildArgs(mode, cwd, readOnly);
    mountArguments.push(args);
    return args;
  });
  const context = { hasUI: false, model: visionModel } as GuardedToolContext;
  function read(path: string, overrides: Partial<GuardedToolRequest> = {}) {
    return executeGuardedTool(guardrail, runner, root, {
      id: "read-fixture",
      toolName: "read",
      params: { path },
      context,
      ...overrides,
      executor: {
        entrypoint,
        data: { supportsImages: overrides.context ? false : true },
      },
    });
  }
  return { root, allowed, runner, context, read, mountArguments };
}

describe("sandboxed image read", () => {
  realBwrapTest("reads text and images with no registered Bash tool", async () => {
    const fixture = createFixture("  - file|bwrap:\n      - deny: []\n");
    try {
      const path = join(fixture.allowed, "notes.txt");
      writeFileSync(path, "hello");
      assert.deepEqual((await fixture.read(path)).content, [{ type: "text", text: "hello" }]);
      assert.deepEqual((await fixture.read(join(fixture.allowed, "fixture.png"))).content, [
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
  realBwrapTest(
    "preserves the standard read of an allowed non-image device",
    withFixture(async ({ read }) => {
      assert.deepEqual((await read("/dev/null")).content, [{ type: "text", text: "" }]);
    }),
  );

  realBwrapTest(
    "mounts even writable paths read-only for MIME detection",
    withFixture(async ({ allowed, runner, mountArguments }) => {
      const result = await runner.runTool(
        "read",
        { path: join(allowed, "fixture.png") },
        {
          mode: "fs",
          executor: { entrypoint, data: { supportsImages: true } },
        },
      );
      assert.equal(result.content[0]?.type, "image");
      assert.equal(mountArguments.length, 1);
      const args = mountArguments[0]!;
      const index = args.findIndex((arg, index) => arg === allowed && args[index + 1] === allowed);
      assert.equal(args[index - 1], "--ro-bind-try");
    }),
  );

  for (const path of ["allowed/fixture.png", "allowed-alias/fixture.png", "file-alias"]) {
    realBwrapTest(
      `preserves original image bytes through ${path}`,
      withFixture(async (fixture) => {
        const result = await fixture.read(join(fixture.root, path), {
          params: { path: join(fixture.root, path), offset: 999, limit: 1 },
        });
        assert.deepEqual(result.content, [
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ]);
      }),
    );
  }

  for (const alias of ["denied-alias", "credential-alias"]) {
    realBwrapTest(
      `blocks image detection through ${alias}`,
      withFixture(async (fixture) => {
        await assert.rejects(fixture.read(join(fixture.allowed, alias, "fixture.png")), /ENOENT/);
      }),
    );
  }

  for (const directory of ["denied", "credentials-fixture"]) {
    realBwrapTest(
      `rejects the original ${directory} path before detection`,
      withFixture(async (fixture) => {
        fixture.runner.runTool = async () => {
          throw new Error("Read worker must not run");
        };
        await assert.rejects(
          fixture.read(join(fixture.root, directory, "fixture.png")),
          /Access denied/,
        );
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
        const result = await fixture.read(join(fixture.allowed, "fixture.png"), {
          context: { ...fixture.context, model } as GuardedToolContext,
        });
        assert.equal(result.isError, true);
        assert.match((result.content[0] as { text: string }).text, /vision agent/);
        assert.ok(result.content.every((part) => part.type !== "image"));
      }),
    );
  }

  it("excludes SVG and uses extension fallback only when MIME is unknown", () => {
    assert.equal(isVisionImageFile("icon.svg", "image/svg+xml"), false);
    assert.equal(isVisionImageFile("photo.PNG", null), true);
    assert.equal(isVisionImageFile("photo.png", "text/plain"), false);
    assert.equal(isVisionImageFile("notes.txt", "image/jpeg"), true);
    assert.equal(isVisionImageFile("noext", null), false);
  });
});
