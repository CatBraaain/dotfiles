import assert from "node:assert/strict";
import { describe } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realBwrapTest, WORKER_ENTRYPOINT } from "./bwrap-test-support.ts";
import { Guardrail } from "./guardrail.ts";
import { WorkerPool } from "./worker-pool.ts";
import type { SandboxMode } from "./sandbox.ts";

const WORKER = { entrypoint: WORKER_ENTRYPOINT, data: { supportsImages: false } };

describe("real bwrap safety boundaries", () => {
  for (const mode of ["fs", "bash"] as const) {
    realBwrapTest(
      `${mode} rejects writes outside allow with EROFS`,
      withSandbox(async ({ directory, pool, observe }) => {
        const allowed = join(directory, "allowed", "output");
        const blocked = join(directory, "outside");
        const allowedResult = await observe(mode, "write", { path: allowed, content: "x" });
        const blockedResult = await observe(mode, "write", { path: blocked, content: "x" });
        assert.equal(allowedResult.error, undefined);
        assert.match(blockedResult.error ?? "", /EROFS/);
        assert.equal(readFileSync(allowed, "utf8"), "x");
      }),
    );

    realBwrapTest(
      `${mode} permits writes after a dynamic directory grant`,
      withSandbox(async ({ directory, policy, pool, observe }) => {
        const target = join(directory, "requested");
        const path = join(target, "output");
        mkdirSync(target);
        const beforeGrant = await observe(mode, "write", { path, content: "sandbox write" });
        assert.match(beforeGrant.error ?? "", /EROFS/);
        const grant = await policy.requestWritePermission(target, "Test a synthetic fixture", {
          hasUI: true,
          ui: { confirm: async () => true },
        });
        assert.equal(grant.status, "granted");
        assert.equal(grant.grantedPath, target);
        const afterGrant = await observe(mode, "write", { path, content: "sandbox write" });
        assert.equal(afterGrant.error, undefined);
        assert.equal(readFileSync(path, "utf8"), "sandbox write");
      }),
    );
  }

  for (const protectedKind of ["denied", "credential"] as const) {
    realBwrapTest(
      `fs hides ${protectedKind} file and directory contents`,
      withSandbox(async ({ directory, observe }) => {
        const file = join(directory, `${protectedKind}-file`);
        const folder = join(directory, `${protectedKind}-directory`);
        const secret = "synthetic secret";
        writeFileSync(file, secret);
        writeFileSync(join(folder, "secret"), secret);
        const fileContents = await observe("fs", "read", { path: file });
        const directoryContents = await observe("fs", "ls", { path: folder });
        assert.ok(
          fileContents.text === "" || /EACCES|ENOENT/.test(fileContents.error ?? ""),
          `masked file result: ${JSON.stringify(fileContents)}`,
        );
        assert.ok(
          directoryContents.error === undefined && !directoryContents.text.includes("secret"),
          `masked directory result: ${JSON.stringify(directoryContents)}`,
        );
        assert.equal(readFileSync(file, "utf8"), secret);
        assert.equal(readFileSync(join(folder, "secret"), "utf8"), secret);
      }),
    );
  }

  realBwrapTest(
    "bash shares the host network namespace and reaches its loopback server",
    withSandbox(async ({ directory, pool }) => {
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
        const result = await pool.runTool(
          "bash",
          { command: `bun ${JSON.stringify(client)}` },
          { mode: "bash", executor: WORKER },
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

type Observation = { text: string; error?: string };

type SandboxFixture = {
  directory: string;
  policy: Guardrail;
  pool: WorkerPool;
  observe: (
    mode: SandboxMode,
    tool: "read" | "ls" | "write",
    params: Record<string, unknown>,
  ) => Promise<Observation>;
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
      const policy = new Guardrail(directory, config);
      const pool = new WorkerPool(directory, (mode) => policy.buildArgs(mode));
      async function observe(
        mode: SandboxMode,
        tool: "read" | "ls" | "write",
        params: Record<string, unknown>,
      ): Promise<Observation> {
        try {
          const result = await pool.runTool(tool, params, { mode, executor: WORKER });
          return {
            text: result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          };
        } catch (error) {
          return { text: "", error: error instanceof Error ? error.message : String(error) };
        }
      }
      await test({ directory, policy, pool, observe });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
