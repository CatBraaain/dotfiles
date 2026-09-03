// Clone repositories listed in repos.txt into ~/projects/.
//
// repos.txt format:
//   - one repository URL per line
//   - '#' starts a comment; blank lines are ignored
// Behavior:
//   - destination is ~/projects/<repo> (trailing '/' and '.git' are stripped)
//   - existing destination directories are skipped (no pull)
//   - a failed clone does not stop the rest; the script always exits 0

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const listPath = join(import.meta.dir, "repos.txt");
const projectsRoot = join(homedir(), "projects");

const stripComment = (line: string): string => line.replace(/#.*$/, "").trim();

const repoNameOf = (url: string): string | null => {
  const name = url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .pop();
  return name === "" ? null : name;
};

type Status = "cloned" | "skipped" | "failed";

const urls = readFileSync(listPath, "utf-8")
  .split(/\r?\n/)
  .map(stripComment)
  .filter((line) => line !== "");

const statuses: Status[] = [];
mkdirSync(projectsRoot, { recursive: true });

for (const url of urls) {
  const name = repoNameOf(url);
  if (!name) {
    statuses.push("failed");
    console.error(`✗ failed ${url}: cannot determine repository name`);
    continue;
  }
  const dest = join(projectsRoot, name);
  if (existsSync(dest)) {
    statuses.push("skipped");
    console.log(`- skipped ${dest} (exists)`);
    continue;
  }
  const proc = Bun.spawnSync(["git", "clone", url, dest], { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode === 0) {
    statuses.push("cloned");
    console.log(`✓ cloned ${url} -> ${dest}`);
  } else {
    statuses.push("failed");
    console.error(`✗ failed ${url}`);
  }
}

const count = (status: Status) => statuses.filter((s) => s === status).length;
console.log(
  `repos: ${count("cloned")} cloned, ${count("skipped")} skipped, ${count("failed")} failed`,
);
