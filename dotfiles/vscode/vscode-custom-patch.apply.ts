import { $ } from "bun";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const extensionId = "catbraaain.vscode-custom-patch";
const vsixPattern = /^vscode-custom-patch-(\d+\.\d+\.\d+)\.data\.vsix$/;
const windowsCode = [
  "powershell.exe",
  "-NoProfile",
  "-Command",
  "Set-Location -LiteralPath $env:SystemRoot -ErrorAction Stop; code",
];
type Target = "linux" | "windows";
type Run = (argv: string[], cwd?: string) => Promise<string>;

async function main(): Promise<void> {
  if (process.platform !== "linux") return;
  const { DOTFILES_HOME_ROOT: homeRoot, DOTFILES_DIST_DIR: distRoot } = process.env;
  const scriptPath = process.argv[1];
  if (!homeRoot || !distRoot || !scriptPath) throw new Error("apply hook paths are not set");
  const homeRelativeDir = relative(homeRoot, dirname(scriptPath));
  if (
    isAbsolute(homeRelativeDir) ||
    homeRelativeDir === ".." ||
    homeRelativeDir.startsWith(`..${sep}`)
  ) {
    throw new Error("apply hook must run from inside the home root");
  }
  const targets: Target[] = [];
  if (Bun.which("code")) targets.push("linux");
  const kernel = await readFile("/proc/version", "utf8").catch(() => "");
  if (/microsoft/i.test(kernel) && Bun.which("powershell.exe")) targets.push("windows");
  await applyCustomPatch(join(distRoot, homeRelativeDir), homeRoot, targets);
}

export async function applyCustomPatch(
  vscodeDir: string,
  homeRoot: string,
  targets: Target[],
  run: Run = runCommand,
): Promise<void> {
  if (targets.length === 0) return;
  const packages = (await readdir(vscodeDir)).filter((name) => vsixPattern.test(name));
  const [fileName] = packages;
  if (!fileName || packages.length !== 1) {
    throw new Error(
      `expected one vscode-custom-patch VSIX in ${vscodeDir}, found ${packages.length}`,
    );
  }
  const version = vsixPattern.exec(fileName)?.[1];
  const vsixPath = join(vscodeDir, fileName);
  const contentHash = (await readFile(`${vsixPath}.sha256`, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(contentHash))
    throw new Error(`invalid VSIX content hash: ${vsixPath}`);

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const code = target === "windows" ? windowsCode : ["code"];
      const receipt = join(
        homeRoot,
        ".cache/dotfiles/vscode-extensions",
        target,
        `${extensionId}.sha256`,
      );
      const installed = (await run([...code, "--list-extensions", "--show-versions"]))
        .split(/\r?\n/)
        .some((entry) => entry.trim().toLowerCase() === `${extensionId}@${version}`);
      if (!installed || (await readReceipt(receipt)) !== contentHash) {
        const installPath =
          target === "windows" ? await windowsInstallerPath(vsixPath, run) : vsixPath;
        console.log(`[${target}] install ${installPath}`);
        await run([...code, "--install-extension", installPath, "--force"]);
        await writeReceipt(receipt, contentHash);
      }
      if (target === "linux") {
        await run(
          [process.execPath, "run", "inject", join(vscodeDir, "scm-collapse.data.js")],
          join(vscodeDir, "extensions.data.projects/vscode-custom-patch"),
        );
      }
    }),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" ? [`[${targets[index]}] ${result.reason}`] : [],
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

async function windowsInstallerPath(vsixPath: string, run: Run): Promise<string> {
  const windowsPath = (await run(["wslpath", "-w", vsixPath])).trimEnd();
  return `'${windowsPath.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

async function readReceipt(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeReceipt(path: string, contentHash: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempDir = await mkdtemp(join(parent, ".stage-"));
  try {
    const tempPath = join(tempDir, "content.sha256");
    await writeFile(tempPath, `${contentHash}\n`);
    await rename(tempPath, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runCommand(argv: string[], cwd?: string): Promise<string> {
  const command = $`${argv}`.quiet();
  if (cwd) command.cwd(cwd);
  const { stdout, stderr, exitCode } = await command.nothrow();
  if (stderr.length > 0) process.stderr.write(stderr);
  if (exitCode !== 0) throw new Error(`${argv[0]} exited with code ${exitCode}`);
  if (!argv.includes("--list-extensions") && argv[0] !== "wslpath" && stdout.length > 0) {
    process.stdout.write(stdout);
  }
  return stdout.toString();
}

if (import.meta.main) await main();
