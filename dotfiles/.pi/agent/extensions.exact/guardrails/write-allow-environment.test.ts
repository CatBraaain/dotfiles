import { it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { parseGuardrailConfig, resolvePathAction } from "./config.ts";
import { writePaths } from "./sandbox.ts";

it.skipIf(process.platform !== "linux")(
  "uses the existing write action when a variable is absent in WSL",
  () => {
    const variable = "GUARDRAILS_TEST_WINDOWS_PROFILE";
    const windowsProfile = "/mnt/c/Users/GuardrailsTest";
    const previousValue = process.env[variable];
    const previousDistro = process.env.WSL_DISTRO_NAME;
    delete process.env[variable];
    process.env.WSL_DISTRO_NAME = "GuardrailsTest";
    const execFile = spyOn(childProcess, "execFileSync")
      .mockReturnValueOnce("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe\n")
      .mockReturnValueOnce(JSON.stringify({ [variable]: windowsProfile }));

    try {
      const config = parseGuardrailConfig(
        JSON.stringify({ write: [{ ask: "/mnt" }, { allow: `\${${variable}}/pi-work` }] }),
      );
      const callsWhileParsing = execFile.mock.calls.length;
      const section = writePaths(config, "/tmp", new Map());
      assert.equal(resolvePathAction(section, `${windowsProfile}/pi-work/file`), "ask");
      assert.equal(callsWhileParsing, 0);
    } finally {
      execFile.mockRestore();
      if (previousValue === undefined) delete process.env[variable];
      else process.env[variable] = previousValue;
      if (previousDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previousDistro;
    }
  },
);
