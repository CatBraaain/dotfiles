import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "bun:test";
import { buildCustomPatch } from "../../vscode-custom-patch.build.ts";
import { buildProject } from "./scripts/build.ts";

it("restores all outputs for unchanged build inputs and keeps two cache generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "vscode-build-test-"));
  try {
    const dist = join(root, "dist");
    const vscode = join(dist, "vscode");
    const project = join(vscode, "local-extensions.data.projects/vscode-custom-patch");
    const plugin = "plugins/scm-collapse/src/entry.ts";
    const vsix = "vscode-custom-patch-1.0.0.data.vsix";
    const outputNames = [
      vsix,
      vsix + ".sha256",
      "scm-collapse.data.js",
      "vscode-custom-patch/cli.js",
    ];

    async function copyBuildInputs() {
      for (const file of [
        "package.json",
        "cli.ts",
        "scripts/build.ts",
        "src/extension.ts",
        "src/patch.ts",
        "src/scm-bridge.ts",
        "src/scm-selection.ts",
        "plugins/scm-collapse/package.json",
        "plugins/scm-collapse/tsconfig.json",
        plugin,
        "plugins/scm-collapse/src/main.ts",
      ]) {
        const output = join(project, file);
        await mkdir(dirname(output), { recursive: true });
        await copyFile(join(import.meta.dir, file), output);
      }
    }

    let packages = 0;
    async function packageVsix(packageDir: string, vsixPath: string) {
      packages++;
      await copyFile(join(packageDir, "extension.js"), vsixPath);
    }
    function buildWithStub(source: string, output: string) {
      return buildProject(source, output, packageVsix);
    }
    const readOutputs = () => Promise.all(outputNames.map((path) => readFile(join(vscode, path))));

    await copyBuildInputs();
    await buildCustomPatch(vscode, dist, buildWithStub);
    const firstOutputs = await readOutputs();

    await rm(dist, { recursive: true });
    await copyBuildInputs();
    await writeFile(join(project, "notes.md"), "# Notes\n");
    await writeFile(join(project, "src/patch.test.ts"), "throw new Error('Not a build input');\n");
    await buildCustomPatch(vscode, dist, buildWithStub);
    assert.equal(packages, 1);
    assert.deepEqual(await readOutputs(), firstOutputs);

    await appendFile(join(project, plugin), '\nconsole.info("changed");\n');
    await buildCustomPatch(vscode, dist, buildWithStub);
    assert.equal(packages, 2);
    assert.notDeepEqual(await readFile(join(vscode, vsix + ".sha256")), firstOutputs[1]);

    const bridgePath = join(project, "src/scm-selection.ts");
    const bridgeSource = await readFile(bridgePath, "utf8");
    const collapseHash = await readFile(join(vscode, vsix + ".sha256"));
    await writeFile(
      bridgePath,
      bridgeSource.replace("agentKit.scm.selectRepositories", "fixture.scm.selectRepositories"),
    );
    await buildCustomPatch(vscode, dist, buildWithStub);
    assert.equal(packages, 3);
    assert.notDeepEqual(await readFile(join(vscode, vsix + ".sha256")), collapseHash);
    const cache = join(root, ".cache/vscode-custom-patch", `${process.platform}-${process.arch}`);
    assert.equal((await readdir(cache)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
