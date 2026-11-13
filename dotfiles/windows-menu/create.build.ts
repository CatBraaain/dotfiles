import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

export type ShortcutSpec = {
  name: string;
  command: string;
};

export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function lnkArguments(command: string): string {
  return `-NoProfile -WindowStyle Hidden -Command "${command}"`;
}

export function loadShortcuts(value: unknown): ShortcutSpec[] {
  if (!Array.isArray(value)) throw new Error("shortcuts must be an array");
  return value.map((entry): ShortcutSpec => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("shortcut entry must be an object");
    }
    const { name, command } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name === "" || /[\\/]/.test(name)) {
      throw new Error(`invalid shortcut name: ${String(name)}`);
    }
    if (typeof command !== "string" || command === "") {
      throw new Error(`invalid shortcut command for: ${String(name)}`);
    }
    return { name, command };
  });
}

export function readShortcuts(): ShortcutSpec[] {
  const raw = readFileSync(join(import.meta.dir, "shortcuts.data.yaml"), "utf8");
  const data: unknown = YAML.parse(raw);
  if (typeof data !== "object" || data === null || Array.isArray(data) || !("shortcuts" in data)) {
    throw new Error("shortcuts.data.yaml must have a shortcuts key");
  }
  return loadShortcuts((data as { shortcuts: unknown }).shortcuts);
}

export function shortcutScript(outDir: string, specs: readonly ShortcutSpec[]): string {
  const lines = [
    '$ErrorActionPreference = "Stop"',
    "$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source",
    'if (-not $pwsh) { $pwsh = Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\powershell.exe" }',
    "$shell = New-Object -ComObject WScript.Shell",
    "$targets = @(",
    ...specs.map(
      (spec) =>
        `  @{ Path = ${psLiteral(join(outDir, `${spec.name}.lnk`))}; Arguments = ${psLiteral(lnkArguments(spec.command))} }`,
    ),
    ")",
    "foreach ($t in $targets) {",
    "  $lnk = $shell.CreateShortcut($t.Path)",
    "  $lnk.TargetPath = $pwsh",
    "  $lnk.Arguments = $t.Arguments",
    "  $lnk.WindowStyle = 7",
    "  $lnk.Save()",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const specs = readShortcuts();
  const outDir = mkdtempSync(join(tmpdir(), "dotfiles-windows-menu-"));
  try {
    const scriptPath = join(outDir, "create.ps1");
    writeFileSync(scriptPath, shortcutScript(outDir, specs));
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`powershell.exe exited with status ${result.status}`);
    for (const spec of specs) {
      const generated = join(outDir, `${spec.name}.lnk`);
      if (!existsSync(generated)) throw new Error(`shortcut was not created: ${spec.name}.lnk`);
      const target = join(process.cwd(), `${spec.name}.lnk`);
      if (existsSync(target) && readFileSync(target).equals(readFileSync(generated))) continue;
      copyFileSync(generated, target);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
