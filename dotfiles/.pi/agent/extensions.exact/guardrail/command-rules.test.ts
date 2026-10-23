import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Guardrail,
  compileCommandRuleEntries,
  parseGuardrailConfig,
  resolveCommandAction,
  resolveCommandActionMatch,
  splitCommandSegments,
} from "./guardrail";

function commandEntries(pattern: string, args: string[]) {
  return compileCommandRuleEntries([{ action: "ask", pattern, args }]).entries;
}

function withGuardrail(config: string, test: (guardrail: Guardrail, cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "structured-command-rules-"));
    try {
      const path = join(cwd, "guardrail.yaml");
      writeFileSync(path, config);
      await test(new Guardrail(cwd, path), cwd);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  };
}

describe("structured whole-token command rules", () => {
  it("groups alternation and requires whole executable and argument tokens", () => {
    const entries = commandEntries("git|gh", ["push|create"]);
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
    const entries = commandEntries("tool", ["a|b", "b|c"]);
    assert.equal(resolveCommandAction(entries, "tool extra c a tail"), "ask");
    assert.equal(resolveCommandAction(entries, "tool b"), "ask");
    assert.equal(resolveCommandAction(entries, "tool a"), "deny");
    assert.equal(resolveCommandAction(entries, "other a c"), "deny");
  });

  it("empty args impose no argument constraints", () => {
    const entries = commandEntries("tool", []);
    assert.equal(resolveCommandAction(entries, "tool"), "ask");
    assert.equal(resolveCommandAction(entries, 'tool extra ""'), "ask");
  });

  it("retains empty, quoted whitespace and newline tokens without inventing segments", () => {
    assert.deepEqual(splitCommandSegments('tool "" " a b " "a\nb"'), [
      ["tool", "", " a b ", "a\nb"],
    ]);
    const entries = commandEntries("tool", ["", " a b ", "a\\nb"]);
    assert.equal(resolveCommandAction(entries, 'tool "" " a b " "a\nb"'), "ask");
    assert.equal(resolveCommandAction(entries, 'tool " a b " "a\nb"'), "deny");
  });

  it("discards unquoted empty expansions without hiding the executable behind env", () => {
    const entries = compileCommandRuleEntries([
      { action: "allow", pattern: "[\\s\\S]*", args: [] },
      { action: "ask", pattern: "git", args: ["push"] },
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
    const entries = commandEntries("tool", [""]);
    assert.deepEqual(splitCommandSegments(command), [["tool"]]);
    assert.equal(resolveCommandAction(entries, command), "deny");
  });

  it("preserves quoted empty expansions and explicitly empty executable tokens", () => {
    const entries = commandEntries("tool", [""]);
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
    const config = parseGuardrailConfig(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push
      - allow:
          - status
  - gh:
      - ask:
          - create
  - stop:
      - deny: []`,
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
      "{command: git, args: push}",
      "{command: git, args: [push, 1]}",
      "{command: git, any: []}",
      "[{command: git}, null]",
    ])
      assert.throws(
        () =>
          parseGuardrailConfig(
            'read: [{allow: "*"}]\ncommands:\n  - git:\n      - allow: ' + rule + "\n",
          ),
        rule,
      );
  });

  it("invalid command or arg regex disables the entire affected rule only", () => {
    for (const rule of [
      { pattern: "[unclosed", args: [] },
      { pattern: "tool", args: ["good", "[unclosed"] },
    ]) {
      const compiled = compileCommandRuleEntries([
        { action: "allow", ...rule },
        { action: "allow", pattern: "other", args: [] },
      ]);
      assert.equal(compiled.invalidPatterns.length, 1);
      assert.equal(resolveCommandAction(compiled.entries, "tool good"), "deny");
      assert.equal(resolveCommandAction(compiled.entries, "other"), "allow");
    }
  });

  it("reports original token ranges rather than a joined substring spanning unrelated args", () => {
    const match = resolveCommandActionMatch(
      compileCommandRuleEntries([
        { action: "allow", pattern: "echo", args: [] },
        { action: "ask", pattern: "git", args: ["push"] },
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
  withGuardrail(`commands:
  - tool:
      - ask_with_reason: []`, async (guardrail, cwd) => {
    const context = { cwd, hasUI: true, ui: { confirm: async () => true } };
    await guardrail.requestCommandPermission('tool "a b"', "test", context);
    await assert.rejects(
      async () => guardrail.authorizeCommand("tool a b", context),
      /requires a reason/,
    );
    assert.equal(await guardrail.authorizeCommand("tool 'a b'", context), true);
    await assert.rejects(
      async () => guardrail.authorizeCommand('tool "a b"', context),
      /requires a reason/,
    );
  }),
);

it(
  "session rule identity includes every argument condition",
  withGuardrail(
    `commands:
  - tool:
      - ask:
          - one
      - ask:
          - two`,
    async (guardrail, cwd) => {
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
      await guardrail.authorizeCommand("tool one", context);
      await guardrail.authorizeCommand("tool extra one", context);
      assert.equal(prompts, 1);
      await guardrail.authorizeCommand("tool two", context);
      assert.equal(prompts, 2);
    },
  ),
);

it("preserves policy families with intentional unordered allow exceptions", () => {
  const config = parseGuardrailConfig(
    readFileSync(
      new URL("../../../../.agents/config.exact/guardrail.yaml", import.meta.url),
      "utf8",
    ),
  );
  const compiled = compileCommandRuleEntries(config.commands);
  assert.deepEqual(compiled.invalidPatterns, []);
  const cases = [
    ["npm publish", "ask"],
    ["bun publish", "ask"],
    ["conan upload pkg/1.0", "ask"],
    ["choco push", "ask"],
    ["gem push pkg-1.0.0.gem", "ask"],
    ["docker push registry.example.com/app:1", "ask"],
    ["flutter pub publish", "ask"],
    ["mix hex.publish", "ask"],
    ["mvn deploy", "ask"],
    ["brew bump-formula-pr", "ask"],
    ["brew bump-cask-pr", "ask"],
    ["komac update pkg --version 1.2.3", "ask"],
    ["komac sync", "allow"],
    ["komac list-versions pkg", "allow"],
    ["tool extra extra extra publish", "allow"],
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
