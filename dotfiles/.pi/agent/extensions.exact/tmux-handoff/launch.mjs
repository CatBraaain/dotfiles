import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPrivatePath,
  cleanEnvironment,
  manifestSchema,
  readPrivateJson,
} from "./protocol.mjs";

export function launch(directory) {
  assertPrivatePath(directory, true);
  const manifestPath = join(directory, "manifest.json");
  try {
    const manifest = readPrivateJson(manifestPath, manifestSchema);
    rmSync(manifestPath);
    writeFileSync(join(directory, "startup.json"), JSON.stringify(manifest.startup), {
      mode: 0o600,
      flag: "wx",
    });
    const env = {
      ...cleanEnvironment(manifest.env),
      TERM: process.env.TERM,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      PI_TMUX_HANDOFF: directory,
    };
    process.chdir(manifest.cwd);
    process.execve(
      manifest.execPath,
      [manifest.execPath, ...manifest.execArgv, ...manifest.argv],
      env,
    );
    throw new Error("Backend execve returned");
  } catch {
    rmSync(manifestPath, { force: true });
    writeFileSync(
      join(directory, "error.json"),
      JSON.stringify({ error: "Backend launch failed" }),
      {
        mode: 0o600,
      },
    );
    throw new Error("Backend launch failed");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = process.argv[2];
    if (!directory || !existsSync(directory)) throw new Error("Missing handoff directory");
    launch(directory);
  } catch {
    process.stderr.write("tmux-handoff: backend launch failed\n");
    process.exit(1);
  }
}
