import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Sandbox,
  compileCommandRuleEntries,
  parseSandboxedToolsConfig,
  resolveCommandAction,
  resolveCommandActionMatch,
  splitCommandSegments,
} from "./sandbox";

function commandEntries(rule: { command: string; args?: string[] }) {
  return compileCommandRuleEntries([{ action: "ask", patterns: [rule] }]).entries;
}

function withSandbox(config: string, test: (sandbox: Sandbox, cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "structured-command-rules-"));
    try {
      const path = join(cwd, "sandbox.yaml");
      writeFileSync(path, config);
      await test(new Sandbox(cwd, path), cwd);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  };
}

describe("structured whole-token command rules", () => {
  it("groups alternation and requires whole executable and argument tokens", () => {
    const entries = commandEntries({ command: "git|gh", args: ["push|create"] });
    for (const command of ["git push", "gh create"])
      assert.equal(resolveCommandAction(entries, command), "ask", command);
    for (const command of [
      "mygit push",
      "gitx push",
      "git pushx",
      "git xcreate",
      '"git other" push',
      'git "push extra"',
      'git "push\n"',
    ])
      assert.equal(resolveCommandAction(entries, command), "deny", command);
  });

  it("ANDs all arg patterns at arbitrary positions while allowing extra and shared tokens", () => {
    const entries = commandEntries({ command: "tool", args: ["a|b", "b|c"] });
    assert.equal(resolveCommandAction(entries, "tool extra c a tail"), "ask");
    assert.equal(resolveCommandAction(entries, "tool b"), "ask");
    assert.equal(resolveCommandAction(entries, "tool a"), "deny");
    assert.equal(resolveCommandAction(entries, "other a c"), "deny");
  });

  it("omitted and empty args impose no argument constraints", () => {
    for (const rule of [{ command: "tool" }, { command: "tool", args: [] }]) {
      const entries = commandEntries(rule);
      assert.equal(resolveCommandAction(entries, "tool"), "ask");
      assert.equal(resolveCommandAction(entries, 'tool extra ""'), "ask");
    }
  });

  it("retains empty, quoted whitespace and newline tokens without inventing segments", () => {
    assert.deepEqual(splitCommandSegments('tool "" " a b " "a\nb"'), [
      ["tool", "", " a b ", "a\nb"],
    ]);
    const entries = commandEntries({ command: "tool", args: ["", " a b ", "a\\nb"] });
    assert.equal(resolveCommandAction(entries, 'tool "" " a b " "a\nb"'), "ask");
    assert.equal(resolveCommandAction(entries, 'tool " a b " "a\nb"'), "deny");
  });

  it("discards unquoted empty expansions without hiding the executable behind env", () => {
    const entries = compileCommandRuleEntries([
      { action: "allow", patterns: [{ command: "[\\s\\S]*" }] },
      { action: "ask", patterns: [{ command: "git", args: ["push"] }] },
    ]).entries;
    for (const command of [
      "$UNSET_FOR_POLICY_REVIEW git push",
      "${UNSET_FOR_POLICY_REVIEW} git push",
      "env $UNSET_FOR_POLICY_REVIEW git push",
    ]) {
      assert.deepEqual(splitCommandSegments(command), [["git", "push"]], command);
      assert.equal(resolveCommandAction(entries, command), "ask", command);
    }
  });

  it("does not invent an empty argument from an unquoted expansion", () => {
    const command = "tool $UNSET_FOR_POLICY_REVIEW";
    const entries = commandEntries({ command: "tool", args: [""] });
    assert.deepEqual(splitCommandSegments(command), [["tool"]]);
    assert.equal(resolveCommandAction(entries, command), "deny");
  });

  it("preserves quoted empty expansions and explicitly empty executable tokens", () => {
    const entries = commandEntries({ command: "tool", args: [""] });
    for (const command of [
      'tool "$UNSET_FOR_POLICY_REVIEW"',
      "tool ''$UNSET_FOR_POLICY_REVIEW",
      "tool ''",
    ]) {
      assert.deepEqual(splitCommandSegments(command), [["tool", ""]], command);
      assert.equal(resolveCommandAction(entries, command), "ask", command);
    }
    assert.deepEqual(splitCommandSegments('"" git push'), [["", "git", "push"]]);
    assert.deepEqual(splitCommandSegments('"$UNSET_FOR_POLICY_REVIEW" git push'), [
      ["", "git", "push"],
    ]);
  });

  it("supports OR lists and last matching entries, then compound strictness", () => {
    const config = parseSandboxedToolsConfig(
      'commands: [{allow: {command: ".*"}}, {ask: [{command: git, args: [push]}, {command: gh, args: [create]}]}, {allow: {command: git, args: [status]}}, {deny: {command: stop}}]',
    );
    const entries = compileCommandRuleEntries(config.commands).entries;
    assert.equal(resolveCommandAction(entries, "git push status"), "allow");
    assert.equal(resolveCommandAction(entries, "echo ok; gh create"), "ask");
    assert.equal(resolveCommandAction(entries, "git push; stop"), "deny");
    assert.equal(resolveCommandAction(entries, "# git push\necho ok"), "allow");
  });

  it("rejects legacy strings and malformed rules instead of dropping AND conditions", () => {
    for (const rule of [
      '"git push"',
      "{args: [push]}",
      "{command: git, args: push}",
      "{command: git, args: [push, 1]}",
      "{command: git, any: []}",
      "[{command: git}, null]",
    ])
      assert.throws(
        () =>
          parseSandboxedToolsConfig('read: [{allow: "*"}]\ncommands: [{allow: ' + rule + "}]"),
        rule,
      );
  });

  it("invalid command or arg regex disables the entire affected rule only", () => {
    for (const rule of [
      { command: "[unclosed", args: [] },
      { command: "tool", args: ["good", "[unclosed"] },
    ]) {
      const compiled = compileCommandRuleEntries([
        { action: "allow", patterns: [rule, { command: "other" }] },
      ]);
      assert.equal(compiled.invalidPatterns.length, 1);
      assert.equal(resolveCommandAction(compiled.entries, "tool good"), "deny");
      assert.equal(resolveCommandAction(compiled.entries, "other"), "allow");
    }
  });

  it("reports original token ranges rather than a joined substring spanning unrelated args", () => {
    const match = resolveCommandActionMatch(
      compileCommandRuleEntries([
        { action: "allow", patterns: [{ command: "echo" }] },
        { action: "ask", patterns: [{ command: "git", args: ["push"] }] },
      ]).entries,
      'echo "git push"; git -C "a b" push',
    );
    assert.equal(match.action, "ask");
    assert.equal(match.matched, JSON.stringify({ command: "git", args: ["push"] }));
    assert.deepEqual(match.matchSpan, {
      ranges: [
        { index: 17, length: 3 },
        { index: 30, length: 4 },
      ],
    });
  });
});

it(
  "once approvals distinguish a quoted single token from two tokens",
  withSandbox("commands: [{ask_with_reason: {command: tool}}]", async (sandbox, cwd) => {
    const context = { cwd, hasUI: true, ui: { confirm: async () => true } };
    await sandbox.requestCommandPermission('tool "a b"', "test", context);
    await assert.rejects(
      async () => sandbox.authorizeCommand("tool a b", context),
      /requires a reason/,
    );
    assert.equal(await sandbox.authorizeCommand("tool 'a b'", context), true);
    await assert.rejects(
      async () => sandbox.authorizeCommand('tool "a b"', context),
      /requires a reason/,
    );
  }),
);

it(
  "session rule identity includes every argument condition",
  withSandbox(
    "commands: [{ask: [{command: tool, args: [one]}, {command: tool, args: [two]}]}]",
    async (sandbox, cwd) => {
      let prompts = 0;
      const context = {
        cwd,
        hasUI: true,
        ui: {
          confirm: async () => false,
          select: async (_title: string, options: string[]) => {
            prompts++;
            return options[1];
          },
        },
      };
      await sandbox.authorizeCommand("tool one", context);
      await sandbox.authorizeCommand("tool extra one", context);
      assert.equal(prompts, 1);
      await sandbox.authorizeCommand("tool two", context);
      assert.equal(prompts, 2);
    },
  ),
);

it("preserves policy families with intentional unordered allow exceptions", () => {
  const config = parseSandboxedToolsConfig(
    readFileSync(
      new URL("../../../../.agents/config.exact/sandbox.yaml", import.meta.url),
      "utf8",
    ),
  );
  const compiled = compileCommandRuleEntries(config.commands);
  assert.deepEqual(compiled.invalidPatterns, []);
  const cases = [
    ["tool extra extra extra publish", "ask"],
    ['tool "x publish"', "allow"],
    ["git -C /repo push", "ask"],
    ["git --hard reset", "ask_with_reason"],
    ['git "reset --hard"', "allow"],
    ["chmod path -R", "allow"],
    ["chmod path -Rf", "ask_with_reason"],
    ["chmod path -fR", "ask_with_reason"],
    ["chmod path -f -R", "ask_with_reason"],
    ["chmod path -f", "allow"],
    ["systemctl start status", "allow"],
    ["systemctl status reboot", "deny"],
    ["systemctl start list-units", "allow"],
    ["crontab /tmp/newtab -l", "allow"],
    ['sudo -n sh -c "echo example" true', "allow"],
    ["sudo-rs -n true", "allow"],
    ["mkfs.fat /dev/example", "deny"],
    ["mkfs-anything /dev/example", "deny"],
    ["mkfsword /dev/example", "allow"],
    ["/mnt/c/Windows/System32/CMD.EXE /c echo ok", "ask"],
    ["/MNT/C/WINDOWS/SYSTEM32/REG.EXE delete QUERY", "allow"],
    ["/mnt/c/Windows/System32/ipconfig.exe", "allow"],
    ["/mnt/c/Windows/System32/ipconfig.exe /all", "allow"],
    ["/mnt/c/Windows/System32/ipconfig.exe /all /release", "ask"],
    ["/mnt/c/Windows/System32/ipconfig.exe /flushdns", "ask"],
    ["/mnt/c/Windows/System32/wsl.exe --version", "allow"],
    ["/mnt/c/Windows/System32/wsl.exe --list -v", "allow"],
    ["/mnt/c/Windows/System32/wsl.exe --list --online", "allow"],
    ["/mnt/c/Windows/System32/wsl.exe --list --unregister Example", "ask"],
    ["/mnt/c/Windows/System32/wsl.exe -d Ubuntu", "ask"],
    ["/mnt/c/Windows/System32/wsl.exe --exec ls", "ask"],
    ["/mnt/c/Windows/System32/wsl.exe --LIST --UNREGISTER Example", "ask"],
    ["pi mcp remove list", "allow"],
    ["cat /mnt/c/example", "allow"],
  ] as const;
  for (const [command, expected] of cases)
    assert.equal(resolveCommandAction(compiled.entries, command), expected, command);
});
