import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import guardrailsExtension, {
  COMMAND_PREVIEW_LIMIT,
  classifyReadPath,
  countMatchLines,
  countResultLines,
  formatDuration,
  formatSize,
  truncateCommand,
} from "./index";
import {
  Sandbox,
  expandPathSection,
  parseGuardrailsConfig,
  resolveCommandAction,
  resolvePathAction,
} from "./sandbox";

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

// 拡張 factory を stub API で読み込み、registerTool されたツールを取り出す
const captureRegisteredTools = (): Map<string, any> => {
  const registered = new Map<string, any>();
  guardrailsExtension({
    registerTool: (tool: any) => registered.set(tool.name, tool),
  } as any);
  return registered;
};

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

  it("edit は read.deny パスを read チェックで拒否する", async () => {
    const editTool = captureRegisteredTools().get("edit");
    const deniedFilePath = join(homedir(), ".pi/agent/auth.json");
    await assert.rejects(
      () =>
        editTool.execute("t", { path: deniedFilePath, edits: [] }, undefined, undefined, {
          hasUI: false,
        }),
      /Access denied/,
    );
  });

  it("edit は read 許可後も write チェックで止まる", async () => {
    const editTool = captureRegisteredTools().get("edit");
    const homeNotePath = join(homedir(), "guardrails-edit-write-gate.txt");
    await assert.rejects(
      () =>
        editTool.execute("t", { path: homeNotePath, edits: [] }, undefined, undefined, {
          hasUI: false,
        }),
      /Access requires confirmation/,
    );
  });
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
    "{a,b} はカンマ区切りの選択肢に展開される",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "git"));
      mkdirSync(join(dir, "npm"));
      const section = expandPathSection({ allow: [join(dir, "{git,npm}")] }, "/cwd");
      assert.equal(resolvePathAction(section, join(dir, "git")), "allow");
      assert.equal(resolvePathAction(section, join(dir, "npm")), "allow");
    }),
  );

  it('"*" 単体はすべてのパスを read 許可にする', () => {
    const section = expandPathSection({ allow: ["*"] }, "/cwd");
    assert.equal(resolvePathAction(section, "/etc/passwd"), "allow");
  });

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

describe("§3 動的拡張のライフサイクル", () => {
  const withDynamicSandbox =
    (configYaml: string, test: (dir: string, sandbox: Sandbox) => Promise<void> | void) =>
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "guardrails-dynamic-"));
      try {
        const configPath = join(dir, "config.yaml");
        writeFileSync(configPath, configYaml);
        await test(dir, new Sandbox(dir, configPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

  const confirmOnlyUi = { confirm: async () => true };
  const chooseDirectoryScopeUi = {
    confirm: async () => true,
    select: async (_title: string, scopeOptions: string[]) => scopeOptions[1],
  };

  it(
    "read の動的許可は write の許可にならない",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      const notePath = join(dir, "file.txt");
      const confirmedOperations: string[] = [];
      const context = {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async (title: string) => {
            confirmedOperations.push(title);
            return true;
          },
        },
      };
      await sandbox.authorizePath("read", notePath, context);
      await sandbox.authorizePath("write", notePath, context);
      assert.deepEqual(confirmedOperations, ["Allow read access?", "Allow write access?"]);
    }),
  );

  it(
    "write のファイルスコープ承認は存在しないファイルをフェンス外で作成する",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      const newFilePath = join(dir, "nested", "new.txt");
      await sandbox.authorizePath("write", newFilePath, {
        cwd: dir,
        hasUI: true,
        ui: confirmOnlyUi,
      });
      assert.equal(existsSync(newFilePath), true);
    }),
  );

  it(
    "write の動的許可パスは書き込み可能 bind になる",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      const filePath = join(dir, "new.txt");
      await sandbox.authorizePath("write", filePath, {
        cwd: dir,
        hasUI: true,
        ui: confirmOnlyUi,
      });
      const bindAt = sandbox.buildArgs("bash").indexOf(filePath);
      assert.deepEqual(sandbox.buildArgs("bash").slice(bindAt - 1, bindAt + 2), [
        "--bind-try",
        filePath,
        filePath,
      ]);
    }),
  );

  it(
    "write のディレクトリスコープ承認は親ディレクトリを作成しファイルは作らない",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      const newFilePath = join(dir, "made", "sub", "new.txt");
      await sandbox.authorizePath("write", newFilePath, {
        cwd: dir,
        hasUI: true,
        ui: chooseDirectoryScopeUi,
      });
      assert.equal(existsSync(join(dir, "made", "sub")), true);
      assert.equal(existsSync(newFilePath), false);
    }),
  );

  it(
    "ディレクトリスコープの動的許可は配下の別ファイルで再確認しない",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      let selectCount = 0;
      const context = {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async () => true,
          select: async (_title: string, scopeOptions: string[]) => {
            selectCount++;
            return scopeOptions[1];
          },
        },
      };
      await sandbox.authorizePath("write", join(dir, "pkg", "a.txt"), context);
      await sandbox.authorizePath("write", join(dir, "pkg", "b.txt"), context);
      assert.equal(selectCount, 1);
    }),
  );

  it(
    "write スコープ選択のキャンセルは拒否される",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      await assert.rejects(async () => {
        await sandbox.authorizePath("write", join(dir, "new.txt"), {
          cwd: dir,
          hasUI: true,
          ui: {
            confirm: async () => true,
            select: async () => undefined,
          },
        });
      }, /Access denied by user/);
    }),
  );

  it("明示 deny は動的許可のスコープ伝播より優先する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "guardrails-dynamic-deny-"));
    try {
      writeFileSync(join(dir, ".env"), "");
      const configPath = join(dir, "config.yaml");
      writeFileSync(configPath, `read: {}\nwrite:\n  deny: ["**/.env"]\n`);
      const sandbox = new Sandbox(dir, configPath);
      let selectCount = 0;
      const context = {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async () => true,
          select: async (_title: string, scopeOptions: string[]) => {
            selectCount++;
            return scopeOptions[1];
          },
        },
      };
      await sandbox.authorizePath("write", join(dir, "note.txt"), context);
      await assert.rejects(
        async () => sandbox.authorizePath("write", join(dir, ".env"), context),
        /Access denied/,
      );
      assert.equal(selectCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "read の動的許可はパスを作成しない",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      const missingPath = join(dir, "missing.txt");
      await sandbox.authorizePath("read", missingPath, {
        cwd: dir,
        hasUI: true,
        ui: confirmOnlyUi,
      });
      assert.equal(existsSync(missingPath), false);
    }),
  );
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

describe("§6.1 bind とパスの実在保証", () => {
  const withSandboxDir =
    (test: (dir: string, configPath: string) => Promise<void> | void) => async () => {
      const dir = mkdtempSync(join(tmpdir(), "guardrails-bind-"));
      try {
        const configPath = join(dir, "config.yaml");
        writeFileSync(configPath, "");
        await test(dir, configPath);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

  it(
    "write.allow の固定パスは起動時に作成される",
    withSandboxDir(async (dir, configPath) => {
      const targetDir = join(dir, "made", "dir");
      writeFileSync(configPath, `write:\n  allow: ["${targetDir}"]\n`);
      new Sandbox("/cwd", configPath);
      assert.equal(existsSync(targetDir), true);
    }),
  );

  it(
    "fs モードは deny ディレクトリを空ディレクトリで隠す",
    withSandboxDir((dir, configPath) => {
      const secretDir = join(dir, "secret-dir");
      mkdirSync(secretDir);
      writeFileSync(configPath, `read:\n  deny: ["${secretDir}"]\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      const tmpfsAt = args.indexOf(secretDir);
      assert.deepEqual(args.slice(tmpfsAt - 1, tmpfsAt + 1), ["--tmpfs", secretDir]);
    }),
  );

  it(
    "fs モードは deny ファイルを空ファイルで隠す",
    withSandboxDir((dir, configPath) => {
      const secretFile = join(dir, "secret.txt");
      writeFileSync(secretFile, "secret");
      writeFileSync(configPath, `read:\n  deny: ["${secretFile}"]\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      const maskAt = args.indexOf(secretFile);
      assert.deepEqual(args.slice(maskAt - 2, maskAt + 1), [
        "--ro-bind-try",
        "/dev/null",
        secretFile,
      ]);
    }),
  );

  it(
    "fs モードは credentials パスを空ファイルで隠す",
    withSandboxDir((dir, configPath) => {
      const credentialFile = join(dir, "cred.txt");
      writeFileSync(credentialFile, "token");
      writeFileSync(configPath, `credentials: ["${credentialFile}"]\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      const maskAt = args.indexOf(credentialFile);
      assert.deepEqual(args.slice(maskAt - 2, maskAt + 1), [
        "--ro-bind-try",
        "/dev/null",
        credentialFile,
      ]);
    }),
  );

  it(
    "bash モードは credentials パスを実体として read-only bind し隠蔽しない",
    withSandboxDir((dir, configPath) => {
      const credentialFile = join(dir, "cred.txt");
      writeFileSync(credentialFile, "token");
      writeFileSync(configPath, `credentials: ["${credentialFile}"]\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("bash");
      const bindAt = args.indexOf(credentialFile);
      assert.deepEqual(args.slice(bindAt - 1, bindAt + 1), ["--ro-bind-try", credentialFile]);
      assert.equal(args.includes("--tmpfs"), false);
      assert.equal(args.includes("/dev/null"), false);
    }),
  );

  it(
    'read.allow "*" はルート全体を read-only bind する',
    withSandboxDir((_dir, configPath) => {
      writeFileSync(configPath, `read:\n  allow: ["*"]\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      const rootBindAt = args.indexOf("/");
      assert.deepEqual(args.slice(rootBindAt - 1, rootBindAt + 2), ["--ro-bind", "/", "/"]);
    }),
  );
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

  it("grep のマッチ行を context 行と区別して数える", () => {
    const grepOutputWithOneMatch = ["a.txt-1- before", "a.txt:2: match", "a.txt-3- after"].join(
      "\n",
    );
    assert.equal(countMatchLines(grepOutputWithOneMatch), 1);
  });

  it("grep の No matches found は 0 matches と数える", () => {
    assert.equal(countMatchLines("No matches found"), 0);
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
    const classification = classifyReadPath({ path: "skills/my-skill/SKILL.md" }, "/workspace");
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
