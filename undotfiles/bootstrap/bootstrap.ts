import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Key = "apt" | "deb-get" | "uv" | "bun" | "go" | "brew" | "brew-cask" | "custom" | "run";
type DeclarativeKey = "uv" | "bun" | "go" | "brew" | "brew-cask";
export type Entry = { key: Key; value: string };
type State = Map<DeclarativeKey, Map<string, string>>;
type CustomHandler = () => void | Promise<void>;

export interface Runtime {
  execute(command: readonly string[]): void;
  output(command: readonly string[]): string;
  outputAllowFailure(command: readonly string[]): string;
  succeeds(command: readonly string[]): boolean;
  log(message: string): void;
  error(message: string): void;
}

const declarativeKeys: readonly DeclarativeKey[] = ["brew-cask", "brew", "bun", "go", "uv"];
const validKeys = new Set<Key>([
  "apt",
  "deb-get",
  "uv",
  "bun",
  "go",
  "brew",
  "brew-cask",
  "custom",
  "run",
]);
const configPath = join(import.meta.dir, "config.yaml");
const androidSdkDir = join(homedir(), ".android-sdk");
const debGetScriptUrl = "https://raw.githubusercontent.com/wimpysworld/deb-get/main/deb-get";

export class Bootstrap {
  private readonly failures: string[] = [];
  private readonly customHandlers: ReadonlyMap<string, CustomHandler>;
  private aptUpdated = false;
  private debGetPrepared = false;

  constructor(
    private readonly entries: readonly Entry[],
    private readonly runtime: Runtime = systemRuntime,
    customHandlers?: ReadonlyMap<string, CustomHandler>,
  ) {
    this.customHandlers = customHandlers ?? this.defaultCustomHandlers();
  }

  async sync(): Promise<number> {
    for (const entry of this.entries) await this.install(entry);

    const states = this.readStates();
    for (const key of declarativeKeys) this.removeUnused(key, states.get(key));
    return this.finish();
  }

  async diff(): Promise<number> {
    const states = this.readStates();
    for (const key of declarativeKeys) {
      const current = states.get(key);
      if (!current) continue;
      for (const name of current.keys()) {
        if (!desiredNames(this.entries, key).has(name)) this.runtime.log(`remove ${key}: ${name}`);
      }
    }

    for (const entry of this.entries) {
      if (isDeclarative(entry.key) && !states.has(entry.key)) continue;
      if (entry.key === "custom") {
        this.runtime.log(`custom: ${entry.value}`);
        if (!this.customHandlers.has(entry.value))
          this.fail(`unknown custom handler: ${entry.value}`);
        continue;
      }
      this.runtime.log(
        entry.key === "run"
          ? `run: ${entry.value}`
          : `install / update ${entry.key}: ${entry.value}`,
      );
    }
    return this.finish();
  }

  private readStates(): State {
    const states: State = new Map();
    for (const key of declarativeKeys) {
      try {
        states.set(key, this.readState(key));
      } catch (error) {
        this.fail(`${key} state: ${message(error)}`);
      }
    }
    return states;
  }

  private readState(key: DeclarativeKey): Map<string, string> {
    switch (key) {
      case "brew":
        return names(this.runtime.output(["brew", "leaves"]));
      case "brew-cask":
        return names(this.runtime.output(["brew", "list", "--cask", "-1"]));
      case "uv":
        return names(this.runtime.output(["uv", "tool", "list"]), uvName);
      case "bun":
        return names(this.runtime.output(["bun", "pm", "ls", "-g"]), bunName);
      case "go":
        return new Map(
          (
            JSON.parse(this.runtime.output(["gup", "list", "--json"])) as Array<{
              import_path: string;
              name: string;
            }>
          ).map((tool) => [tool.import_path, tool.name]),
        );
    }
  }

  private removeUnused(key: DeclarativeKey, current: Map<string, string> | undefined): void {
    if (!current) return;
    const unused = [...current.entries()].filter(
      ([name]) => !desiredNames(this.entries, key).has(name),
    );
    if (unused.length === 0) return;

    this.attempt(`remove ${key}`, () => {
      switch (key) {
        case "brew":
          this.runtime.execute(["brew", "uninstall", ...unused.map(([name]) => name)]);
          return;
        case "brew-cask":
          this.runtime.execute(["brew", "uninstall", "--cask", ...unused.map(([name]) => name)]);
          return;
        case "bun":
          this.runtime.execute(["bun", "remove", "-g", ...unused.map(([name]) => name)]);
          return;
        case "uv":
          this.runtime.execute(["uv", "tool", "uninstall", ...unused.map(([name]) => name)]);
          return;
        case "go":
          this.runtime.execute(["gup", "remove", "--force", ...unused.map(([, binary]) => binary)]);
      }
    });
  }

  private async install(entry: Entry): Promise<void> {
    if (entry.key === "custom") {
      const handler = this.customHandlers.get(entry.value);
      if (!handler) {
        this.fail(`unknown custom handler: ${entry.value}`);
        return;
      }
      await this.attemptAsync(`custom ${entry.value}`, handler);
      return;
    }

    this.attempt(`install ${entry.key}: ${entry.value}`, () => {
      switch (entry.key) {
        case "apt":
          if (!this.aptUpdated) {
            this.runtime.execute(["sudo", "apt", "update"]);
            this.aptUpdated = true;
          }
          this.runtime.execute(["sudo", "apt", "install", "-y", entry.value]);
          return;
        case "deb-get":
          this.installDebGet(entry.value);
          return;
        case "uv":
          this.runtime.execute(["uv", "tool", "install", entry.value]);
          return;
        case "bun":
          this.runtime.execute(["bun", "add", "-g", entry.value]);
          return;
        case "go":
          this.installGo(entry.value);
          return;
        case "brew":
          this.runtime.execute(["brew", "install", entry.value]);
          return;
        case "brew-cask":
          this.runtime.execute(["brew", "install", "--cask", entry.value]);
          return;
        case "run":
          this.runtime.execute(["bash", "-c", entry.value]);
      }
    });
  }

  private defaultCustomHandlers(): ReadonlyMap<string, CustomHandler> {
    return new Map([
      ["android-sdk", () => this.installAndroidSdk()],
      ["drawio", () => this.installDrawio()],
    ]);
  }

  private installGo(specification: string): void {
    const [importPath, version = "latest"] = splitVersion(specification);
    const directory = mkdtempSync("bootstrap-gup-");
    const file = join(directory, "gup.json");
    try {
      writeFileSync(file, JSON.stringify({ packages: [{ import_path: importPath, version }] }));
      this.runtime.execute(["gup", "import", "--file", file]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private installAndroidSdk(): void {
    this.runtime.execute([
      "android",
      `--sdk=${androidSdkDir}`,
      "sdk",
      "install",
      "cmdline-tools/latest",
      "platform-tools",
    ]);
  }

  private installDebGet(packageName: string): void {
    if (!this.debGetPrepared) {
      if (!this.runtime.succeeds(["deb-get", "version"])) {
        this.runtime.execute(["sudo", "apt", "install", "-y", "curl", "lsb-release", "wget", "jq"]);
        this.runtime.execute([
          "bash",
          "-c",
          `curl -fsSL ${debGetScriptUrl} | sudo -E bash -s install deb-get`,
        ]);
      }
      this.debGetPrepared = true;
    }
    this.runtime.execute(["deb-get", "install", packageName]);
  }

  private async installDrawio(): Promise<void> {
    const tag = this.runtime.output([
      "gh",
      "release",
      "view",
      "--repo",
      "jgraph/drawio-desktop",
      "--json",
      "tagName",
      "--jq",
      ".tagName",
    ]);
    if (
      this.runtime.outputAllowFailure(["dpkg-query", "-W", "-f=${Version}", "draw.io"]) ===
      tag.replace(/^v/, "")
    )
      return;

    const directory = await mkdtemp(join(tmpdir(), "bootstrap-drawio-"));
    try {
      this.runtime.execute([
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        "jgraph/drawio-desktop",
        "--pattern",
        "drawio-amd64-*.deb",
        "--dir",
        directory,
      ]);
      const file = readdirSync(directory).find((name) => name.endsWith(".deb"));
      if (!file) throw new Error("draw.io release archive is missing a deb package");
      this.runtime.execute(["sudo", "apt", "install", "-y", join(directory, file)]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private attempt(label: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.fail(`${label}: ${message(error)}`);
    }
  }

  private async attemptAsync(label: string, action: CustomHandler): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.fail(`${label}: ${message(error)}`);
    }
  }

  private fail(problem: string): void {
    this.failures.push(problem);
    this.runtime.error(problem);
  }

  private finish(): number {
    return this.failures.length === 0 ? 0 : 1;
  }
}

export function parseConfig(source: string): Entry[] {
  const parsed = Bun.YAML.parse(source);
  if (!Array.isArray(parsed)) throw new Error("config top-level value must be an array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`config entry ${index + 1} must be a map`);
    const entries = Object.entries(item);
    if (entries.length !== 1) throw new Error(`config entry ${index + 1} must have one key`);
    const [key, value] = entries[0]!;
    if (!validKeys.has(key as Key) || typeof value !== "string")
      throw new Error(`invalid config entry ${index + 1}`);
    return { key: key as Key, value };
  });
}

function desiredNames(entries: readonly Entry[], key: DeclarativeKey): Set<string> {
  return new Set(
    entries.filter((entry) => entry.key === key).map((entry) => packageName(key, entry.value)),
  );
}

function packageName(key: DeclarativeKey, value: string): string {
  if (key === "brew" || key === "brew-cask") return value;
  if (key === "go") return splitVersion(value)[0];
  if (key === "bun") return bunName(value);
  return value.split(/[<>=!~[ ;]/, 1)[0]!;
}

function bunName(value: string): string {
  const line = value.trim();
  const packageValue = line.match(/^[├└]──\s+(\S+)/)?.[1];
  if (line.startsWith("/") || (!packageValue && line.startsWith("-"))) return "";

  const packageSpec = packageValue ?? line.split(/\s+/, 1)[0]!;
  const versionAt = packageSpec.lastIndexOf("@");
  return versionAt > 0 ? packageSpec.slice(0, versionAt) : packageSpec;
}

function splitVersion(value: string): [string, string | undefined] {
  const index = value.lastIndexOf("@");
  return index > 0 ? [value.slice(0, index), value.slice(index + 1)] : [value, undefined];
}

function uvName(value: string): string {
  const line = value.trim();
  return line.startsWith("-") ? "" : line.split(/\s+/, 1)[0]!;
}

function names(output: string, name = (line: string) => line): Map<string, string> {
  return new Map(
    output
      .split("\n")
      .map((line) => name(line.trim()))
      .filter(Boolean)
      .map((packageName) => [packageName, packageName]),
  );
}

function isDeclarative(key: Key): key is DeclarativeKey {
  return declarativeKeys.includes(key as DeclarativeKey);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const systemRuntime: Runtime = {
  execute(command) {
    const result = Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) throw new Error(command.join(" "));
  },
  output(command) {
    const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.toString().trim() || command.join(" "));
    return result.stdout.toString().trim();
  },
  outputAllowFailure(command) {
    const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : "";
  },
  succeeds(command) {
    try {
      return Bun.spawnSync([...command], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      return false;
    }
  },
  log(message) {
    console.log(message);
  },
  error(message) {
    console.error(message);
  },
};

export async function run(
  arguments_: readonly string[],
  readConfig = () => Bun.file(configPath).text(),
  runtime: Runtime = systemRuntime,
): Promise<number> {
  const [command] = arguments_;
  if (arguments_.length !== 1 || (command !== "sync" && command !== "diff")) {
    runtime.error("usage: bun undotfiles/bootstrap/bootstrap.ts <sync|diff>");
    return 1;
  }

  try {
    const bootstrap = new Bootstrap(parseConfig(await readConfig()), runtime);
    return command === "sync" ? await bootstrap.sync() : await bootstrap.diff();
  } catch (error) {
    runtime.error(message(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));
