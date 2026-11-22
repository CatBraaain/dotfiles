import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, it } from "bun:test";
import { ensureScmBridge } from "./scm-bridge.ts";

const command = "agentKit.scm.selectRepositories";
const source = `
const $registry = {
  handlers: new Map(),
  getCommand(id) { return this.handlers.get(id); },
  registerCommand(id, handler) { this.handlers.set(id, handler); },
};
class View {
  selectionModeConfig = createOption("scm.repositories.selectionMode");
  get visibleRepositories() { return this.selected; }
  set visibleRepositories(repositories) { this.selected = repositories; this.writes++; }
  constructor(repositories, selected) {
    this.repositories = repositories;
    this.selected = selected;
    this.writes = 0;
  }
}
function createOption() { return { get: () => mode }; }
function createService(id) { return Object.assign(() => {}, { toString: () => id }); }
const $viewService = createService("scmView");
$registry.registerCommand("scm.setActiveProvider", async accessor => {
  const view = accessor.get($viewService);
});
globalThis.fixture = { registry: $registry, View, viewService: $viewService };
//# sourceMappingURL=workbench.js.map`;
let appOut: string;
let bundle: string;

beforeEach(() => {
  appOut = mkdtempSync(join(tmpdir(), "scm-bridge-"));
  bundle = join(appOut, "vs", "workbench", "workbench.desktop.main.js");
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(bundle, source);
});

afterEach(() => {
  rmSync(appOut, { recursive: true, force: true });
});

it("installs once and restores the original bytes without a backup", () => {
  const original = readFileSync(bundle);
  assert.equal(ensureScmBridge(appOut, true), "patched");
  const patched = readFileSync(bundle);
  assert.ok(patched.subarray(0, original.length).equals(original));
  assert.equal(ensureScmBridge(appOut, true), "fresh");
  assert.deepEqual(readFileSync(bundle), patched);
  assert.equal(ensureScmBridge(appOut, false), "unpatched");
  assert.deepEqual(readFileSync(bundle), original);
});

it.each([
  [
    "missing view service",
    source.replace('createService("scmView")', 'createService("oldScmView")'),
  ],
  ["missing setter", source.replace("set visibleRepositories", "set unsupported")],
  ["missing command", source.replace("scm.setActiveProvider", "scm.notTheActiveProvider")],
  ["unlinked command", source.replace("accessor.get($viewService)", "accessor.get(otherService)")],
  [
    "ambiguous command",
    source + '\nother.registerCommand("scm.setActiveProvider", x => { x.get($viewService); });',
  ],
])("leaves the source intact for %s", (_, unsupported) => {
  writeFileSync(bundle, unsupported);
  assert.equal(ensureScmBridge(appOut, true), "fresh");
  assert.equal(readFileSync(bundle, "utf8"), unsupported);
});

it("does not truncate unrelated bytes after a damaged patch boundary", () => {
  ensureScmBridge(appOut, true);
  const damaged = `${readFileSync(bundle, "utf8")}stockCode();\n`;
  writeFileSync(bundle, damaged);
  assert.equal(ensureScmBridge(appOut, false), "bridge-invalid");
  assert.equal(readFileSync(bundle, "utf8"), damaged);
});

type Root = { fsPath: string; scheme?: string; authority?: string; path?: string };
type Repository = { provider: { rootUri: Root } };
type View = { repositories: Repository[]; selected: Repository[]; writes: number };
const alpha = repository({ fsPath: "/alpha" });
const beta = repository({ fsPath: "/beta" });
const gamma = repository({ fsPath: "/gamma" });

it("selects exactly the requested repositories via the same view instance", () => {
  const { run, view } = loadSelection();
  assert.equal(run(["/gamma", "/alpha"]), "applied");
  assert.deepEqual([...view.selected], [gamma, alpha]);
  assert.equal(view.writes, 1);
  assert.deepEqual(view.repositories, [alpha, beta, gamma]);
  assert.equal(run(["/alpha", "/gamma"]), "applied");
  assert.equal(view.writes, 1);
  assert.equal(run(["/beta"]), "applied");
  assert.deepEqual([...view.selected], [beta]);
});

it("defers without writing until all exact paths are discovered", () => {
  const { run, view } = loadSelection();
  assert.equal(run(["/alpha", "/new"]), "pending");
  assert.equal(run(["/alpha", "/Beta"]), "pending");
  assert.equal(view.writes, 0);
  const newRepo = repository({ fsPath: "/new" });
  view.repositories.push(newRepo);
  assert.equal(run(["/alpha", "/new"]), "applied");
  assert.deepEqual([...view.selected], [alpha, newRepo]);
});

it("uses the WSL provider path even when the renderer's fsPath uses backslashes", () => {
  const remote = repository({
    scheme: "vscode-remote",
    authority: "wsl+Ubuntu",
    path: "/home/code #1",
    fsPath: "\\home\\code #1",
  });
  const local = repository({ scheme: "file", path: "/c:/code", fsPath: "c:\\code" });
  const { run, view } = loadSelection("multiple", [remote, local, alpha]);
  assert.equal(run(["/home/code #1", "c:\\code"]), "applied");
  assert.deepEqual([...view.selected], [remote, local]);
});

it("does not select in single-selection mode", () => {
  const { run, view } = loadSelection("single");
  assert.equal(run(["/alpha"]), "unavailable");
  assert.equal(view.writes, 0);
});

it("does not choose between providers with the same root", () => {
  const { run, view } = loadSelection("multiple", [alpha, beta, repository({ fsPath: "/alpha" })]);
  assert.equal(run(["/alpha", "/beta"]), "unavailable");
  assert.equal(view.writes, 0);
});

it.each([
  ["missing argument", []],
  ["variadic arguments", [["/alpha"], ["/beta"]]],
  ["empty array", [[]]],
  ["not an array", ["/alpha"]],
  ["non-string", [["/alpha", { fsPath: "/beta" }]]],
  ["duplicate path", [["/alpha", "/alpha"]]],
  ["relative path", [["alpha"]]],
  ["URI", [["file:///alpha"]]],
  ["null byte", [["/alpha\0"]]],
  ["sparse array", [Array(1)]],
])("rejects %s without resolving the service", (_, args) => {
  const { run, getViews } = loadSelection();
  assert.equal(run(...args), "unavailable");
  assert.equal(getViews(), 0);
});

function loadSelection(mode = "multiple", repositories = [alpha, beta, gamma]) {
  assert.equal(ensureScmBridge(appOut, true), "patched");
  const globals = {
    mode,
    fixture: undefined as unknown as {
      registry: {
        getCommand(
          id: string,
        ): (accessor: { get(service: unknown): View }, ...args: unknown[]) => string;
      };
      View: new (repositories: Repository[], selected: Repository[]) => View;
      viewService: unknown;
    },
  };
  runInNewContext(readFileSync(bundle, "utf8"), globals);
  const { registry, View, viewService } = globals.fixture;
  const view = new View(repositories, [...repositories]);
  const execute = registry.getCommand(command);
  assert.ok(execute);
  let viewReads = 0;
  const accessor = {
    get(service: unknown) {
      assert.equal(service, viewService);
      viewReads++;
      return view;
    },
  };
  return {
    view,
    run: (...args: unknown[]) => execute(accessor, ...args),
    getViews: () => viewReads,
  };
}

function repository(rootUri: Root): Repository {
  return { provider: { rootUri } };
}
