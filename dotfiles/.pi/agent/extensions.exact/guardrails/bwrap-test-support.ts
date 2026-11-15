import { it } from "bun:test";
import { spawnSync } from "node:child_process";

export function probeBwrap(
  args = [
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--",
    "true",
  ],
): boolean {
  const probe = spawnSync("bwrap", args, { encoding: "utf8", timeout: 5000 });
  if (probe.status === 0) return true;
  const reason = probe.error?.message || probe.stderr.trim() || `exit ${probe.status}`;
  console.warn(`SKIP real bwrap integration tests: ${reason}`);
  return false;
}

export const realBwrapTest = it.skipIf(!probeBwrap());
