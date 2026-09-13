import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Sandbox,
  compileCommandRuleEntries,
  expandPathSection,
  normalizeToolPath,
  parseSandboxedToolsConfig,
  resolveCommandAction,
  resolvePathAction,
  resolvePathActionMatch,
  withSandboxSlot,
} from "./sandbox";
import { existsSync } from "node:fs";

function withSandbox(
  configYaml: string,
  cwd: string,
  test: (sandbox: Sandbox) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sandboxed-tools-test-"));
    try {
      const configPath = join(tempDir, "sandbox.yaml");
      writeFileSync(configPath, configYaml);
      await test(new Sandbox(cwd, configPath));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function withTempDirectory(test: (directory: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "sandboxed-tools-test-"));
    try {
      await test(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A main worktree plus one linked worktree, so Git-variable resolution can be exercised on both sides. */
function withLinkedWorktree(
  test: (
    mainWorktreePath: string,
    linkedWorktreePath: string,
    workspacePath: string,
  ) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "sandboxed-tools-git-"));
    const mainWorktreePath = join(workspacePath, "main");
    const linkedWorktreePath = join(workspacePath, "linked");
    try {
      runGit(workspacePath, ["init", mainWorktreePath]);
      runGit(mainWorktreePath, ["config", "user.email", "sandboxed-tools@example.com"]);
      runGit(mainWorktreePath, ["config", "user.name", "SandboxedTools"]);
      writeFileSync(join(mainWorktreePath, "README.md"), "initial\n");
      runGit(mainWorktreePath, ["add", "README.md"]);
      runGit(mainWorktreePath, ["commit", "-m", "initial"]);
      runGit(mainWorktreePath, ["worktree", "add", linkedWorktreePath]);
      await test(mainWorktreePath, linkedWorktreePath, workspacePath);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  };
}

/** Compile string-pattern command entries to the regex form used at runtime (§6). */
const compiled = (
  entries: { action: "allow" | "ask" | "deny" | "ask_with_reason"; patterns: string[] }[],
) => compileCommandRuleEntries(entries).entries;

describe("§6 設定", () => {
  it("全セクションを読み込む", () => {
    const config = parseSandboxedToolsConfig(`
read:
  - {allow: "*"}
write:
  - {allow: .}
  - {deny: "**/.env"}
credentials: ["~/.ssh"]
commands:
  - {allow: git status}
  - {deny: ['^sudo\\b']}
`);
    assert.deepEqual(config.read, [{ action: "allow", patterns: ["*"] }]);
    assert.deepEqual(config.write, [
      { action: "allow", patterns: ["."] },
      { action: "deny", patterns: ["**/.env"] },
    ]);
    assert.deepEqual(config.credentials, ["~/.ssh"]);
    assert.deepEqual(config.commands, [
      { action: "allow", patterns: ["git status"] },
      { action: "deny", patterns: ["^sudo\\b"] },
    ]);
  });

  it("1 要素に複数パターンを宣言できる", () => {
    const config = parseSandboxedToolsConfig(`
commands:
  - {ask: [git push, "gh pr create"]}
`);
    assert.deepEqual(config.commands, [{ action: "ask", patterns: ["git push", "gh pr create"] }]);
  });

  it("パターンリスト内の非文字列要素は無視される", () => {
    const config = parseSandboxedToolsConfig(
      'commands:\n  - {allow: ["^ls\\\\b", 1, null]}\nread:\n  - {allow: ["*", 2]}\n',
    );
    assert.deepEqual(config.commands, [{ action: "allow", patterns: ["^ls\\b"] }]);
    assert.deepEqual(config.read, [{ action: "allow", patterns: ["*"] }]);
  });

  it("commands は ask_with_reason を読み込む", () => {
    const config = parseSandboxedToolsConfig(`
commands:
  - {ask_with_reason: [sudo, "chmod -R"]}
`);
    assert.deepEqual(config.commands, [
      { action: "ask_with_reason", patterns: ["sudo", "chmod -R"] },
    ]);
  });

  it("read と write で ask_with_reason は設定エラーになる", () => {
    assert.throws(() => parseSandboxedToolsConfig("read:\n  - {ask_with_reason: ~/.ssh}\n"));
    assert.throws(() => parseSandboxedToolsConfig("write:\n  - {ask_with_reason: /tmp}\n"));
  });

  it("記法を満たさない config は throw する", () => {
    assert.throws(() => parseSandboxedToolsConfig('read:\n  allow: ["."]\n'));
    assert.throws(() => parseSandboxedToolsConfig('read:\n  - {allow: ".", deny: "x"}\n'));
    assert.throws(() => parseSandboxedToolsConfig('read:\n  - {permit: "."}\n'));
    assert.throws(() => parseSandboxedToolsConfig("read:\n  - {allow: 1}\n"));
  });

  it(
    "記法を満たさない config で構築した Sandbox は全セクション未設定（= deny）で動作する",
    withSandbox('read:\n  allow: ["."]\n', "/cwd", (sandbox) => {
      assert.equal(sandbox.resolvePathAction("read", "/cwd/file.txt").action, "deny");
      assert.equal(sandbox.resolveCommandAction("ls").action, "deny");
    }),
  );

  it("出荷configは検証を通り、repository 専用の worktrees パスを許可する", () => {
    const config = parseSandboxedToolsConfig(
      readFileSync(new URL("../../../config/sandbox.yaml", import.meta.url), "utf8"),
    );
    const writeAllowPatterns = config.write
      ?.filter((entry) => entry.action === "allow")
      .flatMap((entry) => entry.patterns);

    assert.equal(writeAllowPatterns?.includes("~/.agents/worktrees/${REPOSITORY_NAME}"), true);
  });

  it("出荷configのcommandsパターンはすべて有効な正規表現としてコンパイルされる", () => {
    // A real cwd: since phase 2 the constructor mkdir-p's the write-allow
    // fixed paths (§6.1), and "/cwd" (write allow ".") would try to create a
    // directory at the filesystem root.
    const sandbox = new Sandbox(
      mkdtempSync(join(tmpdir(), "sandboxed-tools-cwd-")),
      fileURLToPath(new URL("../../../config/sandbox.yaml", import.meta.url)),
    );

    assert.deepEqual(sandbox.invalidCommandPatterns, []);
    assert.equal(sandbox.resolveCommandAction("git status").action, "allow");
    assert.equal(sandbox.resolveCommandAction("systemctl reboot").action, "deny");
  });
});

describe("§6 commands パターンの正規表現評価", () => {
  it("正規表現は部分一致で評価され、^ と $ で制約する", () => {
    assert.equal(
      resolveCommandAction(compiled([{ action: "ask", patterns: ["push"] }]), "git push"),
      "ask",
    );
    assert.equal(
      resolveCommandAction(compiled([{ action: "ask", patterns: ["^push"] }]), "git push"),
      "deny",
    );
  });

  it("正規表現の量指定子が使え、コマンドパターンのブレース展開はしない", () => {
    const section = compiled([{ action: "allow", patterns: ["^a{2}$"] }]);
    assert.equal(resolveCommandAction(section, "aa"), "allow");
    assert.equal(resolveCommandAction(section, "a{2}"), "deny");
    assert.equal(resolveCommandAction(section, "a2"), "deny");
  });

  it("無効な正規表現パターンだけが無視され、無効パターンとして報告される", () => {
    const { entries, invalidPatterns } = compileCommandRuleEntries([
      { action: "allow", patterns: ["*"] },
      { action: "ask", patterns: ["^git push\\b", "[unclosed"] },
    ]);
    assert.deepEqual(invalidPatterns, ["*", "[unclosed"]);
    assert.equal(resolveCommandAction(entries, "git push origin main"), "ask");
  });

  it("Sandbox は無効パターンを重複なしで列挙し、有効なエントリは動く", () =>
    withSandbox(
      `
commands:
  - {allow: ["*"]}
  - {allow: ["*"]}
  - {deny: ['^sudo\\b']}
`,
      "/cwd",
      (sandbox) => {
        assert.deepEqual(sandbox.invalidCommandPatterns, ["*"]);
        assert.equal(sandbox.resolveCommandAction("sudo ls").action, "deny");
      },
    )());
});

describe("§3 ツール引数パスの正規化", () => {
  it("~・~/... はホームディレクトリへ展開する", () => {
    assert.equal(normalizeToolPath("~"), homedir());
    assert.equal(normalizeToolPath("~/docs/note.txt"), join(homedir(), "docs", "note.txt"));
    assert.equal(normalizeToolPath("/abs/path"), "/abs/path");
  });

  it("相対パスはセッション cwd を起点に絶対パスへ解決する", () => {
    const cwd = "/workspace/project";
    assert.equal(resolve(cwd, normalizeToolPath("src/a.ts")), join(cwd, "src", "a.ts"));
    assert.equal(resolve(cwd, normalizeToolPath("~/docs")), join(homedir(), "docs"));
  });
});

describe("§3.a パス文字列の解決", () => {
  const projectRoot = "/workspace/project";

  it("相対パスは cwd を起点に解決する", () => {
    const section = expandPathSection([{ action: "allow", patterns: ["./sub"] }], projectRoot);
    assert.equal(resolvePathAction(section, "/workspace/project/sub/file.txt"), "allow");
  });

  it("~ はホームディレクトリに解決する", () => {
    const section = expandPathSection([{ action: "allow", patterns: ["~/docs"] }], projectRoot);
    assert.equal(resolvePathAction(section, `${homedir()}/docs/file.txt`), "allow");
  });

  it("絶対パスはそのまま解決する", () => {
    const section = expandPathSection([{ action: "allow", patterns: ["/opt/data"] }], "/cwd");
    assert.equal(resolvePathAction(section, "/opt/data/file.txt"), "allow");
  });

  it(
    "${GIT_MAIN_WORKTREE_PATH} は linked worktree を cwd にしても main worktree へ展開される",
    withLinkedWorktree((mainWorktreePath, linkedWorktreePath) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: ["${GIT_MAIN_WORKTREE_PATH}"] }],
        linkedWorktreePath,
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [mainWorktreePath],
      );
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH} はパスエントリ内の任意の位置に記述できる",
    withLinkedWorktree((mainWorktreePath) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: ["${GIT_MAIN_WORKTREE_PATH}/.git"] }],
        mainWorktreePath,
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [join(mainWorktreePath, ".git")],
      );
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH} は Git repository 外ではパスを許可しない",
    withTempDirectory((directory) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: ["${GIT_MAIN_WORKTREE_PATH}-worktrees"] }],
        directory,
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [],
      );
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH}-worktrees は main worktree の兄弟へ展開される",
    withLinkedWorktree((_mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: ["${GIT_MAIN_WORKTREE_PATH}-worktrees"] }],
        linkedWorktreePath,
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [join(workspacePath, "main-worktrees")],
      );
    }),
  );

  it(
    "${REPOSITORY_NAME} は main worktree の basename へ展開される",
    withLinkedWorktree((mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(workspacePath, "worktrees", "${REPOSITORY_NAME}")] }],
        linkedWorktreePath,
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [join(workspacePath, "worktrees", basename(mainWorktreePath))],
      );
    }),
  );

  it(
    "${REPOSITORY_NAME} を含むパスは current repository の worktree 置き場配下を許可する",
    withLinkedWorktree((mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(workspacePath, "worktrees", "${REPOSITORY_NAME}")] }],
        linkedWorktreePath,
      );

      assert.equal(
        resolvePathAction(
          section,
          join(workspacePath, "worktrees", basename(mainWorktreePath), "topic"),
        ),
        "allow",
      );
    }),
  );

  it(
    "${REPOSITORY_NAME} を含むパスは他リポジトリの worktree 置き場を許可しない",
    withLinkedWorktree((_mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(workspacePath, "worktrees", "${REPOSITORY_NAME}")] }],
        linkedWorktreePath,
      );

      assert.equal(
        resolvePathAction(section, join(workspacePath, "worktrees", "other", "topic")),
        "deny",
      );
    }),
  );

  it(
    "${REPOSITORY_NAME} を含むパスは Git repository 外ではパスを許可しない",
    withTempDirectory((directory) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: ["~/.agents/worktrees/${REPOSITORY_NAME}"] }],
        directory,
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [],
      );
    }),
  );

  it(
    "${XDG_RUNTIME_DIR} は $XDG_RUNTIME_DIR へ展開される",
    withTempDirectory((directory) => {
      const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = directory;
      try {
        const section = expandPathSection(
          [{ action: "allow", patterns: ["${XDG_RUNTIME_DIR}"] }],
          "/cwd",
        );

        assert.deepEqual(
          section.flatMap((entry) => entry.paths),
          [directory],
        );
      } finally {
        if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
      }
    }),
  );

  it("${XDG_RUNTIME_DIR} は未設定なら /run/user/<uid> へフォールバックする", () => {
    const uid = process.getuid?.();
    assert.notEqual(uid, undefined, "test requires POSIX process.getuid");
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const section = expandPathSection(
        [{ action: "allow", patterns: ["${XDG_RUNTIME_DIR}/app"] }],
        "/cwd",
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [`/run/user/${uid}/app`],
      );
    } finally {
      if (previousRuntimeDir !== undefined) process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    }
  });
});

describe("§3.b glob パターン", () => {
  const withGlobDir = (test: (dir: string) => Promise<void> | void) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-glob-"));
    try {
      await test(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it(
    "* は直下の既存パスに展開される",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "uv"));
      mkdirSync(join(dir, "pip"));
      const section = expandPathSection([{ action: "allow", patterns: [join(dir, "*")] }], "/cwd");
      assert.equal(resolvePathAction(section, join(dir, "uv")), "allow");
      assert.equal(resolvePathAction(section, join(dir, "pip")), "allow");
    }),
  );

  it(
    "** は再帰的な既存パスに展開される",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "uv", "nested", "deep"), { recursive: true });
      const section = expandPathSection([{ action: "allow", patterns: [join(dir, "**")] }], "/cwd");
      assert.equal(resolvePathAction(section, join(dir, "uv", "nested", "deep")), "allow");
    }),
  );

  it(
    "? は任意1文字にマッチする",
    withGlobDir((dir) => {
      writeFileSync(join(dir, "a.txt"), "");
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(dir, "?.txt")] }],
        "/cwd",
      );
      assert.equal(resolvePathAction(section, join(dir, "a.txt")), "allow");
    }),
  );

  it(
    "[...] は文字クラスにマッチする",
    withGlobDir((dir) => {
      writeFileSync(join(dir, "b.txt"), "");
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(dir, "[abc].txt")] }],
        "/cwd",
      );
      assert.equal(resolvePathAction(section, join(dir, "b.txt")), "allow");
    }),
  );

  it(
    "{a,b} はカンマ区切りの選択肢に展開される",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "git"));
      mkdirSync(join(dir, "npm"));
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(dir, "{git,npm}")] }],
        "/cwd",
      );
      assert.equal(resolvePathAction(section, join(dir, "git")), "allow");
      assert.equal(resolvePathAction(section, join(dir, "npm")), "allow");
    }),
  );

  it('"*" 単体は read のすべてのパス許可になる', () => {
    const section = expandPathSection([{ action: "allow", patterns: ["*"] }], "/cwd", true);
    assert.equal(resolvePathAction(section, "/etc/passwd"), "allow");
  });

  it(
    '"*" 単体は write の全パス許可にならない',
    withGlobDir((dir) => {
      const section = expandPathSection([{ action: "allow", patterns: ["*"] }], dir);
      assert.equal(resolvePathAction(section, "/etc/passwd"), "deny");
    }),
  );

  it(
    '"*" 単体は credentials の全パス制限にならない',
    withGlobDir((dir) =>
      withSandbox(
        `
read:
  - {allow: [/]}
credentials: ["*"]
`,
        dir,
        (sandbox) => {
          assert.equal(sandbox.isCredentialPath("/etc/passwd"), false);
        },
      )(),
    ),
  );

  it(
    "glob はセッション開始時に展開され、セッション中の新規パスは対象外",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "existing"));
      return withSandbox(
        `
read:
  - {allow: "${join(dir, "*")}"}
`,
        "/cwd",
        (sandbox) => {
          mkdirSync(join(dir, "latecomer"));
          assert.equal(sandbox.resolvePathAction("read", join(dir, "existing")).action, "allow");
          assert.equal(sandbox.resolvePathAction("read", join(dir, "latecomer")).action, "deny");
        },
      )();
    }),
  );
});

describe("§3.c アクションの決定", () => {
  const withProjectEnvFile = (test: (dir: string) => void) => () => {
    const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-action-"));
    try {
      writeFileSync(join(dir, ".env"), "");
      test(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it(
    "後の deny エントリが前の allow エントリを上書きする",
    withProjectEnvFile((dir) => {
      const section = expandPathSection(
        [
          { action: "allow", patterns: ["."] },
          { action: "deny", patterns: ["**/.env"] },
        ],
        dir,
      );
      assert.equal(resolvePathAction(section, join(dir, ".env")), "deny");
    }),
  );

  it(
    "後の deny エントリが前の ask エントリを上書きする",
    withProjectEnvFile((dir) => {
      const section = expandPathSection(
        [
          { action: "ask", patterns: ["."] },
          { action: "deny", patterns: ["**/.env"] },
        ],
        dir,
      );
      assert.equal(resolvePathAction(section, join(dir, ".env")), "deny");
    }),
  );

  it(
    "後の ask エントリが前の allow エントリを上書きする",
    withProjectEnvFile((dir) => {
      const section = expandPathSection(
        [
          { action: "allow", patterns: ["."] },
          { action: "ask", patterns: ["**/.env"] },
        ],
        dir,
      );
      assert.equal(resolvePathAction(section, join(dir, ".env")), "ask");
    }),
  );

  it(
    "後の allow エントリが前の ask エントリを上書きする",
    withProjectEnvFile((dir) => {
      const section = expandPathSection(
        [
          { action: "ask", patterns: ["."] },
          { action: "allow", patterns: ["**/.env"] },
        ],
        dir,
      );
      assert.equal(resolvePathAction(section, join(dir, ".env")), "allow");
    }),
  );

  it("一致しないパスは未設定（= deny）になる", () => {
    const section = expandPathSection([{ action: "allow", patterns: ["."] }], "/workspace/project");
    assert.equal(resolvePathAction(section, "/tmp/file.txt"), "deny");
  });

  it(
    "明示 deny と未設定（= deny）を区別する",
    withProjectEnvFile((dir) => {
      const section = expandPathSection(
        [
          { action: "allow", patterns: ["."] },
          { action: "deny", patterns: ["**/.env"] },
        ],
        dir,
      );
      const explicitDeny = resolvePathActionMatch(section, join(dir, ".env"));
      assert.equal(explicitDeny.action, "deny");
      assert.notEqual(explicitDeny.matched, undefined);

      const unset = resolvePathActionMatch(section, "/tmp/file.txt");
      assert.equal(unset.action, "deny");
      assert.equal(unset.matched, undefined);
    }),
  );
});

describe("§2.2 credentials の例外", () => {
  it(
    "credentials パスは read の allow 設定でも常に拒否対象になる",
    withSandbox(
      `
read:
  - {allow: [/workspace/project]}
credentials:
  - /workspace/project/secret
`,
      "/workspace/project",
      (sandbox) => {
        assert.equal(
          sandbox.resolvePathAction("read", "/workspace/project/secret/key").action,
          "allow",
        );
        assert.equal(sandbox.isCredentialPath("/workspace/project/secret/key"), true);
      },
    ),
  );

  it(
    "credentials のパターンは read/write と同じ変数展開・glob の規則で解決する",
    withGlobDirHelper((dir) => {
      mkdirSync(join(dir, "git"));
      return withSandbox(
        `
credentials:
  - "${join(dir, "{git,npm}")}"
  - ~/.dsh/.credentials.yaml
`,
        "/cwd",
        (sandbox) => {
          assert.equal(sandbox.isCredentialPath(join(dir, "git", "config")), true);
          assert.equal(sandbox.isCredentialPath(join(dir, "npm", "rc")), true);
          assert.equal(
            sandbox.isCredentialPath(join(homedir(), ".dsh", ".credentials.yaml")),
            true,
          );
          assert.equal(sandbox.isCredentialPath(join(dir, "other")), false);
        },
      )();
    }),
  );

  it(
    "credentials は read/write のアクション判定に影響しない",
    withSandbox(
      `
read:
  - {allow: [/workspace/project]}
credentials:
  - /workspace/project/secret
`,
      "/workspace/project",
      (sandbox) => {
        // The credential path itself is outside read/write resolution: the
        // section matches it by config, and §2.2 denial happens in the
        // authorize gate (phase 2) via isCredentialPath, not here.
        const match = sandbox.resolvePathAction("read", "/workspace/project/secret");
        assert.equal(match.action, "allow");
      },
    ),
  );
});

/** Shared directory fixture for credentials-glob tests. */
function withGlobDirHelper(test: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-cred-"));
    try {
      await test(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("§4 bash コマンドの実行結果", () => {
  it("deny エントリにマッチしないコマンドは前の allow エントリのまま", () => {
    assert.equal(
      resolveCommandAction(
        compiled([
          { action: "allow", patterns: ["^git status\\b"] },
          { action: "deny", patterns: ["^sudo\\b"] },
        ]),
        "git status --short",
      ),
      "allow",
    );
  });

  it("後の deny エントリが前の allow エントリを上書きする", () => {
    assert.equal(
      resolveCommandAction(
        compiled([
          { action: "allow", patterns: [".*"] },
          { action: "deny", patterns: ["^sudo\\b"] },
        ]),
        "sudo ls",
      ),
      "deny",
    );
  });

  it("後の allow エントリが前の ask エントリを上書きする（systemctl 3分類）", () => {
    const entries = compiled([
      { action: "allow", patterns: [".*"] },
      { action: "ask", patterns: ["^systemctl\\b"] },
      { action: "allow", patterns: ["^systemctl (status|list-)"] },
      {
        action: "deny",
        patterns: [
          "^systemctl (reboot|poweroff|halt|shutdown)\\b",
          "^(shutdown|reboot|poweroff|halt)\\b",
        ],
      },
    ]);
    assert.equal(resolveCommandAction(entries, "systemctl status nginx"), "allow");
    assert.equal(resolveCommandAction(entries, "systemctl list-units --all"), "allow");
    assert.equal(resolveCommandAction(entries, "systemctl restart nginx"), "ask");
    assert.equal(resolveCommandAction(entries, "systemctl reboot"), "deny");
    assert.equal(resolveCommandAction(entries, "reboot"), "deny");
  });

  it("複合コマンド内の最も厳しいアクションを適用する", () => {
    const section = compiled([
      { action: "allow", patterns: [".*"] },
      { action: "ask", patterns: ["^git push\\b", "^gh pr create\\b"] },
      { action: "deny", patterns: ["^sudo\\b"] },
    ]);
    assert.equal(
      resolveCommandAction(
        section,
        "git remote add fork https://example.test/repo.git; git remote -v | grep fork && git push -u fork feature | tail -4",
      ),
      "ask",
    );
    assert.equal(resolveCommandAction(section, "git status\ngit push -u origin main"), "ask");
    assert.equal(resolveCommandAction(section, "gh pr create --repo owner/repo 2>&1"), "ask");
    assert.equal(resolveCommandAction(section, "cat body.md | gh pr create --body-file -"), "ask");
    assert.equal(resolveCommandAction(section, "echo $(git push -u origin main)"), "ask");
    assert.equal(resolveCommandAction(section, "tee >(gh pr create --repo owner/repo)"), "ask");
    assert.equal(
      resolveCommandAction(section, "(cd /tmp && gh pr create --repo owner/repo)"),
      "ask",
    );
    assert.equal(resolveCommandAction(section, "ls; sudo reboot"), "deny");
  });

  it("heredoc 本文・コメント・クォート内の文字列をコマンドにしない", () => {
    const section = compiled([
      { action: "allow", patterns: [".*"] },
      { action: "ask", patterns: ["^gh pr create\\b"] },
    ]);
    assert.equal(
      resolveCommandAction(section, "cat << 'EOF'\ngh pr create --repo owner/repo\nEOF"),
      "allow",
    );
    assert.equal(
      resolveCommandAction(section, "cat <<-EOF\ngh pr create --repo owner/repo\nEOF\necho done"),
      "allow",
    );
    assert.equal(resolveCommandAction(section, "echo 'gh pr create --repo owner/repo'"), "allow");
    assert.equal(
      resolveCommandAction(section, "git status # gh pr create --repo owner/repo"),
      "allow",
    );
  });

  it("env と環境変数代入の後ろにあるコマンドを照合する", () => {
    const section = compiled([
      { action: "allow", patterns: [".*"] },
      { action: "ask", patterns: ["^git push\\b", "^gh pr create\\b"] },
    ]);
    assert.equal(
      resolveCommandAction(section, "GH_PAGER=cat gh pr create --repo owner/repo"),
      "ask",
    );
    assert.equal(resolveCommandAction(section, "env git push -u origin main"), "ask");
  });

  it("空コマンドでも allow の全マッチパターンを維持する", () => {
    assert.equal(
      resolveCommandAction(compiled([{ action: "allow", patterns: [".*"] }]), ""),
      "allow",
    );
  });

  it("ask_with_reason は deny > ask_with_reason > ask > allow の順序を適用する", () => {
    const entries = compiled([
      { action: "allow", patterns: [".*"] },
      { action: "ask", patterns: ["^git push\\b"] },
      { action: "ask_with_reason", patterns: ["^sudo\\b"] },
    ]);
    assert.equal(resolveCommandAction(entries, "sudo reboot"), "ask_with_reason");
    assert.equal(resolveCommandAction(entries, "git push && sudo reboot"), "ask_with_reason");
    assert.equal(resolveCommandAction(entries, "git push"), "ask");
    const withDeny = [...entries, ...compiled([{ action: "deny", patterns: ["^mkfs\\b"] }])];
    assert.equal(resolveCommandAction(withDeny, "sudo reboot; mkfs /dev/sda"), "deny");
  });

  it(
    "未設定コマンドはブロック（= deny）される",
    withSandbox("", "/cwd", (sandbox) => {
      assert.equal(sandbox.resolveCommandAction("rm -rf /").action, "deny");
    }),
  );
});

// ---------------------------------------------------------------------------
// phase 2: §2/§2.2 authorization gate, §6.1 bind assembly, §7 semaphore
// ---------------------------------------------------------------------------

describe("§2・§2.2 authorizePath ゲート", () => {
  it(
    "credentials パスは read/write の解決に関係なく常時拒否",
    withSandbox(
      '\nread:\n  - allow: "*"\nwrite:\n  - allow: "*"\ncredentials:\n  - ~/secret-token\n',
      "/cwd",
      (sandbox) => {
        const credential = join(homedir(), "secret-token");
        assert.equal(sandbox.authorizePath("read", credential).kind, "credential");
        assert.equal(sandbox.authorizePath("write", credential).kind, "credential");
      },
    ),
  );

  it(
    "allow / ask / 明示 deny / 未設定 deny を判別する",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nread:\n  - allow: /safe\n  - ask: /askme\n  - deny: /blocked\nwrite:\n  - allow: ${join(dir, "writable")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      assert.equal(sandbox.authorizePath("read", "/safe/file.txt").kind, "allow");
      const ask = sandbox.authorizePath("read", "/askme/file.txt");
      assert.equal(ask.kind, "ask");
      const explicit = sandbox.authorizePath("read", "/blocked/file.txt");
      assert.equal(explicit.kind, "deny");
      assert.notEqual((explicit as { match?: { matched?: string } }).match?.matched, undefined);
      const unset = sandbox.authorizePath("write", "/somewhere-else");
      assert.equal(unset.kind, "deny");
      assert.equal((unset as { match?: { matched?: string } }).match?.matched, undefined);
    }),
  );
});

describe("§6.1 buildArgs と実在保証", () => {
  it(
    'read allow "*" はルート全体を ro-bind する',
    withSandbox('\nread:\n  - allow: "*"\n', "/cwd", (sandbox) => {
      const args = sandbox.buildArgs("fs");
      const roBindAt = args.indexOf("--ro-bind");
      assert.notEqual(roBindAt, -1);
      assert.equal(args[roBindAt + 1], "/");
    }),
  );

  it(
    "allow パスを bind し、credentials を bash では ro-bind・fs ではマスクする",
    withTempDirectory(async (dir) => {
      mkdirSync(join(dir, "allowed"), { recursive: true });
      mkdirSync(join(dir, "creds"), { recursive: true });
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nread:\n  - allow: ${join(dir, "allowed")}\nwrite:\n  - allow: ${join(dir, "allowed")}\ncredentials:\n  - ${join(dir, "creds")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      const fsArgs = sandbox.buildArgs("fs");
      const bashArgs = sandbox.buildArgs("bash");
      // allow bind (read-only for read, writable for write)
      const allowed = join(dir, "allowed");
      const allowedReadAt = fsArgs.indexOf(allowed);
      assert.notEqual(allowedReadAt, -1);
      assert.equal(fsArgs[allowedReadAt - 1], "--ro-bind-try");
      // read allow is ro-bound; write allow is bound writable in both modes
      const pairsWith = (args: string[], flag: string, src: string): boolean =>
        args.some((value, index) => value === flag && args[index + 1] === src);
      assert.equal(pairsWith(fsArgs, "--ro-bind-try", allowed), true);
      assert.equal(pairsWith(fsArgs, "--bind-try", allowed), true);
      assert.equal(pairsWith(bashArgs, "--bind-try", allowed), true);
      // credentials: masked (tmpfs) in fs mode, ro-bound in bash mode
      const creds = join(dir, "creds");
      const maskIndex = fsArgs.indexOf("--tmpfs");
      assert.notEqual(maskIndex, -1);
      assert.equal(fsArgs[maskIndex + 1], creds);
      const credsBind = bashArgs.indexOf(creds);
      assert.notEqual(credsBind, -1);
      assert.equal(bashArgs[credsBind - 1], "--ro-bind-try");
      assert.equal(bashArgs.includes("--tmpfs"), false);
    }),
  );

  it(
    "write deny 確定パスが書き込み可能 bind 配下なら bash で read-only 再 bind する",
    withTempDirectory(async (dir) => {
      mkdirSync(join(dir, "writable", "inner"), { recursive: true });
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nwrite:\n  - allow: ${join(dir, "writable")}\n  - deny: ${join(dir, "writable", "inner")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      const bashArgs = sandbox.buildArgs("bash");
      const denied = join(dir, "writable", "inner");
      // The deny path is re-bound read-only AFTER the writable bind.
      const writableBindAt = bashArgs.indexOf(join(dir, "writable"));
      const denyBindAt = bashArgs.indexOf(denied);
      assert.notEqual(denyBindAt, -1);
      assert.equal(bashArgs[denyBindAt - 1], "--ro-bind-try");
      assert.ok(writableBindAt < denyBindAt);
    }),
  );

  it(
    "基本 argv（--die-with-parent / --proc / --dev / --chdir）を含む",
    withTempDirectory(async (dir) => {
      const sandbox = new Sandbox(dir, join(dir, "none.yaml"));
      const args = sandbox.buildArgs("fs", join(dir, "cwd"));
      assert.equal(args[0], "--die-with-parent");
      assert.ok(args.includes("--proc"));
      assert.ok(args.includes("--dev"));
      assert.equal(args[args.indexOf("--chdir") + 1], join(dir, "cwd"));
    }),
  );

  it(
    "hostPaths を ro-bind（node/runner/rg）し spillDir を書き込み可能 bind する",
    withTempDirectory(async (dir) => {
      mkdirSync(join(dir, "dist"), { recursive: true });
      mkdirSync(join(dir, "rgbin"), { recursive: true });
      mkdirSync(join(dir, "nodebin"), { recursive: true });
      mkdirSync(join(dir, "spill"), { recursive: true });
      const sandbox = new Sandbox(dir, join(dir, "none.yaml"), {
        nodePath: join(dir, "nodebin", "node"),
        runnerJsPath: join(dir, "dist", "runner.js"),
        rgDir: join(dir, "rgbin"),
        spillDir: join(dir, "spill"),
      });
      const args = sandbox.buildArgs("fs");
      const at = (flag: string, path: string): number => {
        const flagAt = args.indexOf(flag);
        return flagAt !== -1 ? args.indexOf(path, flagAt) : -1;
      };
      assert.notEqual(at("--ro-bind-try", join(dir, "nodebin")), -1);
      assert.notEqual(at("--ro-bind-try", join(dir, "dist")), -1);
      assert.notEqual(at("--ro-bind-try", join(dir, "rgbin")), -1);
      const spillBindAt = args.indexOf("--bind-try");
      assert.notEqual(spillBindAt, -1);
      assert.equal(args[spillBindAt + 1], join(dir, "spill"));
    }),
  );

  it(
    "write allow の固定パスを mkdir -p し、glob と ${XDG_RUNTIME_DIR} 相当は対象外",
    withTempDirectory(async (dir) => {
      const target = join(dir, "made", "dir");
      const runtimeDir = join(dir, "run", "uid");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nwrite:\n  - allow:\n      - ${target}\n      - ${join(dir, "cache", "*")}\n      - \${XDG_RUNTIME_DIR}/plugin\n`,
      );
      process.env.XDG_RUNTIME_DIR = runtimeDir;
      try {
        new Sandbox(dir, configPath);
        assert.equal(existsSync(target), true);
        assert.equal(existsSync(join(dir, "cache")), false);
        assert.equal(existsSync(join(runtimeDir, "plugin")), false);
      } finally {
        delete process.env.XDG_RUNTIME_DIR;
      }
    }),
  );
});

describe("§7 sandbox 同時実行セマフォ", () => {
  it("同時実行は最大 4 で、待機は開始順に始まる", async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const run = (id: number, ms: number): Promise<void> =>
      withSandboxSlot(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(id);
        await new Promise((resolve) => setTimeout(resolve, ms));
        active -= 1;
      });
    await Promise.all([run(1, 60), run(2, 60), run(3, 60), run(4, 60), run(5, 20), run(6, 20)]);
    assert.ok(maxActive <= 4, `max concurrent ${maxActive} exceeded 4`);
    // FIFO: the 5th run starts only after an earlier one finished (which
    // means it starts after run 1 in this all-equal-duration setup).
    assert.equal(started.indexOf(5) > started.indexOf(1), true);
    assert.equal(started.length, 6);
  });
});

// ---------------------------------------------------------------------------
// §2.3・§3 phase 3: confirmations, dynamic grants, ask_permission flows
// ---------------------------------------------------------------------------

import {
  COMMAND_REASON_HINT,
  RUNTIME_PATHS,
  parseRunnerResponse,
  withUiLock,
  type ConfirmOptions,
  type PathApproval,
  type RunToolOptions,
} from "./sandbox";
import type { ConfirmUi } from "./confirm";
import type { RunnerRequest } from "./runner";

/** One scripted dialog round: the label picked, free text, or a thrown error. */
type DialogRound = { label?: string; custom?: string; error?: Error };

/**
 * A fake userQuestions seam answering from a script: each ask() consumes the
 * next round. Records every question's shape so dialogs are asserted too.
 */
function scriptedUi(rounds: DialogRound[]): {
  ui: ConfirmUi;
  questions: { question: string; detail?: string; options?: string[] }[];
} {
  const questions: { question: string; detail?: string; options?: string[] }[] = [];
  const ui: ConfirmUi = {
    async ask(request) {
      const question = request.questions[0]!;
      questions.push({
        question: question.question,
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        ...(question.options === undefined
          ? {}
          : { options: question.options.map((option) => option.label) }),
      });
      const round = rounds.shift() ?? {};
      if (round.error !== undefined) throw round.error;
      const selected = round.label === undefined ? [] : [round.label];
      return {
        answers: [
          {
            id: question.id,
            selected,
            ...(round.custom === undefined ? {} : { custom: round.custom }),
          },
        ],
      };
    },
  };
  return { ui, questions };
}

const confirmWith = (ui: ConfirmUi): ConfirmOptions => ({ ui });

describe("§2.3 authorizePathWithConfirm（fs ツールの確認）", () => {
  it(
    "allow は確認なしで通り、approval も返さない",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nwrite:\n  - allow: ${join(dir, "w")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([]);
      const approval = await sandbox.authorizePathWithConfirm(
        "write",
        join(dir, "w", "a.txt"),
        confirmWith(ui),
      );
      assert.equal(approval, undefined);
      assert.equal(questions.length, 0);
    }),
  );

  it(
    "read の ask 承認は file スコープの動的許可を追加し、2 回目は確認しない",
    withTempDirectory(async (dir) => {
      const target = join(dir, "askme", "file.txt");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nread:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([{ label: "Yes, allow" }]);
      const approval = await sandbox.authorizePathWithConfirm("read", target, confirmWith(ui));
      assert.deepEqual(approval, {
        operation: "read",
        scope: "file",
        grantedPath: target,
      } satisfies PathApproval);
      // Second call on the same path passes with no dialog and no approval note.
      assert.equal(
        await sandbox.authorizePathWithConfirm("read", target, confirmWith(ui)),
        undefined,
      );
      assert.equal(questions.length, 1);
      assert.equal(questions[0]!.question, "Allow read access?");
      assert.equal(questions[0]!.detail, `${target}\nmatched: ${join(dir, "askme")}`);
      assert.deepEqual(questions[0]!.options, ["Yes, allow", "No, deny (reason next)"]);
    }),
  );

  it(
    "write の ask で File only は file スコープ（実在保証で親と空ファイルを作る）",
    withTempDirectory(async (dir) => {
      const target = join(dir, "askme", "new", "file.txt");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nwrite:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([{ label: "File only" }]);
      const approval = await sandbox.authorizePathWithConfirm("write", target, confirmWith(ui));
      assert.deepEqual(approval, {
        operation: "write",
        scope: "file",
        grantedPath: target,
        createdFile: true,
      } satisfies PathApproval);
      // §6.1 existence guarantee: the parent is mkdir-ed and the file touched.
      assert.equal(existsSync(target), true);
      assert.equal(statSync(target).isFile(), true);
    }),
  );

  it(
    "write の ask で Directory (subtree) は親ディレクトリ配下を mkdir して許可",
    withTempDirectory(async (dir) => {
      const target = join(dir, "askme", "sub", "file.txt");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nwrite:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([{ label: "Directory (subtree)" }]);
      const approval = await sandbox.authorizePathWithConfirm("write", target, confirmWith(ui));
      const grantedDir = join(dir, "askme", "sub");
      assert.deepEqual(approval, {
        operation: "write",
        scope: "directory",
        grantedPath: grantedDir,
      });
      assert.equal(existsSync(grantedDir), true);
      // The subtree root itself passes afterwards without a dialog.
      assert.equal(
        await sandbox.authorizePathWithConfirm(
          "write",
          join(grantedDir, "other.txt"),
          confirmWith(ui),
        ),
        undefined,
      );
    }),
  );

  it(
    "拒否は Access denied by user と User reason を返し、許可は追加しない",
    withTempDirectory(async (dir) => {
      const target = join(dir, "askme", "file.txt");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nread:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([{ label: "No, deny (reason next)" }, { custom: "not yet" }]);
      await assert.rejects(
        sandbox.authorizePathWithConfirm("read", target, confirmWith(ui)),
        /Access denied by user: [^\n]+\nUser reason: not yet/,
      );
      // Not granted: the next call asks again.
      const again = scriptedUi([{ label: "No, deny (reason next)" }, {}]);
      await assert.rejects(
        sandbox.authorizePathWithConfirm("read", target, confirmWith(again.ui)),
        /Access denied by user: [^\n]+/,
      );
    }),
  );

  it(
    "キャンセル・中断も拒否として扱う（理由の追問ができなければ理由なし）",
    withTempDirectory(async (dir) => {
      const target = join(dir, "askme", "file.txt");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nread:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([{ error: new Error("ASK_ABORTED") }]);
      await assert.rejects(
        sandbox.authorizePathWithConfirm("read", target, confirmWith(ui)),
        (error: Error) => error.message.startsWith("Access denied by user:"),
      );
    }),
  );

  it(
    "credentials と明示 deny はダイアログなしで拒否、UI が無ければ ask は拒否扱い",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nread:\n  - allow: /safe\n  - deny: ${join(dir, "blocked")}\ncredentials:\n  - ${join(dir, "creds")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([]);
      await assert.rejects(
        sandbox.authorizePathWithConfirm("read", join(dir, "creds", "token"), confirmWith(ui)),
        /Access denied for credential path: /,
      );
      await assert.rejects(
        sandbox.authorizePathWithConfirm("read", join(dir, "blocked", "x"), confirmWith(ui)),
        /Access denied: /,
      );
      await assert.rejects(
        sandbox.authorizePathWithConfirm("read", join(dir, "unset", "x"), {}),
        /Access requires confirmation: /,
      );
      assert.equal(questions.length, 0);
    }),
  );

  it(
    "read と write の動的許可は別々に管理する",
    withTempDirectory(async (dir) => {
      const target = join(dir, "askme", "file.txt");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nread:\n  - ask: ${join(dir, "askme")}\nwrite:\n  - ask: ${join(dir, "askme")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([{ label: "Yes, allow" }, { label: "File only" }]);
      await sandbox.authorizePathWithConfirm("read", target, confirmWith(ui));
      // The read grant does not cover write: write still asks (2nd round).
      const approval = await sandbox.authorizePathWithConfirm("write", target, confirmWith(ui));
      // The target already exists, so the guarantee creates nothing.
      assert.deepEqual(approval, { operation: "write", scope: "file", grantedPath: target });
    }),
  );

  it(
    "未設定（= deny）も ask と同じ確認になり、パターン行は no matching pattern",
    withTempDirectory(async (dir) => {
      const target = join(dir, "unset", "file.txt");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x");
      const sandbox = new Sandbox(dir, join(dir, "absent.yaml"));
      const { ui, questions } = scriptedUi([{ label: "Yes, allow" }]);
      const approval = await sandbox.authorizePathWithConfirm("read", target, confirmWith(ui));
      assert.deepEqual(approval, { operation: "read", scope: "file", grantedPath: target });
      assert.ok(questions[0]!.detail!.includes("no matching pattern (default ask)"));
    }),
  );
});

describe("§3 requestWritePermission（ask_permission の path）", () => {
  it(
    "明示 deny と credentials は要求不可エラー、UI 無しはエラー",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nwrite:\n  - deny: ${join(dir, "blocked")}\ncredentials:\n  - ${join(dir, "creds")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([]);
      await assert.rejects(
        sandbox.requestWritePermission(join(dir, "blocked"), "why", confirmWith(ui)),
        /Access denied: /,
      );
      await assert.rejects(
        sandbox.requestWritePermission(join(dir, "creds"), "why", confirmWith(ui)),
        /Access denied for credential path: /,
      );
      await assert.rejects(
        sandbox.requestWritePermission(join(dir, "unset"), "why", {}),
        /Access requires confirmation: /,
      );
      assert.equal(questions.length, 0);
    }),
  );

  it(
    "allow は確認なしで already granted",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nwrite:\n  - allow: ${join(dir, "w")}\n`);
      // A real file in the write-allow directory (§6.1 mkdir-ed by the
      // Sandbox constructor) so the scope resolves to the parent (file → parent).
      const sandbox = new Sandbox(dir, configPath);
      writeFileSync(join(dir, "w", "a.txt"), "x");
      const { ui, questions } = scriptedUi([]);
      assert.deepEqual(
        await sandbox.requestWritePermission(join(dir, "w", "a.txt"), "why", confirmWith(ui)),
        { status: "already granted", grantedPath: join(dir, "w") },
      );
      assert.equal(questions.length, 0);
    }),
  );

  it(
    "承認は reason 行とパターン行を含む確認を通り、ディレクトリ配下を書込可能にする",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nwrite:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([{ label: "Yes, allow" }]);
      const outcome = await sandbox.requestWritePermission(
        join(dir, "askme"),
        "to edit files",
        confirmWith(ui),
      );
      assert.deepEqual(outcome, { status: "granted", grantedPath: join(dir, "askme") });
      assert.equal(questions[0]!.question, "Allow write access to directory subtree?");
      assert.equal(
        questions[0]!.detail,
        `${join(dir, "askme")}\nreason: to edit files\nmatched: ${join(dir, "askme")}`,
      );
      assert.deepEqual(questions[0]!.options, ["Yes, allow", "No, deny (reason next)"]);
      // §6.1: the granted directory now exists and the subtree is writable.
      assert.equal(existsSync(join(dir, "askme")), true);
      assert.equal(
        await sandbox.authorizePathWithConfirm(
          "write",
          join(dir, "askme", "x.txt"),
          confirmWith(ui),
        ),
        undefined,
      );
      // bash shares the grant: the bind includes the dynamic path.
      const args = sandbox.buildArgs("bash");
      assert.equal(
        args.some(
          (value, index) => value === "--bind-try" && args[index + 1] === join(dir, "askme"),
        ),
        true,
      );
    }),
  );

  it(
    "拒否は denied と理由を返し、以降の write は従来どおり個別確認",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nwrite:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([
        { label: "No, deny (reason next)" },
        { custom: "later" },
        { label: "File only" },
      ]);
      const outcome = await sandbox.requestWritePermission(
        join(dir, "askme"),
        "why",
        confirmWith(ui),
      );
      assert.deepEqual(outcome, {
        status: "denied",
        grantedPath: join(dir, "askme"),
        reason: "later",
      });
      // Not granted: a write under the path still asks (and can be approved).
      const approval = await sandbox.authorizePathWithConfirm(
        "write",
        join(dir, "askme", "x.txt"),
        confirmWith(ui),
      );
      assert.deepEqual(approval, {
        operation: "write",
        scope: "file",
        grantedPath: join(dir, "askme", "x.txt"),
        createdFile: true,
      });
    }),
  );

  it(
    "不在パスはそのパス配下を、実在するファイルパスは親ディレクトリ配下をスコープにする",
    withTempDirectory(async (dir) => {
      writeFileSync(join(dir, "file.txt"), "x");
      const sandbox = new Sandbox(dir, join(dir, "absent.yaml"));
      // Absent path first: its grant must not cover the existing file's
      // parent scope (the two requests are independent subtrees).
      const absentUi = scriptedUi([{ label: "Yes, allow" }]);
      const absent = join(dir, "new-worktree");
      assert.deepEqual(
        await sandbox.requestWritePermission(absent, "why", confirmWith(absentUi.ui)),
        { status: "granted", grantedPath: absent },
      );
      assert.equal(existsSync(absent), true);
      const fileUi = scriptedUi([{ label: "Yes, allow" }]);
      assert.deepEqual(
        await sandbox.requestWritePermission(join(dir, "file.txt"), "why", confirmWith(fileUi.ui)),
        { status: "granted", grantedPath: dir },
      );
    }),
  );
});

describe("§3 requestCommandPermission（ask_permission の command）", () => {
  it(
    "deny（明示・未設定）は要求不可、allow は確認なしの already granted、ask は事前承認対象外エラー",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        [
          "commands:",
          "  - { deny: '^dangerous\\b' }",
          "  - { allow: '^git status$' }",
          "  - { ask: '^git push$' }",
          "  - { ask_with_reason: '^sudo\\b' }",
        ].join("\n"),
      );
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([]);
      await assert.rejects(
        sandbox.requestCommandPermission("dangerous move", "why", confirmWith(ui)),
        /Command denied: dangerous move/,
      );
      await assert.rejects(
        sandbox.requestCommandPermission("unknown-cmd", "why", confirmWith(ui)),
        /Command denied: unknown-cmd/,
      );
      assert.deepEqual(
        await sandbox.requestCommandPermission("git status", "why", confirmWith(ui)),
        { status: "already granted", command: "git status" },
      );
      await assert.rejects(
        sandbox.requestCommandPermission("git push", "why", confirmWith(ui)),
        /no pre-approval needed/,
      );
      assert.equal(questions.length, 0);
    }),
  );

  it(
    "ask_with_reason の承認は1回限りの事前承認になり、UI 無しはエラー",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, "commands:\n  - { ask_with_reason: '^sudo\\b' }\n");
      const sandbox = new Sandbox(dir, configPath);
      await assert.rejects(
        sandbox.requestCommandPermission("sudo reboot", "why", {}),
        /Access requires confirmation: /,
      );
      const { ui, questions } = scriptedUi([{ label: "Yes, allow" }]);
      const outcome = await sandbox.requestCommandPermission(
        "sudo reboot",
        "system maintenance",
        confirmWith(ui),
      );
      assert.deepEqual(outcome, { status: "granted", command: "sudo reboot" });
      assert.equal(questions[0]!.question, "Allow command execution?");
      assert.equal(
        questions[0]!.detail,
        `sudo reboot\nreason: system maintenance\nmatched: ^sudo\\b`,
      );
      // The one-shot approval runs once without a dialog, then is consumed.
      assert.equal(await sandbox.authorizeCommand("sudo reboot", confirmWith(ui)), true);
      await assert.rejects(
        sandbox.authorizeCommand("sudo reboot", confirmWith(ui)),
        (error: Error) => error.message.includes("Command requires a reason"),
      );
    }),
  );

  it(
    "拒否は denied と理由を返し、コマンドは差し戻しを受け続ける",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, "commands:\n  - { ask_with_reason: '^sudo\\b' }\n");
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([{ label: "No, deny (reason next)" }, { custom: "no sudo" }]);
      const outcome = await sandbox.requestCommandPermission("sudo reboot", "why", confirmWith(ui));
      assert.deepEqual(outcome, { status: "denied", command: "sudo reboot", reason: "no sudo" });
      await assert.rejects(
        sandbox.authorizeCommand("sudo reboot", confirmWith(ui)),
        /Command requires a reason: sudo reboot/,
      );
    }),
  );
});

describe("§4 authorizeCommand（bash ゲート）", () => {
  it(
    "allow は承認なし、ask はダイアログ承認で true・拒否で User reason 付きエラー",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, "commands:\n  - { allow: '^ls$' }\n  - { ask: '^git push$' }\n");
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([{ label: "Yes, allow" }]);
      assert.equal(await sandbox.authorizeCommand("ls", confirmWith(ui)), false);
      assert.equal(await sandbox.authorizeCommand("git push", confirmWith(ui)), true);
      assert.equal(questions.length, 1);
      assert.equal(questions[0]!.question, "Allow command?");
      assert.equal(questions[0]!.detail, `git push\nmatched: ^git push$`);
      assert.deepEqual(questions[0]!.options, ["Yes, allow", "No, deny (reason next)"]);
      const denied = scriptedUi([{ label: "No, deny (reason next)" }, { custom: "wrong remote" }]);
      await assert.rejects(
        sandbox.authorizeCommand("git push", confirmWith(denied.ui)),
        /Command denied by user: git push\nUser reason: wrong remote/,
      );
      const noUi = new Sandbox(dir, configPath);
      await assert.rejects(
        noUi.authorizeCommand("git push", {}),
        /Command requires confirmation: git push/,
      );
    }),
  );

  it(
    "ask_with_reason は理由必須の差し戻しで、ask_permission と同じコマンドの再送だけ通す",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, "commands:\n  - { ask_with_reason: '^sudo\\b' }\n");
      const sandbox = new Sandbox(dir, configPath);
      const { ui } = scriptedUi([{ label: "Yes, allow" }]);
      await sandbox.requestCommandPermission("sudo apt update", "updates", confirmWith(ui));
      // Quoting differences normalize away (segment comparison).
      assert.equal(await sandbox.authorizeCommand(`sudo 'apt' update`, confirmWith(ui)), true);
      // Partial matches never consume: a different sudo command is still gated.
      await assert.rejects(
        sandbox.authorizeCommand("sudo apt upgrade", confirmWith(ui)),
        (error: Error) =>
          error.message === `Command requires a reason: sudo apt upgrade\n${COMMAND_REASON_HINT}`,
      );
    }),
  );
});

describe("§2 確認の直列化", () => {
  it(
    "並行する確認は一度に1つずつ表示し、待機中の動的許可で確認を省く",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nread:\n  - ask: ${join(dir, "askme")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      const target = join(dir, "askme", "shared.txt");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x");

      // The first dialog stays open until released; the second must not start.
      let releaseFirst: (() => void) | undefined;
      const opened: string[] = [];
      const ui: ConfirmUi = {
        async ask(request) {
          const question = request.questions[0]!;
          opened.push(question.question);
          if (opened.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
          const approve = opened.length === 1;
          return {
            answers: [
              {
                id: question.id,
                selected: approve ? ["Yes, allow"] : [],
              },
            ],
          };
        },
      };
      const first = sandbox.authorizePathWithConfirm("read", target, confirmWith(ui));
      // Let the first dialog open before starting the sibling call.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(opened, ["Allow read access?"]);
      const second = sandbox.authorizePathWithConfirm("read", target, confirmWith(ui));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Still one dialog: the sibling waits on the §2 serialization.
      assert.equal(opened.length, 1);
      releaseFirst?.();
      const [firstApproval, secondApproval] = await Promise.all([first, second]);
      assert.notEqual(firstApproval, undefined);
      // §2: the waiting call passed on the sibling's grant — no second dialog,
      // and no approval note for it.
      assert.equal(secondApproval, undefined);
      assert.equal(opened.length, 1);
    }),
  );

  it("withUiLock は直列に実行し、失敗してもキューを壊さない", async () => {
    const order: number[] = [];
    const first = withUiLock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(1);
      return "first";
    });
    const second = withUiLock(async () => {
      order.push(2);
      return "second";
    });
    const failing = withUiLock(async () => {
      throw new Error("dialog failed");
    });
    await assert.rejects(failing, /dialog failed/);
    assert.equal(await first, "first");
    assert.equal(await second, "second");
    assert.deepEqual(order, [1, 2]);
  });
});

describe("§6.1 動的許可の bind", () => {
  it(
    "承認済みパスは fs でも bash でも bind される（read は ro、write は書込可能）",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nread:\n  - ask: ${join(dir, "askread")}\nwrite:\n  - ask: ${join(dir, "askwrite")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      mkdirSync(join(dir, "askread"), { recursive: true });
      const readFile = join(dir, "askread", "f.txt");
      writeFileSync(readFile, "x");
      const readUi = scriptedUi([{ label: "Yes, allow" }]);
      await sandbox.authorizePathWithConfirm("read", readFile, confirmWith(readUi.ui));
      const writeUi = scriptedUi([{ label: "Directory (subtree)" }]);
      await sandbox.authorizePathWithConfirm(
        "write",
        join(dir, "askwrite", "f.txt"),
        confirmWith(writeUi.ui),
      );
      for (const mode of ["fs", "bash"] as const) {
        const args = sandbox.buildArgs(mode);
        assert.equal(
          args.some((value, index) => value === "--ro-bind-try" && args[index + 1] === readFile),
          true,
          `read grant not bound in ${mode}`,
        );
        assert.equal(
          args.some(
            (value, index) => value === "--bind-try" && args[index + 1] === join(dir, "askwrite"),
          ),
          true,
          `write grant not bound in ${mode}`,
        );
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// E1・C2 追加分: ホワイトリスト bind とセッション cwd、明示 deny と動的許可、
// 実在保証失敗、宣言ベースのマスク、複合コマンドの matched 表示
// ---------------------------------------------------------------------------

describe("§6.1・§7.2 セッション cwd の bind はポリシーに従う", () => {
  it(
    "read allow が cwd を覆うときは allow エントリ経由で ro-bind する",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nread:\n  - allow: ${dir}\n`);
      const sandbox = new Sandbox(dir, configPath);
      for (const mode of ["fs", "bash"] as const) {
        const args = sandbox.buildArgs(mode);
        assert.equal(
          args.some((value, index) => value === "--ro-bind-try" && args[index + 1] === dir),
          true,
          mode,
        );
      }
    }),
  );

  it(
    "read allow に含まれないセッション cwd は bind しない（ホワイトリスト方式）",
    withTempDirectory(async (dir) => {
      mkdirSync(join(dir, "sub"));
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nread:\n  - allow: ${join(dir, "sub")}\n`);
      const sandbox = new Sandbox(dir, configPath);
      for (const mode of ["fs", "bash"] as const) {
        const args = sandbox.buildArgs(mode);
        assert.equal(
          args.some(
            (value, index) =>
              (value === "--ro-bind-try" || value === "--bind-try") && args[index + 1] === dir,
          ),
          false,
          `${mode}: cwd must not be bound when no allow entry covers it`,
        );
      }
      // The allow entry itself is still bound; only the cwd bind is gone.
      const fsArgs = sandbox.buildArgs("fs");
      assert.equal(
        fsArgs.some(
          (value, index) => value === "--ro-bind-try" && fsArgs[index + 1] === join(dir, "sub"),
        ),
        true,
      );
    }),
  );
});

describe("§3 明示 deny と動的許可の優先順位", () => {
  it(
    "明示 deny は動的許可より優先する（親サブツリー許可でも deny 配下は確認なしで拒否）",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nwrite:\n  - ask: ${join(dir, "w")}\n  - deny: ${join(dir, "w", "secret")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([{ label: "Yes, allow" }]);
      const outcome = await sandbox.requestWritePermission(join(dir, "w"), "why", confirmWith(ui));
      assert.equal(outcome.status, "granted");
      // The granted subtree covers the deny path, but the explicit deny still
      // throws before any dialog (§3: 明示 deny は動的許可より優先).
      await assert.rejects(
        sandbox.authorizePathWithConfirm("write", join(dir, "w", "secret", "k"), confirmWith(ui)),
        /Access denied: /,
      );
      assert.equal(questions.length, 1);
    }),
  );
});

describe("§6.1 許可要求の実在保証", () => {
  it(
    "作成に失敗した許可要求はエラーを返し、後続の呼び出しの動作を変えない",
    withTempDirectory(async (dir) => {
      // A regular file where the granted directory would have to be created:
      // the §6.1 mkdir fails with ENOTDIR.
      writeFileSync(join(dir, "blocker"), "");
      const sandbox = new Sandbox(dir, join(dir, "absent.yaml"));
      const target = join(dir, "blocker", "sub");
      const { ui, questions } = scriptedUi([
        { label: "Yes, allow" },
        { label: "No, deny (reason next)" },
      ]);
      await assert.rejects(
        sandbox.requestWritePermission(target, "why", confirmWith(ui)),
        /ENOTDIR|not a directory/,
      );
      // The failed grant was not recorded: the same request asks again
      // (question 2) and its denial runs the reason follow-up (question 3).
      const denied = await sandbox.requestWritePermission(target, "why", confirmWith(ui));
      assert.equal(denied.status, "denied");
      assert.equal(questions.length, 3);
      // And no bind appeared for the failed path.
      const args = sandbox.buildArgs("bash");
      assert.equal(
        args.some((value, index) => value === "--bind-try" && args[index + 1] === target),
        false,
      );
    }),
  );
});

describe("§6.1 read-deny 宣言の fs マスク", () => {
  it(
    "deny 宣言要素の実在パスは allow に確定していても fs sandbox でマスクする",
    withTempDirectory(async (dir) => {
      mkdirSync(join(dir, "proj", "secret"), { recursive: true });
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(
        configPath,
        `\nread:\n  - deny: ${join(dir, "proj", "secret")}\n  - allow: ${join(dir, "proj")}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      // Last match wins → the secret subtree resolves allow …
      assert.equal(
        sandbox.resolvePathAction("read", join(dir, "proj", "secret", "k")).action,
        "allow",
      );
      // … yet the deny-declared existing directory is masked (tmpfs) in fs mode.
      const fsArgs = sandbox.buildArgs("fs");
      assert.equal(
        fsArgs.some(
          (value, index) =>
            value === "--tmpfs" && fsArgs[index + 1] === join(dir, "proj", "secret"),
        ),
        true,
      );
      // bash does not mask it (§6.1: bash コマンドの sandbox ではマスクしない).
      assert.equal(sandbox.buildArgs("bash").includes("--tmpfs"), false);
    }),
  );
});

describe("§2.3 複合コマンド ask の matched 表示", () => {
  it(
    "ask と判定されたセグメントのパターンを示す",
    withTempDirectory(async (dir) => {
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, "commands:\n  - { allow: '.*' }\n  - { ask: '^git push\\b' }\n");
      const sandbox = new Sandbox(dir, configPath);
      const { ui, questions } = scriptedUi([{ label: "Yes, allow" }]);
      const command = "ls; git push -u origin main";
      assert.equal(await sandbox.authorizeCommand(command, confirmWith(ui)), true);
      assert.equal(questions[0]!.question, "Allow command?");
      assert.equal(questions[0]!.detail, `${command}\nmatched: ^git push\\b`);
    }),
  );
});

// ---------------------------------------------------------------------------
// C3 追加分: §7 sandbox 実行経路（fake bwrap）、§7.3 runtime path、§5 network
// ---------------------------------------------------------------------------

describe("§7 envelope と失敗扱い（parseRunnerResponse）", () => {
  const executionOf = (stdout: string, stderr = "", exitCode: number | null = 0) => ({
    exitCode,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.from(stderr, "utf8"),
  });

  it("ok:true / ok:false の JSON envelope をそのまま返す", () => {
    assert.deepEqual(parseRunnerResponse(executionOf('{"ok":true,"result":{"path":"/a"}}')), {
      ok: true,
      result: { path: "/a" },
    });
    assert.deepEqual(parseRunnerResponse(executionOf('{"ok":false,"error":"boom"}', "", 1)), {
      ok: false,
      error: "boom",
    });
  });

  it("非 JSON stdout は stderr、次いで終了コードの情報で失敗扱いにする", () => {
    assert.deepEqual(parseRunnerResponse(executionOf("not json", "partial crash", 3)), {
      ok: false,
      error: "partial crash",
    });
    assert.deepEqual(parseRunnerResponse(executionOf("garbage", "", 2)), {
      ok: false,
      error: "runner exited with code 2",
    });
    assert.deepEqual(parseRunnerResponse(executionOf("", "", null)), {
      ok: false,
      error: "runner terminated",
    });
  });

  it("形式を満たさない envelope（result なし・非文字列 error）は失敗扱いにフォールバックする", () => {
    assert.deepEqual(parseRunnerResponse(executionOf('{"ok":true}', "", 0)), {
      ok: false,
      error: "runner exited with code 0",
    });
    assert.deepEqual(parseRunnerResponse(executionOf('{"ok":false,"error":42}', "", 1)), {
      ok: false,
      error: "runner exited with code 1",
    });
  });
});

describe("§5・§7.3 buildArgs（network と runtime paths）", () => {
  it(
    "network namespace は分離しない（--unshare-net 等を渡さない）",
    withTempDirectory(async (dir) => {
      const sandbox = new Sandbox(dir, join(dir, "none.yaml"));
      for (const mode of ["fs", "bash"] as const) {
        const args = sandbox.buildArgs(mode);
        assert.equal(
          args.some((value) => value.includes("unshare") || value.includes("share-net")),
          false,
          `${mode}: network must stay shared (§5)`,
        );
      }
    }),
  );

  it(
    "§7.3 runtime paths を実在するものだけ ro-bind する",
    withTempDirectory(async (dir) => {
      const sandbox = new Sandbox(dir, join(dir, "none.yaml"));
      const args = sandbox.buildArgs("fs");
      const existing = RUNTIME_PATHS.filter((path) => existsSync(path));
      assert.ok(existing.length > 0, "test expects at least one existing runtime path (e.g. /usr)");
      for (const path of existing) {
        assert.equal(
          args.some(
            (value, index) =>
              value === "--ro-bind-try" && args[index + 1] === path && args[index + 2] === path,
          ),
          true,
          `${path} should be ro-bound (§7.3)`,
        );
      }
    }),
  );

  it(
    "read allow * では個別の runtime path bind を省く（ルート ro-bind が覆う）",
    withSandbox('\nread:\n  - allow: "*"\n', "/cwd", (sandbox) => {
      const args = sandbox.buildArgs("fs");
      assert.equal(
        args.some((value) => value === "--ro-bind-try"),
        false,
      );
    }),
  );
});

describe("§7 sandbox 実行（fake bwrap 経由）", () => {
  /**
   * Place a fake `bwrap` executable first on the PATH passed to the sandbox
   * spawn: it records its argv (line 1) and stdin (line 2), then answers with
   * the scripted stdout/exit behavior. The real bubblewrap cannot run inside
   * this environment (nested user namespaces are denied), so the §7 process
   * plumbing — argv handoff, stdin JSON, stdout envelope, non-zero-exit
   * failure handling, abort/timeout kills — is verified against this script.
   */
  function withFakeBwrap(
    scriptBody: string,
    test: (helpers: {
      sandbox: Sandbox;
      nodePath: string;
      runnerJsPath: string;
      capturePath: string;
      run: (
        request: RunnerRequest,
        options?: Pick<RunToolOptions, "timeoutMs" | "signal">,
      ) => Promise<unknown>;
    }) => Promise<void> | void,
  ): () => Promise<void> {
    return withTempDirectory(async (dir) => {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      const capturePath = join(dir, "capture.txt");
      writeFileSync(join(binDir, "bwrap"), `#!/bin/sh\n${scriptBody}\n`);
      chmodSync(join(binDir, "bwrap"), 0o755);
      const runnerJsPath = join(dir, "dist", "runner.js");
      mkdirSync(dirname(runnerJsPath));
      writeFileSync(runnerJsPath, "");
      const configPath = join(dir, "sandbox.yaml");
      writeFileSync(configPath, `\nread:\n  - allow: ${dir}\n`);
      const sandbox = new Sandbox(dir, configPath, {
        nodePath: process.execPath,
        runnerJsPath,
      });
      const env = {
        PATH: `${binDir}:/usr/bin:/bin`,
        FAKE_BWRAP_CAPTURE: capturePath,
      };
      const run = (
        request: RunnerRequest,
        options: Pick<RunToolOptions, "timeoutMs" | "signal"> = {},
      ) => sandbox.runTool(request, { mode: "fs", env, ...options });
      await test({ sandbox, nodePath: process.execPath, runnerJsPath, capturePath, run });
    });
  }

  it(
    "1 回の起動で stdin JSON を渡し stdout envelope を結果として返す（argv は buildArgs + node runner）",
    withFakeBwrap(
      `echo "$@" > "$FAKE_BWRAP_CAPTURE"
cat >> "$FAKE_BWRAP_CAPTURE"
echo '{"ok":true,"result":{"path":"ok"}}'`,
      async ({ sandbox, nodePath, runnerJsPath, capturePath, run }) => {
        const request: RunnerRequest = {
          tool: "read",
          params: { file_path: "/w/a.txt" },
          options: { callId: "call-1" },
        };
        assert.deepEqual(await run(request), { path: "ok" });
        const [argvLine, stdinLine] = readFileSync(capturePath, "utf8").split("\n");
        // The child receives the assembled sandbox argv followed by node + runner.
        assert.equal(argvLine, [...sandbox.buildArgs("fs"), nodePath, runnerJsPath].join(" "));
        // §7: the request JSON travels over stdin, one bwrap process per call.
        assert.equal(stdinLine, JSON.stringify(request));
      },
    ),
  );

  it(
    "ok:false envelope（非 0 終了を含む）は失敗として error を投げる",
    withFakeBwrap(
      `cat > /dev/null
echo '{"ok":false,"error":"runner failed"}'
exit 1`,
      async ({ run }) => {
        await assert.rejects(
          run({ tool: "read", params: { file_path: "/w/a.txt" } }),
          /runner failed/,
        );
      },
    ),
  );

  it(
    "非 0 終了で envelope が無ければ stderr・終了コードの情報で失敗扱いにする",
    withFakeBwrap(
      `echo 'helper crashed hard' >&2
exit 3`,
      async ({ run }) => {
        await assert.rejects(
          run({ tool: "read", params: { file_path: "/w/a.txt" } }),
          /helper crashed hard/,
        );
      },
    ),
  );

  it(
    "abort は bwrap ごと child process を停止する",
    withFakeBwrap(
      `cat > /dev/null
exec sleep 30`,
      async ({ run }) => {
        const controller = new AbortController();
        const pending = run(
          { tool: "read", params: { file_path: "/w/a.txt" } },
          { signal: controller.signal },
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.abort();
        await assert.rejects(pending, /tool call aborted/);
      },
    ),
  );

  it(
    "外側のタイムアウトで child を kill し失敗にする",
    withFakeBwrap(
      `cat > /dev/null
exec sleep 30`,
      async ({ run }) => {
        await assert.rejects(
          run({ tool: "read", params: { file_path: "/w/a.txt" } }, { timeoutMs: 200 }),
          /sandbox timed out after 200ms/,
        );
      },
    ),
  );
});
