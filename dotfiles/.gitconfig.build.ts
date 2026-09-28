import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const repo = "GitAlias/gitalias";
const mirrorDir = join(homedir(), "mirrors", "github.com", repo);
const pullTimeFile = join(mirrorDir, ".git", "build-pull-time");
const ttlMs = 6 * 60 * 60 * 1000;

async function runGit(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return { ok: (await proc.exited) === 0, stderr: stderr.trim() };
}

async function syncMirror(): Promise<void> {
  await mkdir(dirname(mirrorDir), { recursive: true });
  if (!existsSync(mirrorDir)) {
    const url = `https://github.com/${repo}.git`;
    const result = await runGit(["clone", "--depth", "1", "--quiet", url, mirrorDir]);
    if (!result.ok) throw new Error(`git clone failed for ${url}: ${result.stderr}`);
    await writeFile(pullTimeFile, `${Date.now()}\n`);
    return;
  }

  const lastPull = existsSync(pullTimeFile)
    ? Number((await readFile(pullTimeFile, "utf8")).trim())
    : NaN;
  if (process.env.BUILD_FORCE_PULL !== "1" && Date.now() - lastPull < ttlMs) return;
  const result = await runGit(["-C", mirrorDir, "pull", "--ff-only", "--quiet"]);
  if (!result.ok) {
    console.error(`warning: git pull failed for ${repo}: ${result.stderr}`);
    return;
  }
  await mkdir(dirname(pullTimeFile), { recursive: true });
  await writeFile(pullTimeFile, `${Date.now()}\n`);
}

export default async function build(): Promise<void> {
  if (process.platform === "darwin") return;
  await syncMirror();
  const configPath = join(import.meta.dir, ".gitconfig");
  const [config, aliases] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(join(mirrorDir, "gitalias.txt"), "utf8"),
  ]);
  // Git uses the last definition of an alias. Replay the hand-written sections
  // after the upstream append so existing overrides keep their effective value.
  const localAliases = config
    .split(/(?=^\[)/m)
    .filter((section) => /^\[alias\]\s*(?:\r?\n|$)/.test(section))
    .join("");
  const appended = config + (config.endsWith("\n") ? "" : "\n") + aliases;
  await writeFile(
    configPath,
    appended + (localAliases ? (appended.endsWith("\n") ? "" : "\n") + localAliases : ""),
  );
}
