import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { it } from "bun:test";
import { selectExtensionTarget, syncMarketplaceExtensions } from "../extensions.apply.ts";

it.skipIf(process.platform !== "linux")(
  "uses the WSL Server CLI even if the Windows launcher is first",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vscode-extension-target-"));
    try {
      const windows = join(root, "windows", "bin", "code");
      const remote = join(root, "vscode-server", "bin", "remote-cli", "code");
      const serverBin = dirname(dirname(remote));
      const server = join(serverBin, "code-server");
      for (const cli of [windows, remote, server]) {
        await mkdir(dirname(cli), { recursive: true });
        await writeFile(cli, "#!/bin/sh\n", { mode: 0o755 });
      }
      await writeFile(join(serverBin, "..", "node"), "\x7fELF");
      const path = [dirname(windows), dirname(remote)].join(delimiter);
      assert.deepEqual(await selectExtensionTarget("linux", true, path, root), {
        label: "wsl",
        code: server,
      });
      assert.equal(await selectExtensionTarget("linux", true, dirname(windows), root), undefined);

      await rm(server);
      await symlink(windows, server);
      assert.equal(await selectExtensionTarget("linux", true, path, root), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "uses the only installed WSL Server without a remote terminal and skips ambiguous installs",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vscode-extension-server-"));
    try {
      const oldRoot = join(root, "bin", "older");
      const currentRoot = join(root, "cli", "servers", "Stable-current", "server");
      async function installServerFixture(serverRoot: string) {
        const bin = join(serverRoot, "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(join(serverRoot, "node"), "\x7fELF");
        const cli = join(bin, "code-server");
        await writeFile(cli, "#!/bin/sh\n", { mode: 0o755 });
        return cli;
      }
      const path = join(root, "no-cli-on-path");
      const currentCli = await installServerFixture(currentRoot);
      assert.deepEqual(await selectExtensionTarget("linux", true, path, root), {
        label: "wsl",
        code: currentCli,
      });

      await installServerFixture(oldRoot);
      assert.equal(await selectExtensionTarget("linux", true, path, root), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("uses only the native Windows CLI to sync the Windows allowlist", async () => {
  const code = "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd";
  const calls: string[][] = [];
  const existing = [
    "MS-VSCODE-REMOTE.REMOTE-WSL@1.0.0",
    "catbraaain.vscode-custom-patch@1.0.0",
    "todo-lsp.todo@1.0.0",
    "agent-kit.agent-kit@1.0.0",
    "some.other@1.0.0",
  ].join("\r\n");
  await syncMarketplaceExtensions({ label: "windows", code }, async (argv) => {
    calls.push(argv);
    return argv.includes("--list-extensions") ? existing : "";
  });

  assert.deepEqual(calls, [
    [code, "--list-extensions", "--show-versions"],
    [code, "--install-extension", "tomoki1207.pdf"],
    [code, "--uninstall-extension", "some.other"],
  ]);
});

it("does not change Windows or WSL extensions if listing fails", async () => {
  for (const label of ["windows", "wsl"] as const) {
    const calls: string[][] = [];
    const code = label === "windows" ? "code.cmd" : "code-server";
    await assert.rejects(
      syncMarketplaceExtensions({ label, code }, async (argv) => {
        calls.push(argv);
        throw new Error("listing failed");
      }),
      /could not list .* extensions/,
    );
    assert.deepEqual(calls, [[code, "--list-extensions", "--show-versions"]]);
  }
});
