import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import sandboxedToolsExtension, {
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
  parseSandboxedToolsConfig,
  resolveGitMainWorktreePath,
  resolveCommandAction,
  resolveCommandActionMatch,
  resolvePathAction,
  resolvePathActionMatch,
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
    const tempDir = mkdtempSync(join(tmpdir(), "sandboxed-tools-test-"));
    try {
      const configPath = join(tempDir, "config.yaml");
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

function stubMineruScript(mode: "generate" | "fail"): string {
  if (mode === "fail") {
    return '#!/bin/sh\necho "stub mineru failure" >&2\nexit 3\n';
  }
  return [
    "#!/bin/sh",
    "outdir=",
    "prev=",
    'for arg in "$@"; do',
    '  if [ "$prev" = "-o" ]; then outdir="$arg"; fi',
    '  prev="$arg"',
    "done",
    'mkdir -p "$outdir/out"',
    "printf '# stub ocr\\n\\nrecognized stub text\\n' > \"$outdir/out/doc.md\"",
    "",
  ].join("\n");
}

function withImageDirectory(
  mineruMode: "generate" | "fail" | "missing",
  test: (directory: string) => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const previousPath = process.env.PATH;
    let stubDirectory: string | undefined;
    if (mineruMode === "missing") {
      process.env.PATH = "/nonexistent-sandboxed-tools-mineru";
    } else {
      stubDirectory = mkdtempSync(join(tmpdir(), "sandboxed-tools-mineru-stub-"));
      writeFileSync(join(stubDirectory, "mineru"), stubMineruScript(mineruMode), {
        mode: 0o755,
      });
      process.env.PATH = `${stubDirectory}${delimiter}${previousPath}`;
    }
    try {
      await withTempDirectory(test)();
    } finally {
      if (stubDirectory) rmSync(stubDirectory, { recursive: true, force: true });
      process.env.PATH = previousPath;
    }
  };
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Expected ANSI-wrapped dialog highlight for a matched command span. */
const highlighted = (text: string): string => `\u001b[33m${text}\u001b[39m`;

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

const approvingUi = { confirm: async () => true };

// 拡張 factory を stub API で読み込み、registerTool されたツールを取り出す
const captureRegisteredTools = (): Map<string, any> => {
  const registered = new Map<string, any>();
  sandboxedToolsExtension({
    registerTool: (tool: any) => registered.set(tool.name, tool),
  } as any);
  return registered;
};

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderToolCall(toolName: string, args: Record<string, unknown>): string {
  const tool = captureRegisteredTools().get(toolName);
  return tool.renderCall(args, plainTheme).render(200).join("\n").trimEnd();
}

describe("§1 ツールごとの扱い", () => {
  it("全 built-in fs ツールを置き換える", () => {
    const toolNames = [...captureRegisteredTools().keys()].sort();
    assert.deepEqual(toolNames, ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  it("grep は cwd 自体を . で表示する", () => {
    const call = renderToolCall("grep", { pattern: "TODO", path: process.cwd() });
    assert.equal(call, "grep TODO in .");
  });

  it("find は cwd 自体を . で表示する", () => {
    const call = renderToolCall("find", { pattern: "*.ts", path: process.cwd() });
    assert.equal(call, "find *.ts in .");
  });

  it("ls は cwd 自体を . で表示する", () => {
    const call = renderToolCall("ls", { path: process.cwd() });
    assert.equal(call, "ls .");
  });
});

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
        assert.deepEqual(confirmedPaths, [
          "/workspace/project/file.txt\nmatched: /workspace/project",
        ]);
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
    "ask パスで No を選び理由を入力するとエラーメッセージに含まれる",
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
            ui: {
              confirm: async () => false,
              select: async (_title, options) => options[1],
              input: async () => "なぜこのパスが必要か説明して",
            },
          });
        }, /Access denied by user: \/workspace\/project\/file\.txt\nUser reason: なぜこのパスが必要か説明して$/);
      },
    ),
  );

  it(
    "ask パスで No を選び理由欄を空欄で確定すると理由なしで拒否される",
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
            ui: {
              confirm: async () => false,
              select: async (_title, options) => options[1],
              input: async () => "",
            },
          });
        }, /Access denied by user: \/workspace\/project\/file\.txt$/);
      },
    ),
  );

  it(
    "ask パスで Yes を選ぶと承認される",
    withSandbox(
      `
read:
  ask: [/workspace/project]
`,
      projectRoot,
      async (sandbox) => {
        const selectionOptions: string[][] = [];
        await sandbox.authorizePath("read", "/workspace/project/file.txt", {
          cwd: projectRoot,
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title, options) => {
              selectionOptions.push(options);
              return options[0];
            },
          },
        });
        assert.deepEqual(selectionOptions, [["Yes, allow", "No, deny (reason next)"]]);
      },
    ),
  );

  it(
    "ask パスの選択をキャンセルしたら理由入力のキャンセル後に理由なしで拒否される",
    withSandbox(
      `
read:
  ask: [/workspace/project]
`,
      projectRoot,
      async (sandbox) => {
        let inputCalled = false;
        await assert.rejects(async () => {
          await sandbox.authorizePath("read", "/workspace/project/file.txt", {
            cwd: projectRoot,
            hasUI: true,
            ui: {
              confirm: async () => false,
              select: async () => undefined,
              input: async () => {
                inputCalled = true;
                return undefined;
              },
            },
          });
        }, /Access denied by user: \/workspace\/project\/file\.txt$/);
        assert.equal(inputCalled, true);
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
    const homeNotePath = join(homedir(), "sandboxed-tools-edit-write-gate.txt");
    await assert.rejects(
      () =>
        editTool.execute("t", { path: homeNotePath, edits: [] }, undefined, undefined, {
          hasUI: false,
        }),
      /Access requires confirmation/,
    );
  });
});

describe("§2.1 画像ファイルの read", () => {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0IAAAAABJRU5ErkJggg==",
    "base64",
  );
  const stubMarkdown = "# stub ocr\n\nrecognized stub text\n";

  function cachePath(cacheRoot: string, imageBytes: Buffer): string {
    const imageHash = createHash("sha256").update(imageBytes).digest("hex");
    return join(cacheRoot, "pi", "sandboxed-tools", "ocr", "v1", `${imageHash}.md`);
  }

  async function withOcrCache(cacheRoot: string, test: () => Promise<void> | void): Promise<void> {
    const previousCacheRoot = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheRoot;
    try {
      await test();
    } finally {
      if (previousCacheRoot === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheRoot;
    }
  }

  it("read の説明文は画像の文字情報だけを返すことを示す", () => {
    const description = captureRegisteredTools().get("read").description;
    assert.match(description, /OCR or image analysis/);
    assert.match(description, /Layout, appearance, color/);
    assert.match(description, /never automatically attached as Vision input/);
  });

  it(
    "画像の read は新規抽出したテキストに照合依頼を添え、隠しキャッシュへ保存する",
    withImageDirectory("generate", async (directory) => {
      const cacheRoot = join(directory, "cache");
      const projectDirectory = join(directory, "project");
      await withOcrCache(cacheRoot, async () => {
        const imagePath = join(projectDirectory, "image.png");
        const ocrCachePath = cachePath(cacheRoot, pngBytes);
        mkdirSync(projectDirectory);
        writeFileSync(imagePath, pngBytes);

        const result = await captureRegisteredTools()
          .get("read")
          .execute("t", { path: imagePath }, undefined, undefined, { hasUI: false });

        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, "text");
        assert.ok(result.content[0].text.startsWith("このテキストはOCR抽出であり"));
        assert.match(result.content[0].text, /金額、日付、固有名詞、契約・法的文言/);
        assert.match(result.content[0].text, /原画像との照合をオーナーに依頼/);
        assert.ok(result.content[0].text.endsWith(stubMarkdown));
        assert.equal(result.details.generated, true);
        assert.equal(existsSync(`${imagePath}.ocr.md`), false);
        assert.equal(ocrCachePath.startsWith(`${projectDirectory}/`), false);
        assert.equal(existsSync(ocrCachePath), true);
      });
    }),
  );

  it(
    "プロジェクト配下のXDG_CACHE_HOMEは既定の隠しキャッシュへフォールバックする",
    withImageDirectory("generate", async (directory) => {
      const projectDirectory = join(directory, "project");
      const defaultCacheRoot = join(directory, "home", ".cache");
      const previousCwd = process.cwd();
      const previousHome = process.env.HOME;
      mkdirSync(projectDirectory);
      process.chdir(projectDirectory);
      process.env.HOME = join(directory, "home");
      try {
        await withOcrCache(join(projectDirectory, ".cache"), async () => {
          const imagePath = join(projectDirectory, "image.png");
          writeFileSync(imagePath, pngBytes);

          await captureRegisteredTools()
            .get("read")
            .execute("t", { path: imagePath }, undefined, undefined, { hasUI: false });

          assert.equal(existsSync(join(projectDirectory, ".cache")), false);
          assert.equal(existsSync(cachePath(defaultCacheRoot, pngBytes)), true);
        });
      } finally {
        process.chdir(previousCwd);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    }),
  );

  it(
    "画像の隣のXDG_CACHE_HOMEは既定の隠しキャッシュへフォールバックする",
    withImageDirectory("generate", async (directory) => {
      const imageDirectory = join(directory, "images");
      const projectDirectory = join(directory, "project");
      const defaultCacheRoot = join(directory, "home", ".cache");
      const previousCwd = process.cwd();
      const previousHome = process.env.HOME;
      mkdirSync(imageDirectory);
      mkdirSync(projectDirectory);
      process.chdir(projectDirectory);
      process.env.HOME = join(directory, "home");
      try {
        await withOcrCache(imageDirectory, async () => {
          const imagePath = join(imageDirectory, "image.png");
          writeFileSync(imagePath, pngBytes);

          await captureRegisteredTools()
            .get("read")
            .execute("t", { path: imagePath }, undefined, undefined, { hasUI: false });

          assert.equal(existsSync(join(imageDirectory, "pi")), false);
          assert.equal(existsSync(cachePath(defaultCacheRoot, pngBytes)), true);
        });
      } finally {
        process.chdir(previousCwd);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    }),
  );

  it(
    "画像の read はキャッシュしたテキストを注意書きなしで返す",
    withImageDirectory("fail", async (directory) => {
      await withOcrCache(join(directory, "cache"), async () => {
        const imageDirectory = join(directory, "images");
        const imagePath = join(imageDirectory, "image.png");
        const ocrCachePath = cachePath(join(directory, "cache"), pngBytes);
        mkdirSync(imageDirectory);
        writeFileSync(imagePath, pngBytes);
        mkdirSync(dirname(ocrCachePath), { recursive: true });
        writeFileSync(ocrCachePath, "cached ocr text");

        const result = await captureRegisteredTools()
          .get("read")
          .execute("t", { path: imagePath }, undefined, undefined, { hasUI: false });

        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, "text");
        assert.equal(result.content[0].text, "cached ocr text");
        assert.doesNotMatch(result.content[0].text, /このテキストはOCR抽出/);
        assert.equal(result.details.generated, false);
      });
    }),
  );

  it(
    "同一パスの画像内容が変わると新しいハッシュのキャッシュへ再抽出する",
    withImageDirectory("generate", async (directory) => {
      await withOcrCache(join(directory, "cache"), async () => {
        const imageDirectory = join(directory, "images");
        const imagePath = join(imageDirectory, "image.png");
        const changedPngBytes = Buffer.from(pngBytes);
        changedPngBytes[20] ^= 1;
        mkdirSync(imageDirectory);
        writeFileSync(imagePath, pngBytes);

        const readTool = captureRegisteredTools().get("read");
        const first = await readTool.execute("t", { path: imagePath }, undefined, undefined, {
          hasUI: false,
        });
        writeFileSync(imagePath, changedPngBytes);
        const second = await readTool.execute("t", { path: imagePath }, undefined, undefined, {
          hasUI: false,
        });

        assert.equal(first.details.generated, true);
        assert.equal(second.details.generated, true);
        assert.equal(existsSync(cachePath(join(directory, "cache"), pngBytes)), true);
        assert.equal(existsSync(cachePath(join(directory, "cache"), changedPngBytes)), true);
      });
    }),
  );

  it(
    "mineruが未導入のときはエラー",
    withImageDirectory("missing", async (directory) => {
      await withOcrCache(join(directory, "cache"), async () => {
        const imageDirectory = join(directory, "images");
        const imagePath = join(imageDirectory, "image.png");
        mkdirSync(imageDirectory);
        writeFileSync(imagePath, pngBytes);

        await assert.rejects(
          () =>
            captureRegisteredTools()
              .get("read")
              .execute("t", { path: imagePath }, undefined, undefined, { hasUI: false }),
          { message: "MinerU execution failed: mineru is not installed" },
        );
        assert.equal(existsSync(cachePath(join(directory, "cache"), pngBytes)), false);
      });
    }),
  );

  it(
    "mineruが失敗するときはエラー",
    withImageDirectory("fail", async (directory) => {
      await withOcrCache(join(directory, "cache"), async () => {
        const imageDirectory = join(directory, "images");
        const imagePath = join(imageDirectory, "image.png");
        mkdirSync(imageDirectory);
        writeFileSync(imagePath, pngBytes);

        await assert.rejects(
          () =>
            captureRegisteredTools()
              .get("read")
              .execute("t", { path: imagePath }, undefined, undefined, { hasUI: false }),
          /MinerU exited with status 3: stub mineru failure/,
        );
        assert.equal(existsSync(cachePath(join(directory, "cache"), pngBytes)), false);
      });
    }),
  );
});

describe("§2.2 credentials の例外", () => {
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

  it(
    "${GIT_MAIN_WORKTREE_PATH} は linked worktree から main worktree に解決する",
    withLinkedWorktree(async (mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const configPath = join(workspacePath, "config.yaml");
      writeFileSync(configPath, "write:\n  allow:\n    - ${GIT_MAIN_WORKTREE_PATH}/.git\n");
      const sandbox = new Sandbox(linkedWorktreePath, configPath);
      const mainGitDirectory = join(mainWorktreePath, ".git", "refs", "heads", "topic");

      assert.equal(resolveGitMainWorktreePath(linkedWorktreePath), mainWorktreePath);
      await sandbox.authorizePath("write", mainGitDirectory, { cwd: linkedWorktreePath });
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH} は Git repository 外ではパスを許可しない",
    withTempDirectory((directory) => {
      const section = expandPathSection({ allow: ["${GIT_MAIN_WORKTREE_PATH}/.git"] }, directory);

      assert.deepEqual(section.allow, []);
    }),
  );
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
    const section = expandPathSection({ allow: ["*"] }, "/cwd", true);
    assert.equal(resolvePathAction(section, "/etc/passwd"), "allow");
  });

  it(
    '"*" 単体は write の全パス許可にならない',
    withGlobDir((dir) => {
      const section = expandPathSection({ allow: ["*"] }, dir);
      assert.equal(resolvePathAction(section, "/etc/passwd"), "deny");
    }),
  );

  it(
    '"*" 単体は credentials の全パス制限にならない',
    withGlobDir((dir) => {
      writeFileSync(join(dir, "credential"), "secret");
      return withSandbox(
        `
read:
  allow: [/]
credentials: ["*"]
`,
        dir,
        async (sandbox) => {
          await sandbox.authorizePath("read", "/etc/passwd", { cwd: dir });
        },
      )();
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

  it(
    "セッション中に新規作成された read.deny glob一致パスを隠さない",
    withGlobDir((dir) =>
      withSandbox(
        `
read:
  deny: ["${join(dir, "*")}"]
`,
        dir,
        (sandbox) => {
          const latePath = join(dir, "latecomer");
          writeFileSync(latePath, "secret");
          assert.equal(sandbox.buildArgs("fs").includes(latePath), false);
        },
      )(),
    ),
  );

  it(
    "セッション中に新規作成された credentials glob一致パスを隠さない",
    withGlobDir((dir) =>
      withSandbox(
        `
credentials: ["${join(dir, "*")}"]
`,
        dir,
        (sandbox) => {
          const latePath = join(dir, "latecomer");
          writeFileSync(latePath, "secret");
          assert.equal(sandbox.buildArgs("fs").includes(latePath), false);
        },
      )(),
    ),
  );
});

describe("§3.c アクションの決定", () => {
  const projectRoot = "/workspace/project";

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

describe("§2.3 確認ダイアログの一致パターン表示", () => {
  it("コマンド ask は一致したパターンと一致範囲を返す", () => {
    const match = resolveCommandActionMatch(
      { allow: ["*"], ask: ["git push", "gh pr create"], deny: [] },
      "git push -u origin main",
    );
    assert.deepEqual(match, {
      action: "ask",
      matched: "git push",
      matchSpan: { candidate: "git push -u origin main", index: 0, length: 8 },
    });
  });

  it("ブレース展開後のパターンを返す", () => {
    const match = resolveCommandActionMatch(
      { allow: [], ask: ["{npm,pnpm} publish"], deny: [] },
      "npm publish",
    );
    assert.deepEqual(match, {
      action: "ask",
      matched: "npm publish",
      matchSpan: { candidate: "npm publish", index: 0, length: 11 },
    });
  });

  it("glob パターンはセグメント全体を一致範囲として返す", () => {
    const match = resolveCommandActionMatch({ allow: [], ask: ["git p*"], deny: [] }, "git push");
    assert.deepEqual(match, {
      action: "ask",
      matched: "git p*",
      matchSpan: { candidate: "git push", index: 0, length: 8 },
    });
  });

  it("複合コマンドは ask セグメントの一致パターンを返す", () => {
    const match = resolveCommandActionMatch(
      { allow: ["ls"], ask: ["git push"], deny: [] },
      "ls; git push -u origin main",
    );
    assert.deepEqual(match, {
      action: "ask",
      matched: "git push",
      matchSpan: { candidate: "git push -u origin main", index: 0, length: 8 },
    });
  });

  it("deny が優先されるとき deny の一致パターンを返す", () => {
    const match = resolveCommandActionMatch(
      { allow: ["*"], ask: ["git push"], deny: ["sudo"] },
      "sudo git push",
    );
    assert.deepEqual(match, {
      action: "deny",
      matched: "sudo",
      matchSpan: { candidate: "sudo git push", index: 0, length: 4 },
    });
  });

  it("どのパターンにも一致しないコマンドは matched なしの deny", () => {
    const match = resolveCommandActionMatch({ allow: ["git status"] }, "git push");
    assert.deepEqual(match, { action: "deny" });
  });

  it("パス ask は展開後の一致パスを返す", () => {
    const section = expandPathSection({ allow: ["."], ask: ["/opt/data"] }, "/workspace/project");
    const match = resolvePathActionMatch(section, "/opt/data/file.txt");
    assert.deepEqual(match, { action: "ask", matched: "/opt/data" });
  });

  it("設定に一致しないパスは matched なしの deny", () => {
    const section = expandPathSection({ allow: ["."] }, "/workspace/project");
    const match = resolvePathActionMatch(section, "/tmp/file.txt");
    assert.deepEqual(match, { action: "deny" });
  });

  it(
    "コマンド確認ダイアログのタイトルに一致パターンを表示する",
    withSandbox(
      `
commands:
  allow: ["*"]
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        let title = "";
        await sandbox.authorizeCommand("git push -u origin main", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => true,
            select: async (dialogTitle) => {
              title = dialogTitle;
              return "Yes, allow";
            },
          },
        });
        assert.ok(title.includes("matched: git push"), title);
        assert.ok(title.includes(highlighted("git push")), title);
      },
    ),
  );

  it(
    "コマンド確認ダイアログは先頭の VAR= を読み飛ばした位置を強調する",
    withSandbox(
      `
commands:
  allow: ["*"]
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        let title = "";
        await sandbox.authorizeCommand("FOO=1 git push origin main", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => true,
            select: async (dialogTitle) => {
              title = dialogTitle;
              return "Yes, allow";
            },
          },
        });
        assert.ok(title.includes(`FOO=1 ${highlighted("git push")} origin main`), title);
      },
    ),
  );

  it(
    "コマンド確認ダイアログは語境界にない部分一致を飛ばして次の出現を強調する",
    withSandbox(
      `
commands:
  allow: ["*"]
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        let title = "";
        await sandbox.authorizeCommand("echo mygit pushx; git push", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => true,
            select: async (dialogTitle) => {
              title = dialogTitle;
              return "Yes, allow";
            },
          },
        });
        assert.ok(title.includes(`echo mygit pushx; ${highlighted("git push")}`), title);
      },
    ),
  );

  it(
    "一致範囲がコマンド文字列で見つからないときは強調しない",
    withSandbox(
      `
commands:
  allow: ["*"]
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        let title = "";
        await sandbox.authorizeCommand('git "push" origin main', {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => true,
            select: async (dialogTitle) => {
              title = dialogTitle;
              return "Yes, allow";
            },
          },
        });
        assert.ok(title.includes('git "push" origin main'), title);
        assert.ok(!title.includes("\u001b[33m"), title);
      },
    ),
  );

  it(
    "NO_COLOR が設定されているときは強調しない",
    withSandbox(
      `
commands:
  allow: ["*"]
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        const previousNoColor = process.env.NO_COLOR;
        process.env.NO_COLOR = "1";
        let title = "";
        try {
          await sandbox.authorizeCommand("git push origin main", {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => true,
              select: async (dialogTitle) => {
                title = dialogTitle;
                return "Yes, allow";
              },
            },
          });
        } finally {
          if (previousNoColor === undefined) delete process.env.NO_COLOR;
          else process.env.NO_COLOR = previousNoColor;
        }
        assert.ok(title.includes("git push origin main"), title);
        assert.ok(!title.includes("\u001b[33m"), title);
      },
    ),
  );

  it(
    "ask パスの確認ダイアログは一致パターンを表示する",
    withSandbox(
      `
read:
  ask: [~/sandboxed-tools-ask-dir]
`,
      "/cwd",
      async (sandbox) => {
        let title = "";
        await sandbox.authorizePath(
          "read",
          join(homedir(), "sandboxed-tools-ask-dir", "file.txt"),
          {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => true,
              select: async (dialogTitle) => {
                title = dialogTitle;
                return "Yes, allow";
              },
            },
          },
        );
        assert.ok(title.includes(`matched: ${join(homedir(), "sandboxed-tools-ask-dir")}`), title);
      },
    ),
  );

  it(
    "未設定パスの許可要求ダイアログは一致パターンなしを表示する",
    withSandbox("read: {}\nwrite: {}\n", "/cwd", async (sandbox) => {
      let title = "";
      await sandbox.authorizePath("read", "/tmp/sandboxed-tools-unmatched.txt", {
        cwd: "/cwd",
        hasUI: true,
        ui: {
          confirm: async () => true,
          select: async (dialogTitle) => {
            title = dialogTitle;
            return "Yes, allow";
          },
        },
      });
      assert.ok(title.includes("no matching pattern (default ask)"), title);
    }),
  );
});

describe("§3 動的拡張のライフサイクル", () => {
  const withDynamicSandbox =
    (configYaml: string, test: (dir: string, sandbox: Sandbox) => Promise<void> | void) =>
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-dynamic-"));
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
    "write で File only を選ぶと存在しないファイルをフェンス外で作成する",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      const newFilePath = join(dir, "nested", "new.txt");
      await sandbox.authorizePath("write", newFilePath, {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async () => false,
          select: async (_title, options) => options[0],
        },
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

  it(
    "write で No を選び理由を入力するとエラーメッセージに含まれる",
    withDynamicSandbox("read: {}\nwrite: {}\n", async (dir, sandbox) => {
      const newFilePath = join(dir, "new.txt");
      const selectionOptions: string[][] = [];
      await assert.rejects(
        () =>
          sandbox.authorizePath("write", newFilePath, {
            cwd: dir,
            hasUI: true,
            ui: {
              confirm: async () => false,
              select: async (_title, options) => {
                selectionOptions.push(options);
                return options[2];
              },
              input: async () => "スコープをファイル単体にして",
            },
          }),
        (error: Error) =>
          error.message ===
          `Access denied by user: ${newFilePath}\nUser reason: スコープをファイル単体にして`,
      );
      assert.deepEqual(selectionOptions, [
        ["File only", "Directory (subtree)", "No, deny (reason next)"],
      ]);
    }),
  );

  it("明示 deny は動的許可のスコープ伝播より優先する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-dynamic-deny-"));
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
        assert.deepEqual(confirmedCommands, [
          `${highlighted("git push")} origin main\nmatched: git push`,
        ]);
      },
    ),
  );

  it(
    "ask コマンドで Yes を選ぶと承認される",
    withSandbox(
      `
commands:
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        const selectionOptions: string[][] = [];
        await sandbox.authorizeCommand("git push origin main", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title: string, options: string[]) => {
              selectionOptions.push(options);
              return options[0];
            },
          },
        });
        assert.deepEqual(selectionOptions, [["Yes, allow", "No, deny (reason next)"]]);
      },
    ),
  );

  it(
    "ask コマンドで No を選び理由を入力するとエラーメッセージに含まれる",
    withSandbox(
      `
commands:
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("git push origin main", {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => false,
              select: async (_title, options) => options[1],
              input: async () => "force push は禁止",
            },
          });
        }, /Command denied by user: git push origin main\nUser reason: force push は禁止$/);
      },
    ),
  );

  it(
    "ask コマンドの選択をキャンセルしたら理由入力のキャンセル後に理由なしで拒否される",
    withSandbox(
      `
commands:
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        let inputCalled = false;
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("git push origin main", {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => false,
              select: async () => undefined,
              input: async () => {
                inputCalled = true;
                return undefined;
              },
            },
          });
        }, /Command denied by user: git push origin main$/);
        assert.equal(inputCalled, true);
      },
    ),
  );

  it(
    "select 非対応 UI のコマンド拒否で入力した理由はエラーメッセージに含まれる",
    withSandbox(
      `
commands:
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("git push origin main", {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => false,
              input: async () => "公開は承認後にして",
            },
          });
        }, /Command denied by user: git push origin main\nUser reason: 公開は承認後にして$/);
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

  it("複合コマンド内の最も厳しいアクションを適用する", () => {
    const section = { allow: ["*"], ask: ["git push", "gh pr create"], deny: ["sudo"] };
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
    const section = { allow: ["*"], ask: ["gh pr create"] };
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
    const section = { allow: ["*"], ask: ["git push", "gh pr create"] };
    assert.equal(
      resolveCommandAction(section, "GH_PAGER=cat gh pr create --repo owner/repo"),
      "ask",
    );
    assert.equal(resolveCommandAction(section, "env git push -u origin main"), "ask");
  });

  it("空コマンドでも既存の allow wildcard の扱いを維持する", () => {
    assert.equal(resolveCommandAction({ allow: ["*"] }, ""), "allow");
  });

  it(
    "未設定コマンドはブロックされる",
    withSandbox(``, "/cwd", async (sandbox) => {
      await assert.rejects(async () => {
        await sandbox.authorizeCommand("rm -rf /", { cwd: "/cwd" });
      }, /Command denied/);
    }),
  );
});

describe("§2・§4 確認の直列化", () => {
  const withDialogSandbox =
    (test: (dir: string, sandbox: Sandbox) => Promise<void> | void) => async () => {
      const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-dialog-"));
      try {
        const configPath = join(dir, "config.yaml");
        writeFileSync(configPath, "read: {}\nwrite: {}\n");
        await test(dir, new Sandbox(dir, configPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

  const countOverlappingConfirmsUi = () => {
    let activeDialogCount = 0;
    let maxActiveDialogCount = 0;
    return {
      ui: {
        confirm: async () => {
          activeDialogCount++;
          maxActiveDialogCount = Math.max(maxActiveDialogCount, activeDialogCount);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeDialogCount--;
          return true;
        },
      },
      maxOverlappingDialogs: () => maxActiveDialogCount,
    };
  };

  it(
    "並行する2つのパス確認は一度に1つだけ表示する",
    withDialogSandbox(async (dir, sandbox) => {
      const { ui, maxOverlappingDialogs } = countOverlappingConfirmsUi();
      await Promise.all([
        sandbox.authorizePath("read", join(dir, "a.txt"), { cwd: dir, hasUI: true, ui }),
        sandbox.authorizePath("read", join(dir, "b.txt"), { cwd: dir, hasUI: true, ui }),
      ]);
      assert.equal(maxOverlappingDialogs(), 1);
    }),
  );

  it(
    "並行する同じパスへの確認は1回で済む",
    withDialogSandbox(async (dir, sandbox) => {
      let confirmCount = 0;
      const context = {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async () => {
            confirmCount++;
            return true;
          },
        },
      };
      await Promise.all([
        sandbox.authorizePath("read", join(dir, "same.txt"), context),
        sandbox.authorizePath("read", join(dir, "same.txt"), context),
      ]);
      assert.equal(confirmCount, 1);
    }),
  );

  it(
    "並行する2つのコマンド確認は一度に1つだけ表示する",
    withSandbox(
      `
commands:
  ask: [git push]
`,
      "/cwd",
      async (sandbox) => {
        const { ui, maxOverlappingDialogs } = countOverlappingConfirmsUi();
        await Promise.all([
          sandbox.authorizeCommand("git push origin main", { cwd: "/cwd", hasUI: true, ui }),
          sandbox.authorizeCommand("git push origin topic", { cwd: "/cwd", hasUI: true, ui }),
        ]);
        assert.equal(maxOverlappingDialogs(), 1);
      },
    ),
  );
});

describe("§6 設定", () => {
  it("全セクションを読み込む", () => {
    const config = parseSandboxedToolsConfig(`
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
      const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-bind-"));
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
  it("main agent の fs ツールは作業ディレクトリ内外でパスを表示し分ける", () => {
    const workspacePath = join(process.cwd(), "src", "a.ts");
    const parentPath = resolve(process.cwd(), "..", "README.md");
    const renderedCalls = [
      renderToolCall("read", { path: workspacePath }),
      renderToolCall("write", { path: parentPath, content: "" }),
      renderToolCall("edit", { path: workspacePath, edits: [] }),
    ];
    const displayedParentPath = parentPath.startsWith(`${homedir()}/`)
      ? `~${parentPath.slice(homedir().length)}`
      : parentPath;
    assert.deepEqual(renderedCalls, [
      "read ./src/a.ts",
      `write ${displayedParentPath}`,
      "edit ./src/a.ts",
    ]);
  });

  it("all built-in tool errors show only the first three lines", () => {
    const errorResult = {
      content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
    };
    const expectedError = "line 1\nline 2\nline 3\n…";

    for (const toolName of ["bash", "edit", "find", "grep", "ls", "read", "write"]) {
      const tool = captureRegisteredTools().get(toolName);
      const renderedError = tool
        .renderResult(errorResult, { isPartial: false }, plainTheme, {
          isError: true,
          args: {},
        })
        .render(200)
        .map((line: string) => line.trimEnd())
        .join("\n");
      assert.equal(renderedError, expectedError);
    }
  });

  it("errors with exactly three lines do not show an ellipsis", () => {
    const errorResult = {
      content: [{ type: "text", text: "line 1\nline 2\nline 3\n" }],
    };

    const tool = captureRegisteredTools().get("read");
    const renderedError = tool
      .renderResult(errorResult, { isPartial: false }, plainTheme, {
        isError: true,
        args: {},
      })
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");
    assert.equal(renderedError, "line 1\nline 2\nline 3");
  });

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
