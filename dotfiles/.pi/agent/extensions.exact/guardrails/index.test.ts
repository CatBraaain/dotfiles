import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_PREVIEW_LIMIT,
  Sandbox,
  classifyReadPath,
  countResultLines,
  expandPathSection,
  formatDuration,
  formatGrepMatches,
  formatSize,
  parseGuardrailsConfig,
  resolveCommandAction,
  resolvePathAction,
  truncateCommand,
} from "./index";

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
  const previousGroup = group;
  group = name;
  fn();
  group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

function withSandbox(
  configYaml: string,
  cwd: string,
  test: (sandbox: Sandbox) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardrails-test-"));
    try {
      const configPath = join(tempDir, "config.yaml");
      writeFileSync(configPath, configYaml);
      await test(new Sandbox(cwd, configPath));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

const approvingUi = { confirm: async () => true };

describe("§2 パスのアクセス結果", () => {
  const projectRoot = "/workspace/project";

  it(
    "allow パスは確認なしで通る",
    withSandbox(
      `
read:
  allow: [/workspace/project]
`,
      projectRoot,
      async (sandbox) => {
        await sandbox.authorizePath("read", "/workspace/project/file.txt", {
          cwd: projectRoot,
        });
      },
    ),
  );

  it(
    "ask パスはユーザー承認で通る",
    withSandbox(
      `
read:
  ask: [/workspace/project]
`,
      projectRoot,
      async (sandbox) => {
        const confirmedPaths: string[] = [];
        await sandbox.authorizePath("read", "/workspace/project/file.txt", {
          cwd: projectRoot,
          hasUI: true,
          ui: {
            confirm: async (_title, path) => {
              confirmedPaths.push(path);
              return true;
            },
          },
        });
        assert.deepEqual(confirmedPaths, ["/workspace/project/file.txt"]);
      },
    ),
  );

  it(
    "未設定パスは承認後に同じ操作で再確認されない",
    withSandbox(
      `
read: {}
`,
      projectRoot,
      async (sandbox) => {
        let confirmationCount = 0;
        const context = {
          cwd: projectRoot,
          hasUI: true,
          ui: {
            confirm: async () => {
              confirmationCount++;
              return true;
            },
          },
        };
        await sandbox.authorizePath("read", "/workspace/project/file.txt", context);
        await sandbox.authorizePath("read", "/workspace/project/file.txt", context);
        assert.equal(confirmationCount, 1);
      },
    ),
  );

  it(
    "read の動的許可は write の許可にならない",
    withSandbox(
      `
read: {}
write: {}
`,
      projectRoot,
      async (sandbox) => {
        const confirmedOperations: string[] = [];
        const context = {
          cwd: projectRoot,
          hasUI: true,
          ui: {
            confirm: async (title: string) => {
              confirmedOperations.push(title);
              return true;
            },
          },
        };
        await sandbox.authorizePath("read", "/workspace/project/file.txt", context);
        await sandbox.authorizePath("write", "/workspace/project/file.txt", context);
        assert.deepEqual(confirmedOperations, ["Allow read access?", "Allow write access?"]);
      },
    ),
  );

  it(
    "ask パスはユーザー拒否で失敗する",
    withSandbox(
      `
read:
  ask: [/workspace/project]
`,
      projectRoot,
      async (sandbox) => {
        await assert.rejects(async () => {
          await sandbox.authorizePath("read", "/workspace/project/file.txt", {
            cwd: projectRoot,
            hasUI: true,
            ui: { confirm: async () => false },
          });
        }, /Access denied by user/);
      },
    ),
  );

  it(
    "明示 deny パスは許可要求なしで拒否される",
    withSandbox(
      `
read:
  allow: [/workspace/project]
  deny: [/workspace/project/secret]
`,
      projectRoot,
      async (sandbox) => {
        let confirmCalled = false;
        await assert.rejects(async () => {
          await sandbox.authorizePath("read", "/workspace/project/secret/key", {
            cwd: projectRoot,
            hasUI: true,
            ui: {
              confirm: async () => {
                confirmCalled = true;
                return true;
              },
            },
          });
        }, /Access denied/);
        assert.equal(confirmCalled, false);
      },
    ),
  );
});

describe("§2.1 credentials の例外", () => {
  const projectRoot = "/workspace/project";

  it(
    "credentials パスは read の allow 設定でも拒否される",
    withSandbox(
      `
read:
  allow: [/workspace/project]
credentials:
  - /workspace/project/secret
`,
      projectRoot,
      async (sandbox) => {
        await assert.rejects(async () => {
          await sandbox.authorizePath("read", "/workspace/project/secret/key", {
            cwd: projectRoot,
            hasUI: true,
            ui: approvingUi,
          });
        }, /Access denied for credential path/);
      },
    ),
  );
});

describe("§3.a パス文字列の解決", () => {
  const projectRoot = "/workspace/project";

  it("相対パスは cwd を起点に解決する", () => {
    const section = expandPathSection({ allow: ["./sub"] }, projectRoot);
    assert.equal(resolvePathAction(section, "/workspace/project/sub/file.txt"), "allow");
  });

  it("~ はホームディレクトリに解決する", () => {
    const section = expandPathSection({ allow: ["~/docs"] }, projectRoot);
    assert.equal(resolvePathAction(section, `${homedir()}/docs/file.txt`), "allow");
  });

  it("絶対パスはそのまま解決する", () => {
    const section = expandPathSection({ allow: ["/opt/data"] }, "/cwd");
    assert.equal(resolvePathAction(section, "/opt/data/file.txt"), "allow");
  });
});

describe("§3.b glob パターン", () => {
  const withGlobDir = (test: (dir: string) => Promise<void> | void) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "guardrails-glob-"));
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
      const section = expandPathSection({ allow: [join(dir, "*")] }, "/cwd");
      assert.equal(resolvePathAction(section, join(dir, "uv")), "allow");
      assert.equal(resolvePathAction(section, join(dir, "pip")), "allow");
    }),
  );

  it(
    "** は再帰的な既存パスに展開される",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "uv", "nested", "deep"), { recursive: true });
      const section = expandPathSection({ allow: [join(dir, "**")] }, "/cwd");
      assert.equal(resolvePathAction(section, join(dir, "uv", "nested", "deep")), "allow");
    }),
  );

  it(
    "? は任意1文字にマッチする",
    withGlobDir((dir) => {
      writeFileSync(join(dir, "a.txt"), "");
      const section = expandPathSection({ allow: [join(dir, "?.txt")] }, "/cwd");
      assert.equal(resolvePathAction(section, join(dir, "a.txt")), "allow");
    }),
  );

  it(
    "[...] は文字クラスにマッチする",
    withGlobDir((dir) => {
      writeFileSync(join(dir, "b.txt"), "");
      const section = expandPathSection({ allow: [join(dir, "[abc].txt")] }, "/cwd");
      assert.equal(resolvePathAction(section, join(dir, "b.txt")), "allow");
    }),
  );

  it(
    "セッション中に新規作成されたパスは対象外",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "existing"));
      return withSandbox(
        `
read:
  allow: ["${join(dir, "*")}"]
`,
        "/cwd",
        async (sandbox) => {
          mkdirSync(join(dir, "latecomer"));
          await assert.rejects(
            async () => sandbox.authorizePath("read", join(dir, "latecomer"), { cwd: "/cwd" }),
            /Access requires confirmation/,
          );
        },
      )();
    }),
  );
});

describe("§3.c アクションの決定", () => {
  const projectRoot = "/workspace/project";

  const withProjectEnvFile = (test: (dir: string) => void) => () => {
    const dir = mkdtempSync(join(tmpdir(), "guardrails-action-"));
    try {
      writeFileSync(join(dir, ".env"), "");
      test(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it(
    "deny を allow より優先する",
    withProjectEnvFile((dir) => {
      const section = expandPathSection({ allow: ["."], deny: ["**/.env"] }, dir);
      assert.equal(resolvePathAction(section, join(dir, ".env")), "deny");
    }),
  );

  it(
    "deny を ask より優先する",
    withProjectEnvFile((dir) => {
      const section = expandPathSection({ ask: ["."], deny: ["**/.env"] }, dir);
      assert.equal(resolvePathAction(section, join(dir, ".env")), "deny");
    }),
  );

  it(
    "ask を allow より優先する",
    withProjectEnvFile((dir) => {
      const section = expandPathSection({ allow: ["."], ask: ["**/.env"] }, dir);
      assert.equal(resolvePathAction(section, join(dir, ".env")), "ask");
    }),
  );

  it("一致しないパスは deny になる", () => {
    const section = expandPathSection({ allow: ["."] }, projectRoot);
    assert.equal(resolvePathAction(section, "/tmp/file.txt"), "deny");
  });
});

describe("§4 bash コマンドの実行結果", () => {
  it("コマンドの完全な先頭語に一致する", () => {
    assert.equal(
      resolveCommandAction({ allow: ["git status"], deny: ["sudo"] }, "git status --short"),
      "allow",
    );
  });

  it("コマンド deny を allow より優先する", () => {
    assert.equal(resolveCommandAction({ allow: ["*"], deny: ["sudo"] }, "sudo ls"), "deny");
  });

  it(
    "ask コマンドは承認で実行される",
    withSandbox(
      `
commands:
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        const confirmedCommands: string[] = [];
        await sandbox.authorizeCommand("git push origin main", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async (_title, command) => {
              confirmedCommands.push(command);
              return true;
            },
          },
        });
        assert.deepEqual(confirmedCommands, ["git push origin main"]);
      },
    ),
  );

  it(
    "deny コマンドは許可要求なしでブロックされる",
    withSandbox(
      `
commands:
  deny: [sudo]
`,
      "/cwd",
      async (sandbox) => {
        let confirmCalled = false;
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("sudo ls", {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => {
                confirmCalled = true;
                return true;
              },
            },
          });
        }, /Command denied/);
        assert.equal(confirmCalled, false);
      },
    ),
  );

  it(
    "未設定コマンドはブロックされる",
    withSandbox(``, "/cwd", async (sandbox) => {
      await assert.rejects(async () => {
        await sandbox.authorizeCommand("rm -rf /", { cwd: "/cwd" });
      }, /Command denied/);
    }),
  );
});

describe("§6 設定", () => {
  it("全セクションを読み込む", () => {
    const config = parseGuardrailsConfig(`
read:
  allow: ["*"]
write:
  allow: ["."]
  deny: ["**/.env"]
credentials: ["~/.ssh"]
commands:
  allow: [git status]
  deny: [sudo]
`);
    assert.deepEqual(config.read, { allow: ["*"], ask: [], deny: [] });
    assert.deepEqual(config.write, {
      allow: ["."],
      ask: [],
      deny: ["**/.env"],
    });
    assert.deepEqual(config.credentials, ["~/.ssh"]);
    assert.deepEqual(config.commands, {
      allow: ["git status"],
      ask: [],
      deny: ["sudo"],
    });
  });
});

describe("§7.1 grep の例外", () => {
  const emptyFile = () => Promise.resolve("");

  it("context なしはマッチ行だけを path:行番号: 形式で出す", async () => {
    const singleMatch = [{ filePath: "/proj/a.txt", lineNumber: 2, lineText: "match" }];
    const result = await formatGrepMatches(singleMatch, {
      context: 0,
      limit: 100,
      isDirectory: true,
      searchPath: "/proj",
      readFile: emptyFile,
    });
    assert.equal(result.text, "a.txt:2: match");
    assert.equal(result.details.matchCount, 1);
  });

  it("context ありは前後行を path-行番号- 形式で出す", async () => {
    const singleMatch = [{ filePath: "/proj/a.txt", lineNumber: 2, lineText: "match" }];
    const fileContents = new Map([["/proj/a.txt", "before\nmatch\nafter"]]);
    const result = await formatGrepMatches(singleMatch, {
      context: 1,
      limit: 100,
      isDirectory: true,
      searchPath: "/proj",
      readFile: (path) => Promise.resolve(fileContents.get(path) ?? ""),
    });
    assert.equal(result.text, ["a.txt-1- before", "a.txt:2: match", "a.txt-3- after"].join("\n"));
  });

  it("500字超の行は切り詰めて truncation 通知を出す", async () => {
    const oversizedLine = "x".repeat(600);
    const singleMatch = [{ filePath: "/proj/a.txt", lineNumber: 1, lineText: oversizedLine }];
    const result = await formatGrepMatches(singleMatch, {
      context: 0,
      limit: 100,
      isDirectory: false,
      searchPath: "/proj/a.txt",
      readFile: emptyFile,
    });
    assert.equal(result.details.linesTruncated, true);
    assert.ok(result.text.includes("[truncated]"));
  });

  it("50KB 超の出力はバイト truncation 通知を出す", async () => {
    const manyMatches = Array.from({ length: 1000 }, (_, index) => ({
      filePath: "/proj/big.txt",
      lineNumber: index + 1,
      lineText: "x".repeat(100),
    }));
    const result = await formatGrepMatches(manyMatches, {
      context: 0,
      limit: 1000,
      isDirectory: false,
      searchPath: "/proj/big.txt",
      readFile: emptyFile,
    });
    assert.equal(result.details.truncation?.truncated, true);
  });

  it("limit 到達でマッチリミット通知を出す", async () => {
    const twoMatches = [
      { filePath: "/proj/a.txt", lineNumber: 1, lineText: "m" },
      { filePath: "/proj/a.txt", lineNumber: 2, lineText: "m" },
    ];
    const result = await formatGrepMatches(twoMatches, {
      context: 0,
      limit: 2,
      isDirectory: false,
      searchPath: "/proj/a.txt",
      readFile: emptyFile,
    });
    assert.ok(result.text.includes("2 matches limit reached"));
    assert.equal(result.details.matchLimitReached, 2);
  });

  it("マッチがないときは No matches found を返す", async () => {
    const result = await formatGrepMatches([], {
      context: 0,
      limit: 100,
      isDirectory: true,
      searchPath: "/proj",
      readFile: emptyFile,
    });
    assert.equal(result.text, "No matches found");
    assert.equal(result.details.matchCount, 0);
  });
});

describe("§8 表示", () => {
  it("長いコマンドを80文字に切り詰める", () => {
    const longCommand = "a".repeat(COMMAND_PREVIEW_LIMIT + 1);
    assert.equal(truncateCommand(longCommand).length, COMMAND_PREVIEW_LIMIT);
  });

  it("実行時間を秒の小数一桁で表示する", () => {
    assert.equal(formatDuration(1200), "1.2s");
  });

  it("結果テキストの末尾改行を除いて行数を数える", () => {
    assert.equal(countResultLines("a\nb\n"), 2);
  });

  it("バイト数を適切な単位で表示する", () => {
    assert.equal(formatSize(1536), "1.5KB");
  });

  it("read が SKILL.md のとき skill 分類を返す", () => {
    const classification = classifyReadPath({ path: "/skills/my-skill/SKILL.md" }, "/cwd");
    assert.deepEqual(classification, { kind: "skill", label: "my-skill" });
  });

  it("read が SKILL.md 以外のファイルのとき undefined を返す", () => {
    const classification = classifyReadPath({ path: "/skills/my-skill/README.md" }, "/cwd");
    assert.equal(classification, undefined);
  });

  it("read の相対パスを cwd 起点で解決して SKILL.md を判定する", () => {
    const classification = classifyReadPath(
      { path: "skills/my-skill/SKILL.md" },
      "/workspace",
    );
    assert.deepEqual(classification, { kind: "skill", label: "my-skill" });
  });

  it("read の path が文字列でないとき undefined を返す", () => {
    const classification = classifyReadPath({ path: undefined }, "/cwd");
    assert.equal(classification, undefined);
  });

  it("read の path が空文字のとき undefined を返す", () => {
    const classification = classifyReadPath({ path: "" }, "/cwd");
    assert.equal(classification, undefined);
  });
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed++;
  } catch (error) {
    failures.push(
      `  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
