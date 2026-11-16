import assert from "node:assert/strict";
import { describe } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realBwrapTest } from "./bwrap-test-support.ts";
import { Guardrail } from "./guardrail.ts";
import { SandboxRunner } from "./sandbox-runner.ts";
import type { SandboxMode } from "./sandbox.ts";

describe("real bwrap safety boundaries", () => {
  for (const mode of ["fs", "bash"] as const) {
    realBwrapTest(
      `${mode} rejects writes outside allow with EROFS`,
      withSandbox(async ({ directory, runner, observe }) => {
        const allowed = join(directory, "allowed", "output");
        const blocked = join(directory, "outside");
        const allowedResult = await observe(runner, "write", allowed, mode);
        const blockedResult = await observe(runner, "write", blocked, mode);
        assert.equal(allowedResult, "written");
        assert.deepEqual(blockedResult, { code: "EROFS" });
      }),
    );

    realBwrapTest(
      `${mode} permits writes after a dynamic directory grant`,
      withSandbox(async ({ directory, policy, runner, observe }) => {
        const target = join(directory, "requested");
        const path = join(target, "output");
        mkdirSync(target);
        const beforeGrant = await observe(runner, "write", path, mode);
        assert.deepEqual(beforeGrant, { code: "EROFS" });
        const grant = await policy.requestWritePermission(target, "Test a synthetic fixture", {
          hasUI: true,
          ui: { confirm: async () => true },
        });
        assert.equal(grant.status, "granted");
        assert.equal(grant.grantedPath, target);
        const afterGrant = await observe(runner, "write", path, mode);
        assert.equal(afterGrant, "written");
        assert.equal(readFileSync(path, "utf8"), "sandbox write");
      }),
    );
  }

  for (const protectedKind of ["denied", "credential"] as const) {
    realBwrapTest(
      `fs hides ${protectedKind} file and directory contents`,
      withSandbox(async ({ directory, runner, observe }) => {
        const file = join(directory, `${protectedKind}-file`);
        const folder = join(directory, `${protectedKind}-directory`);
        const secret = "synthetic secret";
        writeFileSync(file, secret);
        writeFileSync(join(folder, "secret"), secret);
        const fileContents = await observe(runner, "read", file, "fs");
        const directoryContents = await observe(runner, "list", folder, "fs");
        assert.ok(
          fileContents === "" ||
            (typeof fileContents === "object" &&
              fileContents !== null &&
              "code" in fileContents &&
              ["EACCES", "ENOENT"].includes(String(fileContents.code))),
          `masked file result: ${JSON.stringify(fileContents)}`,
        );
        assert.deepEqual(directoryContents, []);
        assert.equal(readFileSync(file, "utf8"), secret);
        assert.equal(readFileSync(join(folder, "secret"), "utf8"), secret);
      }),
    );
  }

  realBwrapTest(
    "bash shares the host network namespace and reaches its loopback server",
    withSandbox(async ({ directory, runner }) => {
      const marker = "host loopback reached";
      const server = createServer((socket) => socket.end(marker));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const client = join(directory, "network-client.ts");
        writeFileSync(
          client,
          `import { connect } from "node:net";
          import { readlinkSync } from "node:fs";
          console.log(readlinkSync("/proc/self/ns/net"));
          const socket = connect({ host: "127.0.0.1", port: ${address.port} });
          socket.setTimeout(2000, () => socket.destroy(new Error("loopback timeout")));
          socket.on("data", (data) => process.stdout.write(data));
          socket.on("error", (error) => { console.error(error); process.exitCode = 1; });`,
        );
        const result = await runner.runTool(
          "bash",
          { command: `bun ${JSON.stringify(client)}` },
          { mode: "bash" },
        );
        assert.equal(result.isError, undefined);
        const output = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const expectedOutput = `${readlinkSync("/proc/self/ns/net")}\n${marker}`;
        assert.equal(output.trim(), expectedOutput);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }),
  );
});

type SandboxFixture = {
  directory: string;
  policy: Guardrail;
  runner: SandboxRunner;
  observe: (
    runner: SandboxRunner,
    operation: "read" | "list" | "write",
    path: string,
    mode: SandboxMode,
  ) => Promise<unknown>;
};

function withSandbox(test: (fixture: SandboxFixture) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "real-bwrap-boundary-"));
    try {
      const deniedFile = join(directory, "denied-file");
      const deniedDirectory = join(directory, "denied-directory");
      const credentialFile = join(directory, "credential-file");
      const credentialDirectory = join(directory, "credential-directory");
      for (const folder of [deniedDirectory, credentialDirectory]) mkdirSync(folder);
      for (const file of [deniedFile, credentialFile]) writeFileSync(file, "synthetic secret");
      const config = join(directory, "config.yaml");
      writeFileSync(
        config,
        JSON.stringify({
          read: [{ allow: "*" }, { deny: [deniedFile, deniedDirectory] }],
          write: [{ allow: join(directory, "allowed") }],
          credentials: [credentialFile, credentialDirectory],
        }),
      );
      const entrypoint = join(directory, "observe.ts");
      writeFileSync(
        entrypoint,
        `import { readFileSync, readdirSync, writeFileSync } from "node:fs";
        const { params } = JSON.parse(readFileSync(0, "utf8"));
        let observed;
        try {
          switch (params.operation) {
            case "read": observed = readFileSync(params.path, "utf8"); break;
            case "list": observed = readdirSync(params.path); break;
            case "write": writeFileSync(params.path, "sandbox write"); observed = "written"; break;
            default: throw new Error("Unknown observation");
          }
        } catch (error) { observed = { code: error.code }; }
        console.log(JSON.stringify({ ok: true, result: { content: [], details: { observed } } }));`,
      );
      const policy = new Guardrail(directory, config);
      const runner = new SandboxRunner(directory, (mode) => policy.buildArgs(mode));
      async function observe(
        runner: SandboxRunner,
        operation: "read" | "list" | "write",
        path: string,
        mode: SandboxMode,
      ): Promise<unknown> {
        const result = await runner.runTool(
          "read",
          { operation, path },
          {
            mode,
            executor: { entrypoint },
          },
        );
        return result.details.observed;
      }
      await test({ directory, policy, runner, observe });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
