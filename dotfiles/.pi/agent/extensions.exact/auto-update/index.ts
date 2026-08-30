import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (event) => {
    // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
    // event.previousSessionFile - present for "new", "resume", and "fork"
    if (event.reason === "startup") {
      const child = spawn("pi", ["update", "--extensions"], {
        detached: true,
        stdio: "ignore",
        shell: true,
      });
      child.unref();
    }
  });
}
