import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { it } from "bun:test";
import { prepareAgentWorktreeVisibility } from "./scm-bridge.ts";
import { ensureWorkbenchBundle } from "./workbench-bundle.ts";

const source = `
const MainContext = { MainThreadSCM: 0 };
const namedCustomer = () => {};
const decorate = (_decorators, customer) => customer;
let $MainThread = class {
  async $registerSourceControl(handle, parentHandle, id, label, rootUri, icon, isHidden, inputUri) {
    this.received = [handle, parentHandle, id, label, rootUri, icon, isHidden, inputUri];
    return this.received;
  }
};
$MainThread = decorate([namedCustomer(MainContext.MainThreadSCM)], $MainThread);
`;

type Registration = [
  handle: number,
  parentHandle: number | undefined,
  id: string,
  label: string,
  rootUri: { path: string } | undefined,
  icon: string,
  isHidden: boolean | undefined,
  inputUri: string,
];

it.each([
  ["remote worktree", 0, "git", "/home/.agents/worktrees/project/agents-task", true, false],
  ["Windows worktree", 1, "git", "/C:/worktrees/agents-task/", true, false],
  ["Copilot worktree", 1, "git", "/worktrees/copilot-task", true, true],
  ["nested worktree", 1, "git", "/worktrees/agents-parent/ordinary", true, true],
  ["main repository", undefined, "git", "/projects/agents-task", true, true],
  ["different provider", 1, "other", "/worktrees/agents-task", true, true],
  ["missing root", 1, "git", undefined, true, true],
  ["already visible", 1, "git", "/worktrees/agents-task", false, false],
  ["no hidden flag", 1, "git", "/worktrees/agents-task", undefined, undefined],
] as const)(
  "preserves all other registration inputs for %s",
  async (_, parent, id, path, hidden, expected) => {
    const patch = prepareAgentWorktreeVisibility(source);
    assert.ok(patch);
    const customer = runInNewContext(`${source}\n${patch}\nnew $MainThread();`) as {
      received?: Registration;
      $registerSourceControl(...args: Registration): Promise<Registration>;
    };
    const rootUri = path === undefined ? undefined : { path };
    const received = await customer.$registerSourceControl(
      7,
      parent,
      id,
      "label",
      rootUri,
      "icon",
      hidden,
      "input",
    );
    assert.equal(received, customer.received);
    assert.deepEqual([...received], [7, parent, id, "label", rootUri, "icon", expected, "input"]);
  },
);

it.each([
  ["missing customer", source.replace("MainContext.MainThreadSCM", "MainContext.Other")],
  ["ambiguous customers", source + source.replaceAll("$MainThread", "$OtherThread")],
  ["unsupported signature", source.replace("parentHandle, id, label", "id, label")],
])("skips %s", (_, bundle) => {
  assert.equal(prepareAgentWorktreeVisibility(bundle), undefined);
});

it("installs independently of the SCM bridge and removes the patch without changing the original bundle", () => {
  const appOut = mkdtempSync(join(tmpdir(), "agent-worktree-visibility-"));
  const bundle = join(appOut, "vs", "workbench", "workbench.desktop.main.js");
  try {
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, source);
    const options = { scmSelectionSource: "bundled selection" };
    assert.equal(ensureWorkbenchBundle(appOut, options), "patched");
    const patched = readFileSync(bundle, "utf8");
    assert.ok(patched.startsWith(source));
    assert.match(patched, /agent worktree visibility start/);
    assert.doesNotMatch(patched, /SCM bridge start/);
    assert.equal(ensureWorkbenchBundle(appOut, options), "fresh");
    assert.equal(readFileSync(bundle, "utf8"), patched);
    assert.equal(ensureWorkbenchBundle(appOut), "unpatched");
    assert.equal(readFileSync(bundle, "utf8"), source);
  } finally {
    rmSync(appOut, { recursive: true, force: true });
  }
});
