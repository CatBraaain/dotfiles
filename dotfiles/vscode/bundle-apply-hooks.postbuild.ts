import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const folder = process.cwd();
  await bundleHook(join(folder, "vscode-custom-patch-plugins", "ensure-patch.apply.ts"));

  const syncHook = join(folder, "sync_vscode_extensions.apply.ts");
  if (!existsSync(syncHook)) return;

  const vsix = readWorkspaceVsix(folder);
  await bundleHook(syncHook, { EMBEDDED_WORKSPACE_VSIX: JSON.stringify(vsix) });
}

function readWorkspaceVsix(folder: string) {
  const prefix = "vscode-custom-patch-";
  const suffix = ".data.vsix";
  const candidates = readdirSync(folder).filter(
    (name) => name.startsWith(prefix) && name.endsWith(suffix),
  );
  const [fileName] = candidates;
  if (candidates.length !== 1 || fileName === undefined) {
    throw new Error(
      `expected exactly one ${prefix}*${suffix} in ${folder}, found ${candidates.length}`,
    );
  }

  return {
    fileName,
    version: fileName.slice(prefix.length, -suffix.length),
    base64: readFileSync(join(folder, fileName), "base64"),
  };
}

async function bundleHook(path: string, define?: Record<string, string>) {
  const result = await Bun.build({ entrypoints: [path], target: "bun", define });
  const output = result.outputs[0];
  if (!output) throw new Error(`bundling ${path} produced no output`);
  await Bun.write(path, output);
}

if (import.meta.main) await main();
