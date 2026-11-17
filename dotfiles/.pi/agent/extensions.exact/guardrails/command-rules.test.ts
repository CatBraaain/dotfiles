import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guardrail } from "./guardrail.ts";
import {
  compileCommandRuleEntries,
  parseGuardrailConfig,
  resolveCommandAction,
  resolveCommandActionMatch,
  splitCommandSegments,
} from "./config.ts";

function commandEntries(pattern: string, args: string[]) {
  return compileCommandRuleEntries([{ action: "ask", pattern, args }]).entries;
}

function withGuardrail(config: string, test: (guardrail: Guardrail, cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "structured-command-rules-"));
    try {
      const path = join(cwd, "guardrails.yaml");
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

describe("Tree-sitter command substitutions", () => {
  const entries = compileCommandRuleEntries([
    { action: "allow", pattern: ".*", args: [] },
    { action: "ask", pattern: "git", args: ["push"] },
    { action: "ask_with_reason", pattern: "reason", args: [] },
    { action: "deny", pattern: "stop", args: [] },
  ]).entries;

  for (const [inner, action] of [
    ["echo ok", "allow"],
    ["git push", "ask"],
    ["reason", "ask_with_reason"],
    ["stop", "deny"],
  ] as const) {
    for (const substitution of [`$(${inner})`, `\`${inner}\``]) {
      it(`authorizes an unquoted heredoc substitution: ${substitution}`, () => {
        const command = `cat <<EOF\ntext ${substitution}\nEOF`;
        assert.equal(resolveCommandAction(entries, command), action);
        assert.deepEqual(splitCommandSegments(command), [["cat"], inner.split(" ")]);
      });
    }
  }

  for (const command of [
    "echo $(echo $(git push))",
    "echo ${value:-$(git push)}",
    "echo `echo \\`git push\\``",
    "cat <(git push) > >(echo ok)",
    "cat <<EOF\n${value:-$(git push)}\nEOF",
    "cat <<EOF\n`echo \\`git push\\``\nEOF",
    "cat <<EOF\ntext '\" `git push`\nEOF",
    "cat <<EOF\n`git pu\\\nsh`\nEOF",
  ]) {
    it(`checks nested executable substitutions: ${JSON.stringify(command)}`, () => {
      assert.equal(resolveCommandAction(entries, command), "ask");
    });
  }

  it("does not inspect comments, simple variables or escaped literals as commands", () => {
    for (const command of [
      "echo '$stop `stop` $(stop)' # $(stop)",
      "cat <<EOF\n$stop ${stop} \\$(stop) \\`stop\\`\nEOF",
      "cat <<'EOF'\n$(stop) `stop` ${JSON.stringify(config)}\nEOF",
      'cat <<"EOF"\n$(stop) `stop`\nEOF',
      "cat <<\\EOF\n$(stop) `stop`\nEOF",
    ])
      assert.equal(resolveCommandAction(entries, command), "allow", command);
  });

  it("does not collect normal substitutions twice while scanning raw heredoc backticks", () => {
    const command = "cat <<EOF\n$(echo `git push`) `reason`\nEOF\necho done";
    assert.deepEqual(splitCommandSegments(command), [
      ["cat"],
      ["echo"],
      ["git", "push"],
      ["reason"],
      ["echo", "done"],
    ]);
  });

  it("maps UTF-16 positions through backtick escape removal to the original source", () => {
    for (const inner of ["$(git push)", "`git push`", "`echo \\`git push\\``", "`git pu\\\nsh`"]) {
      const command = `echo 日本語😀; cat <<EOF\n${inner}\nEOF`;
      const match = resolveCommandActionMatch(entries, command);
      const pushSource = inner.includes("pu\\\nsh") ? "pu\\\nsh" : "push";
      assert.equal(match.action, "ask", command);
      assert.deepEqual(
        match.matchSpan,
        {
          ranges: [
            { index: command.indexOf("git"), length: 3 },
            { index: command.indexOf(pushSource), length: pushSource.length },
          ],
        },
        command,
      );
    }
  });

  it("uses parse success rather than rejecting arithmetic shifts and case syntax", () => {
    for (const command of [
      "(( 1 << 2 )); git push",
      "echo $((1 << 2)); git push",
      "case x in x) git push ;; esac",
      "cat <<'OUT' $(case x in x) echo ok ;; esac)\nouter\nOUT\ngit push",
    ])
      assert.equal(resolveCommandAction(entries, command), "ask", command);
  });

  it("rejects recovery trees and missing required syntax before authorization", () => {
    for (const command of [
      "echo 'unterminated",
      "echo $(git push",
      "echo ok &&",
      "cat <<EOF\nmissing end",
      "cat <<E'OF'\n$(git push)\nEOF",
      "cat <<A <<B\none\nA\ntwo\nB",
      "cat <<EOF\n`git push\nEOF",
    ])
      assert.throws(() => resolveCommandAction(entries, command), /parse|syntax|heredoc/i, command);
  });
});

describe("Bash AST consistency checks", () => {
  const entries = compileCommandRuleEntries([
    { action: "allow", pattern: ".*", args: [] },
    { action: "ask", pattern: "git", args: ["push"] },
    { action: "allow", pattern: "git", args: ["status"] },
  ]).entries;

  for (const [name, command] of [
    ["literal body as outer argv", "git push <<'EOF'\n\\status\nEOF"],
    ["quoted body as executable source", "cat <<'EOF'\n\\text $(git push)\nEOF"],
    ["continued logical terminator", "cat <<EOF\nEO\\\nF\ngit push\nEOF"],
    ["continued substitution argument", "cat <<EOF\n$(git pu\\\nsh)\nEOF"],
    ["arithmetic misclassified as a command", "cat <<EOF\n$((git + push))\nEOF"],
    ["single quotes hiding a heredoc substitution", "cat <<EOF\n${x:-'$(git push)'}\nEOF"],
  ] as const) {
    it(`rejects an ambiguous AST: ${name}`, () => {
      assert.throws(() => resolveCommandAction(entries, command), /Unable to parse Bash command/);
    });
  }

  for (const command of ["git pu\\\nsh", "gi\\\nt push", "echo $(git pu\\\nsh)"]) {
    it(`rejects split command tokens around a line continuation: ${JSON.stringify(command)}`, () => {
      assert.throws(() => resolveCommandAction(entries, command), /Unable to parse Bash command/);
    });
  }

  it("normalizes line continuations inside a complete double-quoted token", () => {
    assert.equal(resolveCommandAction(entries, 'git "pu\\\nsh"'), "ask");
    assert.equal(resolveCommandAction(entries, '"gi\\\nt" push'), "ask");
  });

  it("retains literal newlines after escaped backslashes or inside single quotes", () => {
    assert.deepEqual(splitCommandSegments('tool "pu\\\\\nsh"'), [["tool", "pu\\\nsh"]]);
    assert.deepEqual(splitCommandSegments("tool 'pu\\\nsh'"), [["tool", "pu\\\nsh"]]);
    assert.equal(resolveCommandAction(entries, "cat <<EOF\nEO\\\\\nF\nEOF\ngit push"), "ask");
  });

  it("preserves original positions when a token contains a correctly parsed line continuation", () => {
    const command = 'echo 日本語😀; git "pu\\\nsh"';
    assert.deepEqual(resolveCommandActionMatch(entries, command).matchSpan, {
      ranges: [
        { index: command.indexOf("git"), length: 3 },
        { index: command.indexOf('"pu'), length: 8 },
      ],
    });
  });

  it("does not join lines or inspect substitutions in a quoted heredoc", () => {
    const command = "cat <<'EOF'\nEO\\\nF\ngit push\n${x:-'$(git push)'}\nEOF";
    assert.deepEqual(splitCommandSegments(command), [["cat"]]);
    assert.equal(resolveCommandAction(entries, command), "allow");
  });

  it("retains ordinary unquoted expansions and actual substitutions inside arithmetic", () => {
    assert.equal(resolveCommandAction(entries, "cat <<EOF\n$x ${x}\nEOF"), "allow");
    assert.equal(resolveCommandAction(entries, "echo $((1 + $(git push)))"), "ask");
    assert.throws(
      () => resolveCommandAction(entries, "cat <<EOF\n$((1 + $(git push)))\nEOF"),
      /Unable to parse Bash command/,
    );
  });

  it("does not reject single quotes that belong to a real nested shell command", () => {
    const command = "cat <<EOF\n${x:-$(echo 'literal')}\nEOF";
    assert.deepEqual(splitCommandSegments(command), [["cat"], ["echo", "literal"]]);
    assert.equal(resolveCommandAction(entries, command), "allow");
  });

  it("rejects a continued delimiter even when its text appears inside raw backticks", () => {
    const command = "cat <<EOF\n`echo ok\nEO\\\nF\ngit push\n`\nEOF";
    assert.throws(() => resolveCommandAction(entries, command), /Unable to parse Bash command/);
  });
});

describe("Bash parameter quote contexts", () => {
  const entries = compileCommandRuleEntries([
    { action: "allow", pattern: ".*", args: [] },
    { action: "ask", pattern: "git", args: ["push"] },
  ]).entries;
  const ambiguous = "echo \"${x:-'$(git push)'}\"";

  for (const source of [
    ambiguous,
    `cat <<EOF\n$(${ambiguous})\nEOF`,
    `echo \`${ambiguous}\``,
    `cat <<EOF\n\`${ambiguous}\`\nEOF`,
    `echo "$(${ambiguous})"`,
  ]) {
    it(`rejects hidden substitutions in a double-quoted parameter: ${JSON.stringify(source)}`, () => {
      assert.throws(() => resolveCommandAction(entries, source), /Unable to parse Bash command/);
    });
  }

  const ordinary = "echo ${x:-'$(git push)'}";
  for (const source of [
    ordinary,
    `echo "$(${ordinary})"`,
    `cat <<EOF\n$(${ordinary})\nEOF`,
    "cat <<EOF\n$(echo 'literal')\nEOF",
    "echo \"$(echo 'literal')\"",
  ]) {
    it(`preserves real single-quote suppression in a new shell context: ${JSON.stringify(source)}`, () => {
      assert.equal(resolveCommandAction(entries, source), "allow");
    });
  }

  it("does not inspect double-quoted parameter syntax inside a quoted heredoc body", () => {
    const source = `cat <<'EOF'\n${ambiguous}\nEOF`;
    assert.deepEqual(splitCommandSegments(source), [["cat"]]);
    assert.equal(resolveCommandAction(entries, source), "allow");
  });

  it("still authorizes visible substitutions in double-quoted parameters", () => {
    const source = 'echo "${x:-$(git push)}"';
    assert.equal(resolveCommandAction(entries, source), "ask");
    assert.equal(resolveCommandAction(entries, `cat <<EOF\n$(${source})\nEOF`), "ask");
  });
});

describe("opaque Bash patterns", () => {
  const entries = compileCommandRuleEntries([
    { action: "allow", pattern: ".*", args: [] },
    { action: "ask", pattern: "git", args: ["push"] },
  ]).entries;

  for (const pattern of ["`git push`", "a$(git push)", "$\\\n(git push)"]) {
    const expression = `\${x/${pattern}/a}`;
    const backtickExpression = expression.replaceAll("`", "\\`");
    for (const source of [
      `echo ${expression}`,
      `echo "${expression}"`,
      `cat <<EOF\n$(echo ${expression})\nEOF`,
      ...(pattern.includes("\n")
        ? []
        : [
            `echo \`echo ${backtickExpression}\``,
            `cat <<EOF\n\`echo ${backtickExpression}\`\nEOF`,
          ]),
    ]) {
      it(`rejects hidden substitution syntax in an opaque pattern: ${JSON.stringify(source)}`, () => {
        assert.throws(() => resolveCommandAction(entries, source), /Unable to parse Bash command/);
      });
    }
  }

  for (const source of [
    "echo ${x/abc/a}",
    'echo "${x/a*/b}"',
    "echo ${x/#prefix/replacement}",
    "[[ value =~ ^value$ ]]",
    "echo '${x/`git push`/a}'",
    "echo ${x:-'$(git push)'}",
    "cat <<'EOF'\n${x/`git push`/a} ${x/$\\\n(git push)/a}\nEOF",
  ]) {
    it(`preserves ordinary patterns and literal quoting: ${JSON.stringify(source)}`, () => {
      assert.equal(resolveCommandAction(entries, source), "allow");
    });
  }

  it("still authorizes visible command substitutions in patterns", () => {
    for (const source of [
      "echo ${x/$(git push)/a}",
      "echo `echo ${x/$\\\n(git push)/a}`",
      "cat <<EOF\n`echo ${x/$\\\n(git push)/a}`\nEOF",
    ]) {
      assert.equal(resolveCommandAction(entries, source), "ask", source);
    }
  });
});

describe("heredoc command boundaries", () => {
  const entries = compileCommandRuleEntries([
    { action: "allow", pattern: ".*", args: [] },
    { action: "ask", pattern: "git", args: ["push"] },
    { action: "ask_with_reason", pattern: "reason", args: [] },
    { action: "deny", pattern: "stop", args: [] },
  ]).entries;

  it("accepts variable-like text in a quoted heredoc without expanding it", () => {
    const command = "cat <<'EOF'\n${JSON.stringify(config)}\nEOF";
    assert.deepEqual(splitCommandSegments(command), [["cat"]]);
    assert.equal(resolveCommandAction(entries, command), "allow");
  });

  it("removes quotes from heredoc delimiters without expanding them", () => {
    for (const [source, delimiter] of [
      ["'EOF'", "EOF"],
      ['"EOF"', "EOF"],
      ["\\EOF", "EOF"],
      ["'$EOF'", "$EOF"],
      ['"${EOF}"', "${EOF}"],
      ["'-EOF'", "-EOF"],
    ]) {
      const command = `cat <<${source}\n\${JSON.stringify(config)}\n${delimiter}\ngit push`;
      assert.deepEqual(splitCommandSegments(command), [["cat"], ["git", "push"]], command);
      assert.equal(resolveCommandAction(entries, command), "ask", command);
    }
  });

  it("does not tokenize quotes, escapes, comments or substitutions in quoted bodies", () => {
    const body = [
      "'",
      '"',
      "\\",
      "# EOF",
      "prefix EOF suffix",
      "$(stop)",
      "`stop`",
      "${JSON.stringify(config)}",
      "stop",
    ].join("\n");
    const command = `cat <<'EOF'\n${body}\nEOF\necho done`;
    assert.deepEqual(splitCommandSegments(command), [["cat"], ["echo", "done"]]);
    assert.equal(resolveCommandAction(entries, command), "allow");
  });

  it("authorizes the executable parts of the opening line", () => {
    for (const [opening, action] of [
      ["cat <<'EOF' | git push", "ask"],
      ["cat <<'EOF' || reason", "ask_with_reason"],
      ["cat <<'EOF' && stop", "deny"],
      ["cat <<'EOF' $(git push)", "ask"],
    ]) {
      const command = `${opening}\n\${JSON.stringify(config)}\nEOF`;
      assert.equal(resolveCommandAction(entries, command), action, command);
    }
  });

  it("authorizes commands after the closing line even when the body has unmatched quotes", () => {
    for (const [following, action] of [
      ["git push", "ask"],
      ["reason", "ask_with_reason"],
      ["stop", "deny"],
    ]) {
      const command = `cat <<'EOF'\n'\nEOF\n${following}`;
      assert.equal(resolveCommandAction(entries, command), action, command);
    }
    const onlyCat = compileCommandRuleEntries([
      { action: "allow", pattern: "cat", args: [] },
    ]).entries;
    assert.equal(resolveCommandAction(onlyCat, "cat <<'EOF'\n'\nEOF\nunknown"), "deny");
  });

  it("keeps original match ranges on the opening line", () => {
    const command = "cat <<'EOF' | git -C 'a b' push\n${JSON.stringify(config)}\nEOF";
    const match = resolveCommandActionMatch(entries, command);
    assert.equal(match.action, "ask");
    assert.deepEqual(match.matchSpan, {
      ranges: [
        { index: command.indexOf("git"), length: 3 },
        { index: command.indexOf("push"), length: 4 },
      ],
    });
  });

  it("keeps original match ranges after the closing line", () => {
    const command = "cat <<'EOF'\ngit push\n'\nEOF\ngit -C 'a b' push";
    const match = resolveCommandActionMatch(entries, command);
    assert.equal(match.action, "ask");
    assert.deepEqual(match.matchSpan, {
      ranges: [
        { index: command.lastIndexOf("git"), length: 3 },
        { index: command.lastIndexOf("push"), length: 4 },
      ],
    });
  });

  it("strips leading tabs only for dash heredocs", () => {
    const command = "cat <<-'EOF'\n\t${JSON.stringify(config)}\n\tEOF\nstop";
    assert.deepEqual(splitCommandSegments(command), [["cat"], ["stop"]]);
    assert.equal(resolveCommandAction(entries, command), "deny");
    const literalTab = "cat <<'EOF'\n\tEOF\nstop\nEOF\ngit push";
    assert.throws(() => resolveCommandAction(entries, literalTab), /ambiguous heredoc end/);
  });

  it("rejects ambiguous whitespace-padded closing lines", () => {
    for (const body of [" EOF\nstop", "EOF \nstop"]) {
      const command = `cat <<'EOF'\n${body}\nEOF\ngit push`;
      assert.throws(() => resolveCommandAction(entries, command), /ambiguous heredoc end/, command);
    }
    const command = "cat <<'EOF'\nprefix EOF suffix\nstop\nEOF\ngit push";
    assert.deepEqual(splitCommandSegments(command), [["cat"], ["git", "push"]]);
  });

  it("rejects unsupported multiple heredocs and empty delimiters", () => {
    for (const command of [
      "cat <<'FIRST' <<SECOND\n'\nFIRST\nstop\nSECOND\ngit push",
      "cat <<''\nbody\n\ngit push",
      "cat <<'EOF'; reason\nbody\nEOF",
    ])
      assert.throws(
        () => resolveCommandAction(entries, command),
        /Unable to parse Bash command/,
        command,
      );
  });

  it("keeps nested heredoc bodies in their own shell contexts", () => {
    for (const opening of ["$(", "<(", ">("]) {
      const command = `cat <<'OUT' ${opening}cat <<'IN'\ninner\nIN\n)\nouter\nOUT\nstop`;
      const match = resolveCommandActionMatch(entries, command);
      assert.equal(match.action, "deny", command);
      assert.deepEqual(match.matchSpan, {
        ranges: [{ index: command.lastIndexOf("stop"), length: 4 }],
      });
    }
  });

  it("accepts parsed case patterns while an outer heredoc is pending", () => {
    for (const opening of ["$(", "<(", ">("]) {
      for (const pattern of ["x)", "(x)"]) {
        const command = `cat <<'OUT' ${opening}case x in ${pattern} cat <<'IN'\ninner\nIN\n;; esac\n)\nouter\nOUT\nstop`;
        assert.equal(resolveCommandAction(entries, command), "deny", command);
        assert.deepEqual(splitCommandSegments(command), [["cat"], ["cat"], ["stop"]], command);
      }
    }
  });

  it("does not reject case words outside overlapping heredoc contexts", () => {
    for (const command of [
      "cat <<'EOF'\ncase\nEOF\ngit push",
      "cat <<'EOF'\nbody\nEOF\necho $(case x in x) echo ok ;; esac)\ngit push",
      "cat <<'EOF' $(echo 'case')\nbody\nEOF\ngit push",
      "cat <<'EOF' $(echo c\\ase)\nbody\nEOF\ngit push",
      "echo case; cat <<'EOF'\nbody\nEOF\ngit push",
    ]) {
      assert.equal(resolveCommandAction(entries, command), "ask", command);
    }
  });

  it("does not confuse identical delimiters in nested contexts", () => {
    const command = "cat <<'EOF' $(cat <<'EOF'\ninner\nEOF\n)\nouter\nEOF\nstop";
    assert.equal(resolveCommandAction(entries, command), "deny");
  });

  it("rejects heredoc operators without a delimiter instead of allowing a partial command", () => {
    for (const command of ["cat <<\nstop", "cat <<", "cat <<; stop", "cat <<-\nstop"]) {
      assert.throws(
        () => resolveCommandAction(entries, command),
        /Unable to parse Bash command/,
        command,
      );
    }
  });

  it("preserves parse errors outside quoted heredoc bodies", () => {
    for (const command of [
      "cat <<${JSON.stringify(config)}\nhello",
      "cat <<'prefix'${JSON.stringify(config)}\nhello",
      "cat <<'EOF'\nbody\nEOF\necho ${JSON.stringify(config)}",
    ]) {
      assert.throws(
        () => resolveCommandAction(entries, command),
        /Unable to parse Bash command/,
        command,
      );
    }
  });

  it("fails closed when a shell context closes before its heredoc body", () => {
    const command = "cat <<'OUT' $(cat <<'IN')\ninner\nIN\nouter\nOUT\nstop";
    assert.throws(
      () => resolveCommandAction(entries, command),
      /Unable to parse Bash command/,
      command,
    );
  });

  it("preserves literal unquoted heredocs and ordinary redirections", () => {
    assert.deepEqual(splitCommandSegments("cat <<EOF\nstop\nEOF\ngit push"), [
      ["cat"],
      ["git", "push"],
    ]);
    assert.equal(resolveCommandAction(entries, "cat <<<'stop'; git push"), "ask");
    assert.equal(resolveCommandAction(entries, "cat < input | git push > output"), "ask");
  });
});

it(
  "keeps one-shot authorization for commands containing quoted heredocs",
  withGuardrail(
    `commands:
  - tool:
      - ask_with_reason: []
  - stop:
      - deny: []`,
    async (guardrail, cwd) => {
      const command = "tool <<'EOF'\n${JSON.stringify(config)}\n'\nEOF";
      const context = { cwd, hasUI: true, ui: { confirm: async () => true } };
      await guardrail.requestCommandPermission(command, "test", context);
      await assert.rejects(
        async () => guardrail.authorizeCommand(`${command}\nstop`, context),
        /Command denied/,
      );
      assert.equal(await guardrail.authorizeCommand(command, context), true);
      await assert.rejects(
        async () => guardrail.authorizeCommand(command, context),
        /requires a reason/,
      );
    },
  ),
);

it(
  "once approvals cover all parsed substitutions but retain inner token boundaries",
  withGuardrail(
    `commands:
  - .*:
      - allow: []
  - git:
      - ask_with_reason: [push]`,
    async (guardrail, cwd) => {
      const context = { cwd, hasUI: true, ui: { confirm: async () => true } };
      const command = 'cat <<EOF\n$(git "push" "a b")\nEOF';
      await guardrail.requestCommandPermission(command, "test", context);
      await assert.rejects(
        async () => guardrail.authorizeCommand("cat <<EOF\n`git push a b`\nEOF", context),
        /requires a reason/,
      );
      await assert.rejects(
        async () => guardrail.authorizeCommand(`${command}\necho extra`, context),
        /requires a reason/,
      );
      assert.equal(
        await guardrail.authorizeCommand("cat <<EOF\n`git push 'a b'`\nEOF", context),
        true,
      );
      await assert.rejects(
        async () => guardrail.authorizeCommand(command, context),
        /requires a reason/,
      );
    },
  ),
);

it(
  "once approvals distinguish a quoted single token from two tokens",
  withGuardrail(
    `commands:
  - tool:
      - ask_with_reason: []`,
    async (guardrail, cwd) => {
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
    },
  ),
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
      new URL("../../../../.agents/config.exact/guardrails.yaml", import.meta.url),
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
