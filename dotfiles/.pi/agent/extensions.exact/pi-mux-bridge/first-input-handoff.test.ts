import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { firstInputDirectory } from "../../../../.local/cli.exact/pi-mux/src/main.ts";
import { firstInputRoot } from "./first-input-handoff.ts";

describe("first input storage", () => {
  const id = "01234567-0123-4567-8901-012345678901";

  it("uses the same dedicated directory in both processes on Linux", () => {
    const root = firstInputRoot({ platform: "linux", agentDir: "/home/test/.pi/agent" });
    assert.equal(root, "/home/test/.pi/agent/pi-tmux/first-input");
    assert.equal(firstInputDirectory("/home/test/.pi/agent/pi-tmux", id, "linux"), root + "/" + id);
  });

  it("uses Windows local user data and does not fall back to another directory", () => {
    const localAppData = "C:/Users/Test/AppData/Local";
    const agentDir = "D:/agent";
    const location = { platform: "win32" as const, agentDir };
    const root = firstInputRoot({ ...location, localAppData });
    assert.equal(root, "C:\\Users\\Test\\AppData\\Local\\pi-mux-first-input");
    assert.equal(firstInputDirectory(agentDir, id, "win32", localAppData), root + "\\" + id);
    for (const path of ["", "relative", "\\\\server\\share", "\\rooted"]) {
      assert.equal(firstInputRoot({ ...location, localAppData: path }), undefined);
      assert.equal(firstInputDirectory(agentDir, id, "win32", path), undefined);
    }
  });

  it("rejects non-conversation path components", () => {
    assert.equal(firstInputDirectory("/tmp/test", "../text", "linux"), undefined);
    assert.equal(
      firstInputDirectory("D:/agent", "CON", "win32", "C:/Users/Test/AppData/Local"),
      undefined,
    );
  });
});
