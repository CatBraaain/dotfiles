import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { it } from "bun:test";
import {
  applyExtensions,
  selectExtensionTarget,
  syncMarketplaceExtensions,
} from "../extensions.apply.ts";

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

async function syncWithUninstallFailure(stderr: string) {
  const root = await mkdtemp(join(tmpdir(), "vscode-extension-uninstall-"));
  try {
    const code = join(root, "code-fixture");
    await writeFile(join(root, "failure.txt"), stderr);
    await writeFile(
      code,
      `#!/bin/sh
case "$1:$2" in
  --list-extensions:--show-versions)
    printf '%s\\n' ms-vscode-remote.remote-wsl@1 tomoki1207.pdf@1 pack.parent@1 pack.child@1 pack.remaining@1 ;;
  --uninstall-extension:pack.child)
    printf '%s\\n' 'Removed pack.child and pack.parent' ;;
  --uninstall-extension:pack.parent)
    cat "\${0%/*}/failure.txt" >&2
    exit 1 ;;
  --uninstall-extension:pack.remaining)
    printf '%s\\n' 'Removed pack.remaining' ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { applyExtensions } from ${JSON.stringify(new URL("../extensions.apply.ts", import.meta.url).href)};
         await applyExtensions("win32", false, {
           selectTarget: async () => ({ label: "windows", code: process.argv[1] }),
         });`,
        code,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderrOutput] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr: stderrOutput };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")(
  "does not report a bundled extension already removed by the preceding uninstall",
  async () => {
    const result = await syncWithUninstallFailure(
      "Extension 'pack.parent' is not installed.\r\n" +
        "Make sure you use the full extension ID, including the publisher, e.g.: ms-dotnettools.csharp\r\n",
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /is not installed/);
    assert.match(result.stdout, /Removed pack\.child and pack\.parent/);
    assert.match(result.stdout, /Removed pack\.remaining/);
  },
);

it.skipIf(process.platform === "win32")("reports other uninstall failures", async () => {
  const result = await syncWithUninstallFailure("Permission denied\n");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Permission denied/);
});

it.skipIf(process.platform === "win32")(
  "reports a missing extension with a different ID",
  async () => {
    const result = await syncWithUninstallFailure("Extension 'pack.other' is not installed.\n");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Extension 'pack\.other' is not installed\./);
  },
);

const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

function bridgeCommand(argv: string[]) {
  assert.deepEqual(argv.slice(0, -1), [
    powershell,
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  const encoded = argv.at(-1);
  assert.ok(encoded);
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /Get-Command code\.cmd -CommandType Application/);
  const invocation = script.match(/& \$code\.Source ([^;]+); exit \$LASTEXITCODE$/);
  assert.ok(invocation?.[1]);
  return invocation[1];
}

it("syncs each WSL and Windows extension list with its own CLI and policy", async () => {
  const server = "/vscode-server/bin/code-server";
  const wslCalls: string[][] = [];
  const windowsCalls: string[] = [];
  const localInstalls: string[] = [];
  await applyExtensions("linux", true, {
    selectTarget: async () => ({ label: "wsl", code: server }),
    findPowerShell: () => powershell,
    installLocal: async (target) => {
      localInstalls.push(target.code);
    },
    run: async (argv, options) => {
      if (argv[0] === server) {
        wslCalls.push(argv.slice(1));
        return "tomoki1207.pdf@1.0.0";
      }
      const command = bridgeCommand(argv);
      windowsCalls.push(command);
      if (command === "'--uninstall-extension' 'some.other'") {
        assert.equal(options?.ignoreFailure?.("Extension 'some.other' is not installed."), true);
      }
      return "ms-vscode-remote.remote-wsl@1.0.0\r\ncatbraaain.vscode-custom-patch@1.0.0\r\nsome.other@1.0.0";
    },
  });
  assert.deepEqual(localInstalls, [server]);
  assert.deepEqual(wslCalls[0], ["--list-extensions", "--show-versions"]);
  assert.deepEqual(wslCalls.at(-1), ["--uninstall-extension", "tomoki1207.pdf"]);
  assert.deepEqual(windowsCalls, [
    "'--list-extensions' '--show-versions'",
    "'--install-extension' 'tomoki1207.pdf'",
    "'--uninstall-extension' 'some.other'",
  ]);
});

it("syncs Windows even when no WSL Server CLI was found", async () => {
  const windowsCalls: string[] = [];
  await applyExtensions("linux", true, {
    selectTarget: async () => undefined,
    findPowerShell: () => powershell,
    run: async (argv) => {
      windowsCalls.push(bridgeCommand(argv));
      return "ms-vscode-remote.remote-wsl@1.0.0\ntomoki1207.pdf@1.0.0";
    },
  });
  assert.deepEqual(windowsCalls, ["'--list-extensions' '--show-versions'"]);
});

it("finishes WSL sync without mutating Windows when Windows listing fails", async () => {
  const server = "/vscode-server/bin/code-server";
  const wslCalls: string[][] = [];
  const windowsCalls: string[] = [];
  await assert.rejects(
    applyExtensions("linux", true, {
      selectTarget: async () => ({ label: "wsl", code: server }),
      installLocal: async () => {},
      findPowerShell: () => powershell,
      run: async (argv) => {
        if (argv[0] === server) {
          wslCalls.push(argv.slice(1));
          return "some.other@1.0.0";
        }
        windowsCalls.push(bridgeCommand(argv));
        throw new Error("listing failed");
      },
    }),
    (error: unknown) =>
      error instanceof AggregateError &&
      /could not list windows extensions: Error: listing failed/.test(String(error.errors[0])),
  );
  assert.deepEqual(wslCalls.at(-1), ["--uninstall-extension", "some.other"]);
  assert.deepEqual(windowsCalls, ["'--list-extensions' '--show-versions'"]);
});

it("does not try Windows interop outside WSL", async () => {
  await applyExtensions("win32", false, {
    selectTarget: async () => ({ label: "windows", code: "code.cmd" }),
    findPowerShell: () => assert.fail("Windows interop should not run"),
    run: async (argv) => {
      assert.deepEqual(argv, ["code.cmd", "--list-extensions", "--show-versions"]);
      return "ms-vscode-remote.remote-wsl@1.0.0\ntomoki1207.pdf@1.0.0";
    },
  });
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
