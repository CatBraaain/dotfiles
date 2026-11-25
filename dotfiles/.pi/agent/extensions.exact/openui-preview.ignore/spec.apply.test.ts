import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { displayLibrary, displayPromptOptions } from "./library.data";
import { openuiInstructions, opuiSkill } from "./prompt";
import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";
import { captureSnapshot, resolveChromiumExecutable } from "./snapshot-cli";
import { chromium } from "playwright-core";
import { SUPPORTED_COMPONENTS } from "./supported-components";
import { validateOpenuiLang } from "./render";

const fixtureRoots: string[] = [];
const SKILL_FILE = join("skills", "openui-preview", "SKILL.md");
const SPEC_GENERATION_TEST_TIMEOUT_MS = 60_000;
const EXPECTED_SPEC = {
  root: "Stack",
  components: {
    Stack: { signature: "Stack(children: TextContent[])" },
    TextContent: { signature: "TextContent(text: string)" },
  },
  version: "shared-1.0.0",
};
const CLI_SOURCE = `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { version } from "@fixture/shared-library";
const { fixtureComponents } = await import(process.argv[3]);
assert.ok(fixtureComponents.includes("Stack"));
const output = process.argv[process.argv.indexOf("--out") + 1];
writeFileSync(output, JSON.stringify({ ...${JSON.stringify(EXPECTED_SPEC)}, version }));
`;
const LIBRARY_SOURCE =
  'import { version } from "@fixture/shared-library";\n' +
  'export { SUPPORTED_COMPONENTS as fixtureComponents } from "./supported-components";\n' +
  "export const promptOptions = { examples: [version], additionalRules: [] };\n";

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  mkdirSync("/tmp/work/dotfiles/openui-preview-tests", { recursive: true });
  const root = mkdtempSync("/tmp/work/dotfiles/openui-preview-tests/spec-");
  fixtureRoots.push(root);
  const distRoot = join(root, "dist");
  const distHookDir = join(distRoot, ".pi", "agent", "extensions.exact", "openui-preview");
  const agentDir = join(root, "home", ".pi", "agent");
  const homeHookDir = join(agentDir, "extensions", "openui-preview");
  const nodeModules = join(agentDir, "node_modules");
  mkdirSync(distHookDir, { recursive: true });
  mkdirSync(homeHookDir, { recursive: true });
  const lockPath = join(agentDir, "bun.lock");
  writeFileSync(lockPath, "");
  writeFileSync(join(distHookDir, "library.data.ts"), LIBRARY_SOURCE);
  for (const file of ["display-only.ts", "supported-components.ts", "prompt.ts"]) {
    copyFileSync(join(import.meta.dir, file), join(homeHookDir, file));
  }
  copyFileSync(join(import.meta.dir, "spec.build.ts"), join(distHookDir, "spec.build.ts"));
  return { root, distRoot, distHookDir, homeHookDir, lockPath, nodeModules };
}

function prepareNodeModules(fixture: ReturnType<typeof createFixture>, cliSource = CLI_SOURCE) {
  const cliDir = join(fixture.nodeModules, "@openuidev", "cli", "dist");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, "index.js"), cliSource);
  symlinkSync(
    join(import.meta.dir, "..", "..", "node_modules", "@openuidev", "lang-core"),
    join(fixture.nodeModules, "@openuidev", "lang-core"),
    "dir",
  );
  const libraryDir = join(fixture.nodeModules, "@fixture", "shared-library");
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(
    join(libraryDir, "package.json"),
    JSON.stringify({ name: "@fixture/shared-library", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(join(libraryDir, "index.js"), 'export const version = "shared-1.0.0";\n');
}

function runHook(fixture: ReturnType<typeof createFixture>) {
  const distHook = join(fixture.distHookDir, "spec.apply.ts");
  copyFileSync(join(import.meta.dir, "spec.apply.ts"), distHook);
  const built = Bun.spawnSync([process.execPath, join(fixture.distHookDir, "spec.build.ts")], {
    cwd: fixture.distHookDir,
  });
  assert.equal(built.exitCode, 0, built.stderr.toString());

  const homeHook = join(fixture.homeHookDir, "spec.apply.ts");
  copyFileSync(distHook, homeHook);
  const offlineDist = join(fixture.root, "offline-dist");
  renameSync(fixture.distRoot, offlineDist);
  try {
    return Bun.spawnSync([process.execPath, homeHook], {
      cwd: fixture.homeHookDir,
      env: { ...process.env, DOTFILES_DIST_DIR: fixture.distRoot },
    });
  } finally {
    renameSync(offlineDist, fixture.distRoot);
    rmSync(homeHook);
  }
}

function removeCli(fixture: ReturnType<typeof createFixture>) {
  rmSync(join(fixture.nodeModules, "@openuidev"), { recursive: true, force: true });
}

describe("OpenUI spec apply hook", () => {
  it("generates spec and prompt options from the built hook copied to home without dist", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.homeHookDir, "spec.json"), "utf8")),
      EXPECTED_SPEC,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.homeHookDir, "prompt-options.json"), "utf8")),
      { examples: ["shared-1.0.0"], additionalRules: [] },
    );
    const skillPath = join(fixture.homeHookDir, SKILL_FILE);
    assert.equal(readFileSync(skillPath, "utf8"), opuiSkill(fixture.homeHookDir));
    assert.equal(existsSync(join(fixture.homeHookDir, "spec-gen-stamp")), true);
    assert.equal(existsSync(join(fixture.homeHookDir, "library.data.ts")), false);
    assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
  });

  it("skips generation when the fingerprint stamp and outputs exist", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    removeCli(fixture);
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.homeHookDir, "spec.json"), "utf8")),
      EXPECTED_SPEC,
    );
  });

  it("regenerates when the library definition changes", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    removeCli(fixture);
    writeFileSync(join(fixture.distHookDir, "library.data.ts"), `${LIBRARY_SOURCE}\n`);
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("OpenUI CLI is missing"));
  });

  it("regenerates when the lockfile changes", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    removeCli(fixture);
    writeFileSync(fixture.lockPath, "changed\n");
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("OpenUI CLI is missing"));
  });

  it("fails without writing outputs when the parent dependencies are missing", () => {
    const fixture = createFixture();
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("OpenUI CLI is missing"));
    assert.equal(existsSync(join(fixture.homeHookDir, "spec.json")), false);
    assert.equal(existsSync(join(fixture.homeHookDir, "prompt-options.json")), false);
  });

  it("stops without writing prompt options when generation fails", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture, "process.exit(7);\n");
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stderr.toString().includes("openui generate failed with exit code 7"));
    assert.equal(existsSync(join(fixture.homeHookDir, "prompt-options.json")), false);
    assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
  });

  it("does nothing when no library definition is present", () => {
    const fixture = createFixture();
    rmSync(join(fixture.distHookDir, "library.data.ts"));
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(existsSync(join(fixture.homeHookDir, "spec.json")), false);
  });
});

describe("OpenUI static skill rendering", () => {
  it("captures the generated table and chart examples, embedded image, and intermediate null argument", async () => {
    const fixture = createFixture();
    const spec = displayLibrary.toSpec();
    writeFileSync(join(fixture.homeHookDir, "spec.json"), JSON.stringify(spec));
    const embeddedImage =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const sources = [
      ...displayPromptOptions.examples
        .slice(0, 2)
        .map((example) => example.slice(example.search(/^[\w$]+\s*=/m))),
      `root = Stack([Image("embedded", "${embeddedImage}")])`,
      'root = Stack([SnippetCardBlock([SnippetCardItem(null, IconText(Icon("star", "general"), null, null, "A")), SnippetCardItem(null, IconText(Icon("star", "general"), null, null, "B"))], "grid", true, null, 12)])',
    ];
    for (const [index, source] of sources.entries()) {
      assert.deepEqual(validateOpenuiLang(source, fixture.homeHookDir), { ok: true }, source);
      const pngPath = join(fixture.root, `static-${index}.png`);
      await captureSnapshot({
        source,
        generatedDir: fixture.homeHookDir,
        pngPath,
        deadline: Date.now() + 15_000,
      });
      const png = readFileSync(pngPath);
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), 960);
      assert.equal(png.readUInt32BE(20), 1280);
    }
  }, 60_000);
});

describe("OpenUI skill generation", () => {
  it(
    "uses the renderer library and existing prompt pipeline with the real CLI",
    () => {
      const fixture = createFixture();
      symlinkSync(join(import.meta.dir, "..", "..", "node_modules"), fixture.nodeModules, "dir");
      copyFileSync(
        join(import.meta.dir, "library.data.ts"),
        join(fixture.distHookDir, "library.data.ts"),
      );
      const result = runHook(fixture);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      const spec = JSON.parse(readFileSync(join(fixture.homeHookDir, "spec.json"), "utf8"));
      assert.deepEqual(spec, displayLibrary.toSpec());
      const generatedPromptOptions = JSON.parse(
        readFileSync(join(fixture.homeHookDir, "prompt-options.json"), "utf8"),
      );
      assert.deepEqual(generatedPromptOptions, displayPromptOptions);
      const auditedMaterials =
        JSON.stringify(
          {
            descriptions: Object.keys(spec.components)
              .sort()
              .map((name) => [name, spec.components[name]?.description ?? ""]),
            notes: (spec.componentGroups ?? [])
              .map((group: { name: string; notes?: string[] }) => [
                group.name,
                [...(group.notes ?? [])].sort(),
              ])
              .sort(),
            rules: [...generatedPromptOptions.additionalRules].sort(),
          },
          null,
          2,
        ) + "\n";
      const actualMaterialHash = createHash("sha256").update(auditedMaterials).digest("hex");
      const auditedMaterialHash =
        "0a7313e033bdf049469c887bed62d6eb5d562ec61e08c0d28152bd5ede9f0e8c";
      const auditPath = "/tmp/work/dotfiles/openui-audited-materials.json";
      if (actualMaterialHash !== auditedMaterialHash) writeFileSync(auditPath, auditedMaterials);
      assert.equal(
        actualMaterialHash,
        auditedMaterialHash,
        `Upstream prompt materials changed; re-audit required. Normalized input: ${auditPath}`,
      );
      const skill = readFileSync(join(fixture.homeHookDir, SKILL_FILE), "utf8");
      assert.equal(skill, opuiSkill(fixture.homeHookDir));
      const signatureNames = [...skill.matchAll(/^([A-Z]\w*)\(/gm)].map((match) => match[1]);
      assert.deepEqual(signatureNames.sort(), [...SUPPORTED_COMPONENTS].sort());
      for (const unsupported of [
        "\n## Action",
        "ActionExpression",
        "$binding",
        "@Each",
        "@Filter",
        "@Count",
        "## Hoisting",
        "streaming",
        "forms for input",
        "real image URL",
      ]) {
        assert.ok(!skill.includes(unsupported), unsupported);
      }
      for (const example of displayPromptOptions.examples) {
        assert.ok(skill.includes(example));
        const source = example.slice(example.search(/^[\w$]+\s*=/m));
        assert.deepEqual(validateOpenuiLang(source, fixture.homeHookDir), { ok: true }, example);
      }
      const skillPath = join(fixture.homeHookDir, SKILL_FILE);
      const loaded = loadSkills({
        cwd: fixture.root,
        agentDir: fixture.root,
        skillPaths: [skillPath],
        includeDefaults: false,
      });
      assert.deepEqual(loaded.diagnostics, []);
      assert.equal(loaded.skills.length, 1);
      const metadata = loaded.skills[0]!;
      assert.equal(metadata.name, "openui-preview");
      assert.equal(metadata.filePath, skillPath);
      assert.equal(metadata.disableModelInvocation, false);
      assert.equal(
        metadata.description,
        "markdown応答内に表示専用のOpenUI Langを作成する。生成UIを使う応答や、 openui-langコードフェンスの作成・修正時に使う。",
      );
      const body = openuiInstructions(fixture.homeHookDir);
      assert.ok(skill.endsWith(body + "\n"));
      assert.ok(body.includes(displayPromptOptions.examples[0]!));
      assert.ok(body.includes("root ="));
      assert.ok(!skill.includes("references/openui-lang.md"));
      const systemMetadata = formatSkillsForPrompt(loaded.skills);
      assert.ok(systemMetadata.includes(metadata.name));
      assert.ok(systemMetadata.includes(metadata.description));
      assert.ok(systemMetadata.includes(skillPath));
      assert.ok(!systemMetadata.includes(body));
      assert.ok(!systemMetadata.includes("TextContent("));
    },
    SPEC_GENERATION_TEST_TIMEOUT_MS,
  );

  for (const removed of [
    ["Icon"],
    ["Stack"],
    ["Callout", "Tabs", "Accordion", "Carousel", "Steps", "Table"],
    [
      "Image",
      "ImageBlock",
      "ImageGallery",
      "ImageText",
      "ImageTextLarge",
      "ContextCardItem",
      "VisualCardItem",
      "ListItem",
      "Icon",
    ],
  ]) {
    it(
      `removes usage guidance for unselected components: ${removed.join(", ")}`,
      () => {
        const fixture = createFixture();
        symlinkSync(join(import.meta.dir, "..", "..", "node_modules"), fixture.nodeModules, "dir");
        const excluded = new Set(removed);
        const selected = SUPPORTED_COMPONENTS.filter((name) => !excluded.has(name));
        writeFileSync(
          join(fixture.homeHookDir, "supported-components.ts"),
          `export const SUPPORTED_COMPONENTS = ${JSON.stringify(selected)} as const;\n`,
        );
        const source = readFileSync(join(import.meta.dir, "library.data.ts"), "utf8").replace(
          "export const displayLibrary",
          'openuiPromptOptions.additionalRules.push("Iconic表示を保つ", "Icon を使う指示");\n' +
            'openuiComponentGroups[0].notes.push("Iconography案内", "Icon を使う補足");\n' +
            'openuiLibrary.components.CardHeader.description = "Icon を使う説明";\n' +
            "export const displayLibrary",
        );
        const literalExample = '文字列の例:\n\nroot = TextContent("Icon Tabs Callout Stack")';
        const altExample = 'alt文字列の例:\n\nroot = Image("Icon Tabs Callout Stack")';
        writeFileSync(
          join(fixture.distHookDir, "library.data.ts"),
          source +
            `\ndisplayPromptOptions.examples.push(${JSON.stringify(literalExample)}, ${JSON.stringify(altExample)});\n`,
        );
        const result = runHook(fixture);
        assert.equal(result.exitCode, 0, result.stderr.toString());
        const skill = readFileSync(join(fixture.homeHookDir, SKILL_FILE), "utf8");
        const signatureNames = [...skill.matchAll(/^([A-Z]\w*)\(/gm)].map((match) => match[1]);
        assert.deepEqual(signatureNames.sort(), [...selected].sort());
        assert.ok(skill.includes(literalExample));
        if (selected.includes("Image")) assert.ok(skill.includes(altExample));
        assert.ok(skill.includes("Iconic表示を保つ"));
        assert.ok(skill.includes("Iconography案内"));
        if (removed.includes("Icon")) {
          assert.ok(!skill.includes("Always pass a category to Icon"));
          assert.ok(!skill.includes("Icon を使う"));
        }
        if (removed.includes("Stack")) assert.ok(!skill.includes("root = Stack"));
      },
      SPEC_GENERATION_TEST_TIMEOUT_MS,
    );
  }

  for (const { removed, absent, retained, descriptions } of [
    {
      removed: "Card",
      absent: ["Use Cards to group related KPIs", "Use Cards to wrap charts"],
      retained: ["Card blocks lay out 2+ items", "Card blocks (SnippetCardBlock"],
      descriptions: {
        InlineHeader:
          "Compact section heading with an optional one-line description, for use inside cards.",
      },
    },
    {
      removed: "Image",
      absent: [],
      retained: ["Image block with loading state"],
      descriptions: { ImageBlock: "Image block with loading state" },
    },
    {
      removed: "Text",
      absent: ["One row-style snippet card:", "One overview card:"],
      retained: ["Text block. Supports markdown.", "Text callout with variant"],
      descriptions: { TextCallout: "Text callout with variant, title, and description" },
    },
    {
      removed: "Stack",
      absent: ["Use nested Stacks", "Use Cards to group related KPIs"],
      retained: ["Image block with loading state"],
      descriptions: { Card: "" },
    },
    {
      removed: "CardHeader",
      absent: ["lighter than CardHeader", "Use Cards to wrap charts"],
      retained: ["Use Cards to group related KPIs"],
      descriptions: {
        InlineHeader:
          "Compact section heading with an optional one-line description, for use inside cards.",
      },
    },
    {
      removed: "Col",
      absent: ["Data table — column-oriented", "Table is COLUMN-oriented"],
      retained: ["Use Cards to wrap charts"],
      descriptions: { Table: "" },
    },
    {
      removed: "MetricIndicatorInline",
      absent: ["MetricIndicator* are the inline building blocks", "One overview card:"],
      retained: ["Headline metric value with an optional struck-through"],
      descriptions: { OverviewCardItem: "" },
    },
  ]) {
    it(
      `projects known references without removing ordinary descriptions when ${removed} is omitted`,
      () => {
        const fixture = createFixture();
        symlinkSync(join(import.meta.dir, "..", "..", "node_modules"), fixture.nodeModules, "dir");
        copyFileSync(
          join(import.meta.dir, "library.data.ts"),
          join(fixture.distHookDir, "library.data.ts"),
        );
        const selected = SUPPORTED_COMPONENTS.filter((name) => name !== removed);
        writeFileSync(
          join(fixture.homeHookDir, "supported-components.ts"),
          `export const SUPPORTED_COMPONENTS = ${JSON.stringify(selected)} as const;\n`,
        );
        const result = runHook(fixture);
        assert.equal(result.exitCode, 0, result.stderr.toString());
        const spec = JSON.parse(readFileSync(join(fixture.homeHookDir, "spec.json"), "utf8"));
        const skill = readFileSync(join(fixture.homeHookDir, SKILL_FILE), "utf8");
        assert.deepEqual(Object.keys(spec.components).sort(), [...selected].sort());
        for (const [name, description] of Object.entries(descriptions)) {
          assert.equal(spec.components[name].description, description, name);
        }
        for (const text of absent) assert.ok(!skill.includes(text), text);
        for (const text of retained) assert.ok(skill.includes(text), text);
      },
      SPEC_GENERATION_TEST_TIMEOUT_MS,
    );
  }

  for (const omitted of [undefined, "TextContent", "Stack"]) {
    it(
      `shares the ${omitted ?? "current"} configuration across CLI, schema, skill, and browser`,
      async () => {
        const fixture = createFixture();
        symlinkSync(join(import.meta.dir, "..", "..", "node_modules"), fixture.nodeModules, "dir");
        const selectedNames = SUPPORTED_COMPONENTS.filter((name) => name !== omitted);
        writeFileSync(
          join(fixture.homeHookDir, "supported-components.ts"),
          `export const SUPPORTED_COMPONENTS = ${JSON.stringify(selectedNames)} as const;\n`,
        );
        const upstreamAddition =
          'openuiLibrary.components.FutureDisplay = { ...openuiLibrary.components.TextContent, name: "FutureDisplay" };\n';
        const librarySource = readFileSync(join(import.meta.dir, "library.data.ts"), "utf8");
        writeFileSync(
          join(fixture.distHookDir, "library.data.ts"),
          librarySource.replace(
            "export const displayLibrary",
            upstreamAddition + "export const displayLibrary",
          ),
        );
        const result = runHook(fixture);
        assert.equal(result.exitCode, 0, result.stderr.toString());
        const spec = JSON.parse(readFileSync(join(fixture.homeHookDir, "spec.json"), "utf8"));
        const expectedNames = [...selectedNames].sort();
        assert.deepEqual(Object.keys(spec.components).sort(), expectedNames);
        const skill = readFileSync(join(fixture.homeHookDir, SKILL_FILE), "utf8");
        const signatureNames = [...skill.matchAll(/^([A-Z]\w*)\(/gm)]
          .map((match) => match[1])
          .sort();
        assert.deepEqual(signatureNames, expectedNames);
        const future = validateOpenuiLang(
          'root = Stack([FutureDisplay("future")])',
          fixture.homeHookDir,
        );
        assert.equal(future.ok, false);
        const text = validateOpenuiLang('root = Stack([TextContent("text")])', fixture.homeHookDir);
        assert.equal(text.ok, omitted !== "TextContent" && omitted !== "Stack");
        const browserSource = readFileSync(join(import.meta.dir, "snapshot-browser.js"), "utf8");
        writeFileSync(
          join(fixture.homeHookDir, "snapshot-browser.js"),
          browserSource
            .replace("const supported =", upstreamAddition + "const supported =")
            .replace(
              "const STABLE_FRAMES =",
              "window.__fixtureComponents = Object.keys(library.components);\nconst STABLE_FRAMES =",
            ),
        );
        const bundle = await Bun.build({
          entrypoints: [join(fixture.homeHookDir, "snapshot-browser.js")],
          target: "browser",
          format: "iife",
          minify: true,
          define: { "process.env.NODE_ENV": JSON.stringify("production") },
        });
        assert.equal(bundle.success, true, String(bundle.logs));
        const javascript = bundle.outputs.find((output) => output.path.endsWith(".js"));
        assert.ok(javascript);
        const browser = await chromium.launch({
          executablePath: await resolveChromiumExecutable(chromium.executablePath()),
          headless: true,
          chromiumSandbox: true,
        });
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          await page.route("https://openui-fixture.invalid/", (route) =>
            route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
          );
          await page.goto("https://openui-fixture.invalid/");
          await page.addScriptTag({ content: await javascript.text() });
          const browserNames = await page.evaluate(
            () =>
              (globalThis as typeof globalThis & { __fixtureComponents: string[] })
                .__fixtureComponents,
          );
          assert.ok(browserNames, errors.join("\n"));
          assert.deepEqual(browserNames.sort(), expectedNames);
          const selectedRoot =
            omitted === "Stack"
              ? 'root = Card([CardHeader("configured")])'
              : 'root = Stack([CardHeader("configured")])';
          assert.deepEqual(validateOpenuiLang(selectedRoot, fixture.homeHookDir), { ok: true });
          await page.evaluate((source) => {
            const runtime = globalThis as typeof globalThis & {
              __mountOpenui: (source: string) => void;
            };
            runtime.__mountOpenui(source);
          }, selectedRoot);
          await page.getByText("configured", { exact: true }).waitFor();
        } finally {
          await browser.close();
        }
      },
      SPEC_GENERATION_TEST_TIMEOUT_MS,
    );
  }

  it("updates the generated skill when library prompt definitions change", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    const skillPath = join(fixture.homeHookDir, SKILL_FILE);
    const previous = readFileSync(skillPath, "utf8");
    const updatedLibrary = LIBRARY_SOURCE.replace(
      "examples: [version]",
      'examples: ["Updated library example"]',
    );
    writeFileSync(join(fixture.distHookDir, "library.data.ts"), updatedLibrary);
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    const current = readFileSync(skillPath, "utf8");
    assert.notEqual(current, previous);
    assert.match(current, /Updated library example/);
  });

  for (const file of ["prompt.ts", "display-only.ts", "supported-components.ts"]) {
    it(`invalidates the stamp when ${file} changes`, () => {
      const fixture = createFixture();
      prepareNodeModules(fixture);
      assert.equal(runHook(fixture).exitCode, 0);
      const source = join(fixture.homeHookDir, file);
      writeFileSync(source, readFileSync(source, "utf8") + "\n");
      removeCli(fixture);
      const result = runHook(fixture);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr.toString(), /OpenUI CLI is missing/);
    });
  }

  for (const file of ["spec.json", "prompt-options.json", SKILL_FILE, "spec-gen-stamp"]) {
    it(`regenerates when ${file} is missing`, () => {
      const fixture = createFixture();
      prepareNodeModules(fixture);
      assert.equal(runHook(fixture).exitCode, 0);
      rmSync(join(fixture.homeHookDir, file));
      const result = runHook(fixture);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(existsSync(join(fixture.homeHookDir, file)), true);
      assert.equal(
        readFileSync(join(fixture.homeHookDir, SKILL_FILE), "utf8"),
        opuiSkill(fixture.homeHookDir),
      );
    });
  }

  it("replaces a legacy stamp and refreshes changed prompt content", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    const stampPath = join(fixture.homeHookDir, "spec-gen-stamp");
    writeFileSync(stampPath, "legacy-stamp");
    const source = join(fixture.homeHookDir, "prompt.ts");
    writeFileSync(
      source,
      readFileSync(source, "utf8").replace(
        "answers in markdown",
        "answers in markdown with updated guidance",
      ),
    );
    const result = runHook(fixture);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.notEqual(readFileSync(stampPath, "utf8"), "legacy-stamp");
    assert.match(readFileSync(join(fixture.homeHookDir, SKILL_FILE), "utf8"), /updated guidance/);
  });

  for (const failure of ["cli", "skill"]) {
    it(`preserves existing outputs and the stamp after ${failure} generation fails`, () => {
      const fixture = createFixture();
      prepareNodeModules(fixture);
      assert.equal(runHook(fixture).exitCode, 0);
      const files = ["spec.json", "prompt-options.json", SKILL_FILE, "spec-gen-stamp"];
      const previous = files.map((file) => readFileSync(join(fixture.homeHookDir, file), "utf8"));
      writeFileSync(fixture.lockPath, "changed");
      if (failure === "cli") {
        writeFileSync(
          join(fixture.nodeModules, "@openuidev", "cli", "dist", "index.js"),
          "process.exit(7);",
        );
      } else {
        writeFileSync(
          join(fixture.homeHookDir, "prompt.ts"),
          'export function opuiSkill() { throw new Error("skill generation failed"); }',
        );
      }
      const result = runHook(fixture);
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr.toString(),
        failure === "cli" ? /exit code 7/ : /skill generation failed/,
      );
      assert.deepEqual(
        files.map((file) => readFileSync(join(fixture.homeHookDir, file), "utf8")),
        previous,
      );
      assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
    });
  }

  for (const blockedFile of ["spec.json", "prompt-options.json", "spec-gen-stamp"]) {
    it(`restores all outputs after placement fails at ${blockedFile}`, () => {
      const fixture = createFixture();
      prepareNodeModules(fixture);
      assert.equal(runHook(fixture).exitCode, 0);
      const files = [SKILL_FILE, "spec.json", "prompt-options.json", "spec-gen-stamp"];
      const previous = files.map((file) => readFileSync(join(fixture.homeHookDir, file), "utf8"));
      const source = join(fixture.homeHookDir, "prompt.ts");
      writeFileSync(
        source,
        readFileSync(source, "utf8").replace("answers in markdown", "answers in updated markdown"),
      );
      const blockedPath = join(fixture.homeHookDir, blockedFile);
      chmodSync(blockedPath, 0o444);
      const result = runHook(fixture);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr.toString(), /EACCES/);
      assert.deepEqual(
        files.map((file) => readFileSync(join(fixture.homeHookDir, file), "utf8")),
        previous,
      );
      assert.equal(statSync(blockedPath).mode & 0o777, 0o444);
      assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
    });
  }

  it("removes a newly created skill when later placement fails", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    assert.equal(runHook(fixture).exitCode, 0);
    const skillPath = join(fixture.homeHookDir, SKILL_FILE);
    rmSync(skillPath);
    const stampPath = join(fixture.homeHookDir, "spec-gen-stamp");
    const previousStamp = readFileSync(stampPath, "utf8");
    chmodSync(join(fixture.homeHookDir, "spec.json"), 0o444);
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /EACCES/);
    assert.equal(existsSync(skillPath), false);
    assert.equal(readFileSync(stampPath, "utf8"), previousStamp);
    assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
  });

  it("keeps the stamp unchanged when the skill directory cannot be created", () => {
    const fixture = createFixture();
    prepareNodeModules(fixture);
    const blocked = join(fixture.homeHookDir, "skills");
    writeFileSync(blocked, "blocked");
    const result = runHook(fixture);
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(join(fixture.homeHookDir, "spec-gen-stamp")), false);
    assert.equal(existsSync(join(fixture.homeHookDir, "spec.json")), false);
    assert.equal(existsSync(join(fixture.homeHookDir, ".spec-gen")), false);
  });
});
