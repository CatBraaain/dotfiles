import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  createExtensionRuntime,
  ExtensionRunner,
  formatSkillsForPrompt,
  getAgentDir,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  loadSkills,
  type Extension,
  type ExtensionAPI,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import piDocsExtension from "./index.ts";

const documentationPathNames = ["PI_README_PATH", "PI_DOCS_PATH", "PI_EXAMPLES_PATH"] as const;
const environmentNames = ["PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR", ...documentationPathNames];
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
let originalEnvironment: Record<string, string | undefined>;
let fixtureRoot: string;

beforeEach(async () => {
  originalEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  await mkdir("/tmp/work/dotfiles", { recursive: true });
  fixtureRoot = await mkdtemp("/tmp/work/dotfiles/pi-docs-tests-");
  process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");
  process.env.PI_PACKAGE_DIR = join(fixtureRoot, "installed pi $&");
  assert.equal(getAgentDir(), join(fixtureRoot, "agent"));
});

afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

function createRunner() {
  const handlers: Extension["handlers"] = new Map();
  piDocsExtension({
    on(event: string, handler: unknown) {
      const registeredHandlers = handlers.get(event) ?? [];
      registeredHandlers.push(handler as never);
      handlers.set(event, registeredHandlers);
    },
  } as ExtensionAPI);
  const extension = { path: extensionPath, handlers } as Extension;
  const runner = new ExtensionRunner(
    [extension],
    createExtensionRuntime(),
    fixtureRoot,
    {} as never,
    {} as never,
  );
  const errors: ExtensionError[] = [];
  runner.onError((error) => errors.push(error));
  return { runner, errors, handlers };
}

function expectedDocumentPaths(): string[] {
  const docs = getDocsPath();
  const examples = getExamplesPath();
  return [
    getReadmePath(),
    `${docs}/extensions.md`,
    `${examples}/extensions/`,
    `${docs}/themes.md`,
    `${docs}/skills.md`,
    `${docs}/prompt-templates.md`,
    `${docs}/tui.md`,
    `${docs}/keybindings.md`,
    `${docs}/sdk.md`,
    `${examples}/sdk/`,
    `${docs}/custom-provider.md`,
    `${docs}/models.md`,
    `${docs}/packages.md`,
    `${docs}/environment-variables.md`,
    `${docs}/mcp.md`,
    `${docs}/codemode.md`,
  ];
}

describe("dynamic pi-docs skill", () => {
  for (const reason of ["startup", "reload"] as const) {
    it(`registers a standard loadable skill with host paths on ${reason}`, async () => {
      const { runner, errors, handlers } = createRunner();
      const result = await runner.emitResourcesDiscover(fixtureRoot, reason);
      assert.deepEqual(errors, []);
      assert.deepEqual([...handlers.keys()], ["resources_discover"]);
      assert.equal(result.skillPaths.length, 1);
      const skillPath = result.skillPaths[0]!.path;
      const content = await readFile(skillPath, "utf8");
      const contentHash = createHash("sha256").update(content).digest("hex");
      const expectedSkillPath = join(getAgentDir(), "cache", "pi-docs", contentHash, "SKILL.md");
      assert.equal(skillPath, expectedSkillPath);
      const loaded = loadSkills({
        cwd: fixtureRoot,
        agentDir: getAgentDir(),
        skillPaths: [skillPath],
        includeDefaults: false,
      });
      assert.deepEqual(loaded.diagnostics, []);
      assert.equal(loaded.skills.length, 1);
      const skill = loaded.skills[0]!;
      const template = await readFile(new URL("./skill-template.md", import.meta.url), "utf8");
      const frontmatter = YAML.parse(template.split("---")[1]!);
      assert.equal(skill.name, "pi-docs");
      assert.equal(skill.description, frontmatter.description);
      assert.equal(skill.disableModelInvocation, false);
      assert.equal(skill.filePath, skillPath);
      const documentPaths = [...content.matchAll(/^\| .*?\| (.*?) \|$/gm)].flatMap((row) =>
        [...row[1]!.matchAll(/`([^`]+)`/g)].map((reference) => reference[1]),
      );
      assert.deepEqual(documentPaths, expectedDocumentPaths());
      assert.equal(/\{\{(?:README|DOCS|EXAMPLES)_PATH\}\}/.test(content), false);
      assert.equal(/\$\{PI_/.test(content), false);
      const prompt = formatSkillsForPrompt(loaded.skills);
      assert.ok(prompt.includes(skillPath));
      assert.equal(prompt.includes(getReadmePath()), false);
      assert.deepEqual(await readdir(dirname(skillPath)), ["SKILL.md"]);
    });
  }

  it("uses host defaults when PI_PACKAGE_DIR is unset", async () => {
    delete process.env.PI_PACKAGE_DIR;
    const { runner, errors } = createRunner();
    const result = await runner.emitResourcesDiscover(fixtureRoot, "startup");
    const content = await readFile(result.skillPaths[0]!.path, "utf8");
    assert.deepEqual(errors, []);
    assert.ok(content.includes(`\`${getReadmePath()}\``));
    assert.ok(content.includes(`\`${getDocsPath()}/extensions.md\``));
    assert.ok(content.includes(`\`${getExamplesPath()}/extensions/\``));
  });

  it("retains earlier content when reload changes the host package path", async () => {
    const { runner, errors } = createRunner();
    const initial = await runner.emitResourcesDiscover(fixtureRoot, "startup");
    const initialPath = initial.skillPaths[0]!.path;
    const initialContent = await readFile(initialPath, "utf8");
    process.env.PI_PACKAGE_DIR = join(fixtureRoot, "another pi package");
    const reloaded = await runner.emitResourcesDiscover(fixtureRoot, "reload");
    const reloadedPath = reloaded.skillPaths[0]!.path;
    const reloadedContent = await readFile(reloadedPath, "utf8");
    assert.deepEqual(errors, []);
    assert.notEqual(reloadedPath, initialPath);
    assert.equal(await readFile(initialPath, "utf8"), initialContent);
    assert.ok(reloadedContent.includes(`\`${getReadmePath()}\``));
  });

  it("publishes complete content when concurrent instances share the cache", async () => {
    const instances = [createRunner(), createRunner(), createRunner()];
    const results = await Promise.all(
      instances.map(({ runner }) => runner.emitResourcesDiscover(fixtureRoot, "startup")),
    );
    const skillPaths = results.map((result) => result.skillPaths[0]!.path);
    assert.equal(new Set(skillPaths).size, 1);
    assert.deepEqual(
      instances.flatMap(({ errors }) => errors),
      [],
    );
    const content = await readFile(skillPaths[0]!, "utf8");
    const contentHash = createHash("sha256").update(content).digest("hex");
    assert.equal(dirname(skillPaths[0]!), join(getAgentDir(), "cache", "pi-docs", contentHash));
    assert.ok(content.includes(`\`${getReadmePath()}\``));
    assert.deepEqual(await readdir(dirname(skillPaths[0]!)), ["SKILL.md"]);
  });

  it("reports filesystem failures without registering a skill", async () => {
    await mkdir(getAgentDir(), { recursive: true });
    await writeFile(join(getAgentDir(), "cache"), "blocked", "utf8");
    const { runner, errors } = createRunner();
    const result = await runner.emitResourcesDiscover(fixtureRoot, "startup");
    assert.deepEqual(result.skillPaths, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.event, "resources_discover");
    assert.equal(errors[0]!.extensionPath, extensionPath);
    assert.ok(errors[0]!.error.includes(join(getAgentDir(), "cache")));
  });

  it("cleans incomplete output when publication fails and can retry", async () => {
    const { runner, errors } = createRunner();
    const initial = await runner.emitResourcesDiscover(fixtureRoot, "startup");
    const skillPath = initial.skillPaths[0]!.path;
    const initialContent = await readFile(skillPath, "utf8");
    await rm(skillPath);
    await mkdir(skillPath);
    const failed = await runner.emitResourcesDiscover(fixtureRoot, "reload");
    assert.deepEqual(failed.skillPaths, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.event, "resources_discover");
    assert.ok(errors[0]!.error.includes(skillPath));
    assert.deepEqual(await readdir(dirname(skillPath)), ["SKILL.md"]);
    await rm(skillPath, { recursive: true });
    const retried = await runner.emitResourcesDiscover(fixtureRoot, "reload");
    assert.deepEqual(retried.skillPaths, initial.skillPaths);
    assert.equal(await readFile(skillPath, "utf8"), initialContent);
  });

  for (const inherited of [false, true]) {
    it(`leaves documentation environment variables ${inherited ? "unchanged" : "unset"}`, async () => {
      for (const name of documentationPathNames) {
        if (inherited) process.env[name] = `/inherited/${name}`;
        else delete process.env[name];
      }
      const expectedEnvironment = environmentNames.map((name) => process.env[name]);
      const { runner, errors } = createRunner();
      await runner.emitResourcesDiscover(fixtureRoot, "startup");
      await runner.emitResourcesDiscover(fixtureRoot, "reload");
      assert.deepEqual(errors, []);
      const actualEnvironment = environmentNames.map((name) => process.env[name]);
      assert.deepEqual(actualEnvironment, expectedEnvironment);
    });
  }
});
