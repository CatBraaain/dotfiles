import { it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { readWslWindowsEnvironment } from "./windows-environment.ts";

it("reads only requested Windows names without forwarding Linux variables", () => {
  const windowsPowerShell = "/windows/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const windowsProfile = "C:\\Users\\Example";
  const expectedProfile = "/windows/c/Users/Example";
  const execFile = spyOn(childProcess, "execFileSync");
  execFile.mockReturnValueOnce(windowsPowerShell + "\n");
  execFile.mockReturnValueOnce(
    JSON.stringify({
      USERPROFILE: windowsProfile,
      USERNAME: "Example",
      MISSING: null,
      BROKEN: "Z:\\Unknown",
    }),
  );
  execFile.mockReturnValueOnce(expectedProfile + "\n");
  execFile.mockImplementationOnce(() => {
    throw new Error("Drive unavailable");
  });
  try {
    const values = readWslWindowsEnvironment(["UserProfile", "USERNAME", "missing", "BROKEN"]);
    assert.deepEqual(
      [...values],
      [
        ["UserProfile", expectedProfile],
        ["USERNAME", "Example"],
      ],
    );
    const [executable, args, options] = execFile.mock.calls[1] ?? [];
    assert.equal(executable, windowsPowerShell);
    assert.deepEqual(Array.isArray(args) && args.slice(0, 3), [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    assert.equal(options?.env?.WSLENV, "");
    assert.equal(
      options && "input" in options ? options.input : undefined,
      '["USERPROFILE","USERNAME","MISSING","BROKEN"]',
    );
    assert.deepEqual(execFile.mock.calls[2]?.slice(0, 2), [
      "/usr/bin/wslpath",
      ["-a", "-u", windowsProfile],
    ]);
    assert.equal(execFile.mock.calls[0]?.[0], "/usr/bin/wslpath");
  } finally {
    execFile.mockRestore();
  }
});
