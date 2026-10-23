import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import sandboxedToolsExtension, {
  ASK_PERMISSION_TARGET_PREVIEW_LIMIT,
  COMMAND_PREVIEW_LIMIT,
  classifyReadPath,
  countMatchLines,
  countResultLines,
  formatDuration,
  formatSize,
  isVisionImageFile,
  truncateText,
  writeApprovalNote,
} from "./index";
import {
  Sandbox,
  compileCommandRuleEntries,
  defaultSandboxConfigPath,
  expandPathSection,
  parseSandboxedToolsConfig,
  resolveCommandAction,
  resolveCommandActionMatch,
  resolveGitMainWorktreePath,
  resolvePathAction,
  resolvePathActionMatch,
  splitCommandSegments,
  isWslEnvironment,
  sanitizeSandboxEnvironment,
} from "./sandbox";
import { startStderrTeeReceiver } from "./run-tools";

function sourcePathFromSymlink(symlinkPath: URL): URL {
  const target = readFileSync(symlinkPath, "utf8").trim();
  const deployedPath = new URL(target, symlinkPath);
  return new URL(deployedPath.href.replace("/config/", "/config.exact/"));
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

function withTempDirectory(
  test: (directory: string) => Promise<void> | void,
): () => Promise<void> {
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

/** Dialog accent color stub matching the highlight terminator below. */
const ACCENT_START = "\u001b[34m";

/** Expected ANSI-wrapped dialog highlight (inverted region) for a matched command span. */
const highlighted = (text: string): string =>
  `\u001b[7m\u001b[33m${text}\u001b[27m${ACCENT_START}`;

/** Any highlight SGR: the dialog must contain none of these when highlighting is off. */
const HIGHLIGHT_ANSI = ["\u001b[7m", "\u001b[33m"];

/** UI theme stub exposing the dialog accent color. */
const uiTheme = { getFgAnsi: () => ACCENT_START };

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

/** Compile string-pattern command entries to the regex form used at runtime (§6). */
const compiled = (
  entries: {
    action: "allow" | "ask" | "deny" | "ask_with_reason";
    pattern: string;
    args: string[];
  }[],
) => compileCommandRuleEntries(entries).entries;

// 拡張 factory を stub API で読み込み、registerTool されたツールを取り出す
function captureRegisteredTools(
  configPath?: string,
  handlers?: Map<string, (event: any, context?: any) => unknown>,
): Map<string, any> {
  const registered = new Map<string, any>();
  sandboxedToolsExtension(
    {
      registerTool: (tool: any) => registered.set(tool.name, tool),
      on: (event: string, handler: (event: any, context?: any) => unknown) =>
        handlers?.set(event, handler),
    } as any,
    configPath,
  );
  return registered;
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/**
 * Load the extension factory with a config file and run its session_start
 * handler, recording the UI notifications it issues (§6 startup warning).
 */
const runSessionStart = (configYaml: string): { message: string; level: string }[] => {
  const tempDir = mkdtempSync(join(tmpdir(), "sandboxed-tools-test-"));
  try {
    const configPath = join(tempDir, "config.yaml");
    writeFileSync(configPath, configYaml);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    sandboxedToolsExtension(
      {
        registerTool: () => {},
        on: (event: string, handler: (event: unknown, ctx: unknown) => void) =>
          handlers.set(event, handler),
      } as any,
      configPath,
    );
    const notifications: { message: string; level: string }[] = [];
    handlers.get("session_start")?.(
      {},
      {
        ui: {
          notify: (message: string, level: string) => notifications.push({ message, level }),
        },
      },
    );
    return notifications;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

function renderToolCall(toolName: string, args: Record<string, unknown>): string {
  const tool = captureRegisteredTools().get(toolName);
  return tool.renderCall(args, plainTheme).render(200).join("\n").trimEnd();
}

describe("§1 ツールごとの扱い", () => {
  it("全 built-in fs ツールを置き換える", () => {
    const toolNames = [...captureRegisteredTools().keys()].sort();
    assert.deepEqual(toolNames, [
      "ask_permission",
      "bash",
      "codemode",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
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
  - {allow: [/workspace/project]}
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
  - {ask: [/workspace/project]}
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
read: []
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
  - {ask: [/workspace/project]}
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
  - {ask: [/workspace/project]}
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
  - {ask: [/workspace/project]}
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
  - {ask: [/workspace/project]}
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
  - {ask: [/workspace/project]}
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
  - {allow: [/workspace/project]}
  - {deny: [/workspace/project/secret]}
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

  it(
    "read deny の glob パターンはセッション中に作成されたパスも拒否する",
    withSandbox(
      `
read:
  - {allow: "*"}
  - {deny: ["**/.env"]}
`,
      projectRoot,
      async (sandbox) => {
        await assert.rejects(
          () =>
            sandbox.authorizePath("read", `${projectRoot}/.env`, {
              cwd: projectRoot,
            }),
          /Access denied/,
        );
        await sandbox.authorizePath("read", `${projectRoot}/notes.txt`, {
          cwd: projectRoot,
        });
      },
    ),
  );

  it(
    "read deny の glob パターンでも後勝ちの allow が優先される",
    withSandbox(
      `
read:
  - {deny: ["**/.env"]}
  - {allow: [/workspace/project/.env]}
`,
      projectRoot,
      async (sandbox) => {
        await sandbox.authorizePath("read", `${projectRoot}/.env`, {
          cwd: projectRoot,
        });
      },
    ),
  );
});

describe("§2.1 画像ファイル", () => {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0IAAAAABJRU5ErkJggg==",
    "base64",
  );

  function writeImage(directory: string): string {
    mkdirSync(directory, { recursive: true });
    const imagePath = join(directory, "image.png");
    writeFileSync(imagePath, pngBytes);
    return imagePath;
  }

  it("read の説明文は画像の Vision 入力と非対応時の vision 委譲を示す", () => {
    const description = captureRegisteredTools().get("read").description;
    assert.match(description, /Image files are returned as Vision input/);
    assert.match(description, /delegation to the vision agent/);
  });

  it("isVisionImageFile excludes SVG and falls back to the extension when MIME detection fails", () => {
    assert.equal(isVisionImageFile("/tmp/icon.svg", "image/svg+xml"), false);
    assert.equal(isVisionImageFile("/tmp/photo.png", null), true);
    assert.equal(isVisionImageFile("/tmp/photo.PNG", null), true);
    assert.equal(isVisionImageFile("/tmp/photo.webp", null), true);
    assert.equal(isVisionImageFile("/tmp/notes.txt", null), false);
    assert.equal(isVisionImageFile("/tmp/noext", null), false);
    assert.equal(isVisionImageFile("/tmp/photo.png", "image/png"), true);
    assert.equal(isVisionImageFile("/tmp/photo.png", "text/plain"), false);
    assert.equal(isVisionImageFile("/tmp/notes.txt", "image/jpeg"), true);
  });

  it(
    "read returns SVG as text for an image-capable model",
    withTempDirectory(async (directory) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
      const svgPath = join(directory, "icon.svg");
      writeFileSync(svgPath, svg);
      const originalRunTool = Sandbox.prototype.runTool;
      let didRunRead = false;
      Sandbox.prototype.runTool = (async (toolName) => {
        didRunRead = toolName === "read";
        return { content: [{ type: "text", text: svg }], details: {} };
      }) as Sandbox["runTool"];

      try {
        const result = await captureRegisteredTools()
          .get("read")
          .execute("t", { path: svgPath }, undefined, undefined, {
            hasUI: false,
            model: { provider: "zai", id: "glm-5.3-flash", input: ["text", "image"] },
          });

        assert.equal(didRunRead, true);
        assert.equal(result.content[0]?.type, "text");
        assert.equal(result.content[0]?.text, svg);
        assert.equal(
          result.content.some((part: { type: string }) => part.type === "image"),
          false,
        );
      } finally {
        Sandbox.prototype.runTool = originalRunTool;
      }
    }),
  );

  it(
    "許可されない画像パスへの read は §2 どおり拒否する",
    withTempDirectory(async () => {
      const readTool = captureRegisteredTools().get("read");
      await assert.rejects(
        () =>
          readTool.execute(
            "t",
            { path: join(homedir(), ".pi/agent/auth.json") },
            undefined,
            undefined,
            { hasUI: false },
          ),
        /Access denied/,
      );
    }),
  );

  it(
    "画像入力対応モデルの read も許可されないパスは §2 どおり拒否する",
    withTempDirectory(async () => {
      const readTool = captureRegisteredTools().get("read");
      await assert.rejects(
        () =>
          readTool.execute(
            "t",
            { path: join(homedir(), ".pi/agent/auth.json") },
            undefined,
            undefined,
            {
              hasUI: false,
              model: { provider: "zai", id: "glm-5.3-flash", input: ["text", "image"] },
            },
          ),
        /Access denied/,
      );
    }),
  );

  it(
    "画像入力対応モデルの read は許可済み画像を Vision 入力として返す",
    withTempDirectory(async (directory) => {
      const imagePath = writeImage(join(directory, "images"));

      const result = await captureRegisteredTools()
        .get("read")
        .execute("t", { path: imagePath }, undefined, undefined, {
          hasUI: false,
          model: { provider: "zai", id: "glm-5.3-flash", input: ["text", "image"] },
        });

      assert.equal(result.isError, undefined);
      const imagePart = result.content.find((part: { type: string }) => part.type === "image");
      assert.ok(imagePart);
      assert.equal(imagePart.mimeType, "image/png");
      assert.equal(Buffer.from(imagePart.data, "base64").equals(pngBytes), true);
    }),
  );

  it(
    "画像入力対応モデルの read は offset・limit が指定されても画像をそのまま返す",
    withTempDirectory(async (directory) => {
      const imagePath = writeImage(join(directory, "images"));

      const result = await captureRegisteredTools()
        .get("read")
        .execute("t", { path: imagePath, offset: 1, limit: 2 }, undefined, undefined, {
          hasUI: false,
          model: { provider: "zai", id: "glm-5.3-flash", input: ["text", "image"] },
        });

      assert.equal(result.isError, undefined);
      const imagePart = result.content.find((part: { type: string }) => part.type === "image");
      assert.ok(imagePart);
      assert.equal(Buffer.from(imagePart.data, "base64").equals(pngBytes), true);
    }),
  );

  it(
    "画像入力非対応モデルの read は Vision 入力を作らず vision 委譲を促すエラーを返す",
    withTempDirectory(async (directory) => {
      const imagePath = writeImage(join(directory, "images"));

      const result = await captureRegisteredTools()
        .get("read")
        .execute("t", { path: imagePath }, undefined, undefined, {
          hasUI: false,
          model: { provider: "zai", id: "glm-5.3", input: ["text"] },
        });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /does not support image input/);
      assert.match(result.content[0].text, /zai\/glm-5\.3/);
      assert.match(result.content[0].text, /vision agent/);
      assert.equal(
        Array.isArray(result.content) &&
          result.content.some((part: { type: string }) => part.type === "image"),
        false,
      );
    }),
  );

  it(
    "モデル情報がない context の画像 read も委譲を促すエラーを返す",
    withTempDirectory(async (directory) => {
      const imagePath = writeImage(join(directory, "images"));

      const result = await captureRegisteredTools()
        .get("read")
        .execute("t", { path: imagePath }, undefined, undefined, { hasUI: false });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /does not support image input/);
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
  - {allow: [/workspace/project]}
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
    "${GIT_MAIN_WORKTREE_PATH} は linked worktree を cwd にしても main worktree への書き込みを許可する",
    withLinkedWorktree(async (mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const configPath = join(workspacePath, "config.yaml");
      writeFileSync(configPath, 'write:\n  - {allow: "${GIT_MAIN_WORKTREE_PATH}/.git"}\n');
      const sandbox = new Sandbox(linkedWorktreePath, configPath);
      const mainGitDirectory = join(mainWorktreePath, ".git", "refs", "heads", "topic");

      await sandbox.authorizePath("write", mainGitDirectory, { cwd: linkedWorktreePath });
    }),
  );

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
    "${GIT_MAIN_WORKTREE_PATH} は Git repository 外ではセッション開始cwd へ解決する",
    withTempDirectory((directory) => {
      const section = expandPathSection(
        [{ action: "allow", patterns: ["${GIT_MAIN_WORKTREE_PATH}"] }],
        directory,
      );

      assert.deepEqual(
        section.flatMap((entry) => entry.paths),
        [directory],
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

  it("resolves ${PROJECT_NAME} as plain text through the generic brace rules", () => {
    const section = expandPathSection(
      [{ action: "allow", patterns: ["/work/${PROJECT_NAME}/drafts"] }],
      "/cwd",
    );

    assert.deepEqual(
      section.flatMap((entry) => entry.paths),
      ["/work/$PROJECT_NAME/drafts"],
    );
  });

  it("shipped config uses REPOSITORY_NAME for work and worktrees paths", () => {
    const config = parseSandboxedToolsConfig(
      readFileSync(
        sourcePathFromSymlink(
          new URL("../../config.exact/sandbox.yaml.symlink", import.meta.url),
        ),
        "utf8",
      ),
    );
    const writeAllowPatterns = config.write
      ?.filter((entry) => entry.action === "allow")
      .flatMap((entry) => entry.patterns);

    assert.equal(writeAllowPatterns?.includes("~/.agents/worktrees/${REPOSITORY_NAME}"), true);
    assert.equal(writeAllowPatterns?.includes("~/.agents/work/${REPOSITORY_NAME}"), true);
    assert.equal(writeAllowPatterns?.includes("~/.agents/worktrees/${PROJECT_NAME}"), false);
    assert.equal(writeAllowPatterns?.includes("~/.agents/work/${PROJECT_NAME}"), false);
  });

  it("allows writes to the Lazyweb token directory", () => {
    const config = parseSandboxedToolsConfig(
      readFileSync(
        sourcePathFromSymlink(
          new URL("../../config.exact/sandbox.yaml.symlink", import.meta.url),
        ),
        "utf8",
      ),
    );
    const writeSection = expandPathSection(config.write, process.cwd());

    assert.equal(
      resolvePathAction(writeSection, join(homedir(), ".lazyweb", "lazyweb_mcp_token")),
      "allow",
    );
  });

  it("出荷configは/mntを含むコマンドだけをaskにする", () => {
    const config = parseSandboxedToolsConfig(
      readFileSync(
        sourcePathFromSymlink(
          new URL("../../config.exact/sandbox.yaml.symlink", import.meta.url),
        ),
        "utf8",
      ),
    );
    const readSection = expandPathSection(config.read, process.cwd(), true);
    const writeSection = expandPathSection(config.write, process.cwd());
    const commandEntries = compileCommandRuleEntries(config.commands).entries;

    assert.equal(resolvePathAction(readSection, "/mnt/c/Users/me/file.txt"), "allow");
    assert.equal(resolvePathAction(writeSection, "/mnt/c/Users/me/file.txt"), "ask");
    for (const command of ["/mnt/c/Windows/System32/CMD.EXE /c echo ok"]) {
      assert.equal(resolveCommandAction(commandEntries, command), "ask", command);
    }
    assert.equal(
      resolveCommandAction(commandEntries, "PowerShell.EXE -NoProfile -Command Get-Date"),
      "allow",
    );
    assert.equal(resolveCommandAction(commandEntries, "printf '%s\\n' ok"), "allow");
  });

  it("展開後は config ディレクトリの sandbox.yaml を既定設定にする", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "sandboxed-tools-default-config-"));
    try {
      const configPath = join(agentDir, "config", "sandbox.yaml");
      mkdirSync(join(agentDir, "config"));
      writeFileSync(configPath, "");
      assert.equal(defaultSandboxConfigPath(agentDir), configPath);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("既定Sandboxは集約された設定を読み込み自身の設定書き込みを拒否する", async () => {
    const sandbox = new Sandbox(process.cwd());
    const context = { cwd: process.cwd() };

    await assert.doesNotReject(() =>
      sandbox.authorizePath("write", join(tmpdir(), "sandboxed-tools-config-probe"), context),
    );
    await assert.rejects(
      () =>
        sandbox.authorizePath(
          "write",
          join(homedir(), ".pi/agent/config/sandbox.yaml"),
          context,
        ),
      /Access denied|Access requires confirmation/,
    );
  });

  it(
    "${GIT_MAIN_WORKTREE_PATH} は Git repository 外で開始cwd へ解決して書き込みを許可し bind する",
    withTempDirectory(async (directory) => {
      const configPath = join(directory, "config.yaml");
      writeFileSync(configPath, 'write:\n  - {allow: "${GIT_MAIN_WORKTREE_PATH}"}\n');
      const sandbox = new Sandbox(directory, configPath);

      await sandbox.authorizePath("write", join(directory, "note.md"), { cwd: directory });
      const args = sandbox.buildArgs("fs");
      const bindTryIndex = args.indexOf("--bind-try");
      assert.notEqual(bindTryIndex, -1);
      assert.equal(args[bindTryIndex + 1], directory);
    }),
  );

  it(
    "${REPOSITORY_NAME} を含むパスは current repository の worktrees を作成して bind する",
    withLinkedWorktree((mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const configPath = join(workspacePath, "config.yaml");
      const currentWorktreesDirectory = join(
        workspacePath,
        "worktrees",
        basename(mainWorktreePath),
      );
      const otherWorktreesDirectory = join(workspacePath, "worktrees", "other");
      mkdirSync(otherWorktreesDirectory, { recursive: true });
      writeFileSync(
        configPath,
        `write:\n  - {allow: "${workspacePath}/worktrees/\${REPOSITORY_NAME}"}\n`,
      );
      const sandbox = new Sandbox(linkedWorktreePath, configPath);

      assert.equal(existsSync(currentWorktreesDirectory), true);
      assert.equal(sandbox.buildArgs("fs").includes(currentWorktreesDirectory), true);
      assert.equal(sandbox.buildArgs("fs").includes(otherWorktreesDirectory), false);
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH}-worktrees は他リポジトリの worktree 置き場を許可しない",
    withLinkedWorktree(async (mainWorktreePath, _linkedWorktreePath, workspacePath) => {
      const otherRepoPath = join(workspacePath, "other");
      runGit(workspacePath, ["init", otherRepoPath]);
      try {
        const section = expandPathSection(
          [{ action: "allow", patterns: ["${GIT_MAIN_WORKTREE_PATH}-worktrees"] }],
          mainWorktreePath,
        );

        assert.deepEqual(
          section.flatMap((entry) => entry.paths),
          [join(workspacePath, "main-worktrees")],
        );
      } finally {
        rmSync(otherRepoPath, { recursive: true, force: true });
      }
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH}-worktrees を含むエントリは起動時に作成する",
    withLinkedWorktree((mainWorktreePath, _linkedWorktreePath, workspacePath) => {
      const configPath = join(workspacePath, "config.yaml");
      writeFileSync(configPath, 'write:\n  - {allow: "${GIT_MAIN_WORKTREE_PATH}-worktrees"}\n');
      new Sandbox(mainWorktreePath, configPath);

      assert.equal(existsSync(join(workspacePath, "main-worktrees")), true);
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH}-worktrees を含むエントリは Git repository 外でも作成する",
    withTempDirectory((directory) => {
      const configPath = join(directory, "config.yaml");
      writeFileSync(configPath, 'write:\n  - {allow: "${GIT_MAIN_WORKTREE_PATH}-worktrees"}\n');
      new Sandbox(directory, configPath);

      assert.equal(existsSync(`${directory}-worktrees`), true);
    }),
  );

  it(
    "${GIT_MAIN_WORKTREE_PATH}-worktrees は worktree の作成先への書き込みを許可し bind に含める",
    withLinkedWorktree(async (mainWorktreePath, _linkedWorktreePath, workspacePath) => {
      const configPath = join(workspacePath, "config.yaml");
      writeFileSync(configPath, 'write:\n  - {allow: "${GIT_MAIN_WORKTREE_PATH}-worktrees"}\n');
      const sandbox = new Sandbox(mainWorktreePath, configPath);
      const worktreesDirectory = join(workspacePath, "main-worktrees");

      await sandbox.authorizePath("write", join(worktreesDirectory, "topic"), {
        cwd: mainWorktreePath,
      });
      assert.equal(sandbox.buildArgs("fs").includes(worktreesDirectory), true);
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

  it(
    "${XDG_RUNTIME_DIR} は書き込みを許可し bind に含める",
    withTempDirectory(async (directory) => {
      const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = directory;
      try {
        const configPath = join(directory, "config.yaml");
        writeFileSync(configPath, 'write:\n  - {allow: "${XDG_RUNTIME_DIR}"}\n');
        const sandbox = new Sandbox(directory, configPath);

        await sandbox.authorizePath("write", join(directory, "app.sock"), { cwd: directory });
        assert.equal(sandbox.buildArgs("fs").includes(directory), true);
      } finally {
        if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
      }
    }),
  );

  it(
    "${XDG_RUNTIME_DIR} を含むエントリは起動時に作成しない",
    withTempDirectory((directory) => {
      const absentRuntimeDir = join(directory, "runtime");
      const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = absentRuntimeDir;
      try {
        const configPath = join(directory, "config.yaml");
        writeFileSync(configPath, 'write:\n  - {allow: "${XDG_RUNTIME_DIR}"}\n');
        const args = new Sandbox(directory, configPath).buildArgs("fs");

        assert.equal(existsSync(absentRuntimeDir), false);
        assert.deepEqual(readdirSync(directory), ["config.yaml"]);
        assert.equal(args.includes(absentRuntimeDir), false);
      } finally {
        if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
      }
    }),
  );
});

describe("REPOSITORY_NAME work folder", () => {
  it(
    "resolves a non-Git repository name from the normalized session cwd",
    withTempDirectory((directory) => {
      const cwd = join(directory, "notes");
      mkdirSync(cwd);
      const workPattern = join(directory, "work", "${REPOSITORY_NAME}", "drafts");
      const section = expandPathSection(
        [{ action: "allow", patterns: [workPattern] }],
        join(cwd, "."),
      );
      assert.deepEqual(section[0]?.paths, [join(directory, "work", "notes", "drafts")]);
    }),
  );

  it(
    "creates and authorizes both non-Git work folders",
    withTempDirectory(async (directory) => {
      const cwd = join(directory, "notes");
      mkdirSync(cwd);
      const configPath = join(directory, "config.yaml");
      const workPath = join(directory, "work", "notes");
      const worktreesPath = join(directory, "worktrees", "notes");
      writeFileSync(
        configPath,
        JSON.stringify({
          write: [
            {
              allow: [
                join(directory, "work", "${REPOSITORY_NAME}"),
                join(directory, "worktrees", "${REPOSITORY_NAME}"),
              ],
            },
          ],
        }),
      );
      const sandbox = new Sandbox(cwd, configPath);
      assert.equal(existsSync(workPath), true);
      assert.equal(existsSync(worktreesPath), true);
      await sandbox.authorizePath("write", join(workPath, "note.md"), { cwd });
      await sandbox.authorizePath("write", join(worktreesPath, "note.md"), { cwd });
      await assert.rejects(
        () => sandbox.authorizePath("write", join(directory, "work", "other", "note.md"), { cwd }),
        /Access requires confirmation/,
      );
      for (const path of [workPath, worktreesPath]) {
        for (const mode of ["fs", "bash"] as const) {
          const args = sandbox.buildArgs(mode);
          const mountIndex = args.indexOf(path);
          assert.equal(args[mountIndex - 1], "--bind-try");
          assert.equal(args[mountIndex + 1], path);
        }
      }
    }),
  );

  it(
    "uses one main-named work folder from both main and linked worktrees",
    withLinkedWorktree(async (mainWorktreePath, linkedWorktreePath, workspacePath) => {
      const configPath = join(workspacePath, "config.yaml");
      const workPath = join(workspacePath, "work", basename(mainWorktreePath));
      const linkedWorkPath = join(workspacePath, "work", basename(linkedWorktreePath));
      const worktreesPath = join(workspacePath, "worktrees", basename(mainWorktreePath));
      const linkedWorktreesPath = join(workspacePath, "worktrees", basename(linkedWorktreePath));
      writeFileSync(
        configPath,
        JSON.stringify({
          write: [
            {
              allow: [
                ".",
                "${GIT_MAIN_WORKTREE_PATH}",
                join(workspacePath, "work", "${REPOSITORY_NAME}"),
                join(workspacePath, "worktrees", "${REPOSITORY_NAME}"),
              ],
            },
          ],
        }),
      );
      for (const cwd of [mainWorktreePath, linkedWorktreePath]) {
        const sandbox = new Sandbox(cwd, configPath);
        assert.equal(existsSync(workPath), true);
        assert.equal(existsSync(worktreesPath), true);
        assert.equal(existsSync(linkedWorkPath), false);
        assert.equal(existsSync(linkedWorktreesPath), false);
        await sandbox.authorizePath("write", join(workPath, "note.md"), { cwd });
        await sandbox.authorizePath("write", join(worktreesPath, "note.md"), { cwd });
        for (const otherPath of [linkedWorkPath, linkedWorktreesPath]) {
          await assert.rejects(
            () => sandbox.authorizePath("write", join(otherPath, "note.md"), { cwd }),
            /Access requires confirmation/,
          );
        }
        const args = sandbox.buildArgs("bash");
        assert.equal(args.includes(workPath), true);
        assert.equal(args.includes(linkedWorkPath), false);
        assert.equal(args.includes(worktreesPath), true);
        assert.equal(args.includes(linkedWorktreesPath), false);
        assert.equal(args.includes(mainWorktreePath), true);
        assert.equal(args.includes(cwd), true);
      }
    }),
  );

  it(
    "keeps last-match-wins for repository work paths",
    withTempDirectory((directory) => {
      const workPath = join(directory, "work", basename(directory));
      const pattern = join(directory, "work", "${REPOSITORY_NAME}");
      const section = expandPathSection(
        [
          { action: "allow", patterns: [pattern] },
          { action: "ask", patterns: [join(pattern, "ask")] },
          { action: "deny", patterns: [join(pattern, "denied")] },
          { action: "allow", patterns: [join(pattern, "denied", "allowed")] },
        ],
        directory,
      );
      assert.equal(resolvePathAction(section, join(workPath, "note.md")), "allow");
      assert.equal(resolvePathAction(section, join(workPath, "ask", "note.md")), "ask");
      assert.equal(resolvePathAction(section, join(workPath, "denied", "note.md")), "deny");
      assert.equal(
        resolvePathAction(section, join(workPath, "denied", "allowed", "note.md")),
        "allow",
      );
    }),
  );

  it(
    "expands repository names for read rules and keeps credential paths denied",
    withTempDirectory(async (directory) => {
      const pattern = join(directory, "work", "${REPOSITORY_NAME}");
      const workPath = join(directory, "work", basename(directory));
      const credentialPath = join(workPath, "credential");
      const configPath = join(directory, "config.yaml");
      writeFileSync(
        configPath,
        JSON.stringify({
          read: [{ allow: [pattern] }],
          write: [{ allow: [pattern] }],
          credentials: [join(pattern, "credential")],
        }),
      );
      const sandbox = new Sandbox(directory, configPath);
      writeFileSync(credentialPath, "secret");
      await sandbox.authorizePath("read", join(workPath, "note.md"), { cwd: directory });
      for (const operation of ["read", "write"] as const)
        await assert.rejects(
          () => sandbox.authorizePath(operation, credentialPath, { cwd: directory }),
          /Access denied for credential path/,
        );
    }),
  );
  const literalNames = [
    "*",
    "notes[1]",
    "{alpha,beta}",
    "draft?",
    "${XDG_RUNTIME_DIR}",
    "${REPOSITORY_NAME}",
    "${PROJECT_NAME}",
    "${GIT_MAIN_WORKTREE_PATH}",
    "$&",
    "a\\b",
  ];

  for (const name of literalNames) {
    it(
      `creates and binds only the literal work folder for ${name}`,
      withTempDirectory(async (directory) => {
        const cwd = join(directory, name);
        mkdirSync(cwd);
        const workRoot = join(directory, "work");
        const workPath = join(workRoot, name);
        const otherPaths = ["other", "alpha", "beta", "notes1"].map((other) =>
          join(workRoot, other),
        );
        for (const otherPath of otherPaths) mkdirSync(otherPath, { recursive: true });
        const configPath = join(directory, "config.yaml");
        writeFileSync(
          configPath,
          JSON.stringify({
            write: [{ allow: [join(workRoot, "${REPOSITORY_NAME}")] }],
          }),
        );
        const sandbox = new Sandbox(cwd, configPath);
        assert.equal(existsSync(workPath), true);
        assert.deepEqual(
          readdirSync(workRoot).filter(
            (entry) => !otherPaths.some((other) => other === join(workRoot, entry)),
          ),
          [name],
        );
        assert.deepEqual(sandbox.getWritePathsByFinalAction().allow, [workPath]);
        await sandbox.authorizePath("write", join(workPath, "note.md"), { cwd });
        for (const otherPath of otherPaths) {
          await assert.rejects(
            () => sandbox.authorizePath("write", join(otherPath, "note.md"), { cwd }),
            /Access requires confirmation/,
          );
          for (const mode of ["fs", "bash"] as const) {
            const args = sandbox.buildArgs(mode);
            assert.equal(args.includes(otherPath), false);
          }
        }
        for (const mode of ["fs", "bash"] as const) {
          const args = sandbox.buildArgs(mode);
          const mountIndex = args.indexOf(workPath);
          assert.equal(args[mountIndex - 1], "--bind-try");
          assert.equal(args[mountIndex + 1], workPath);
          assert.equal(
            args.some((arg) => arg.includes("\0")),
            false,
          );
        }
      }),
    );

    it(
      `keeps read deny and credentials inside the literal project ${name}`,
      withTempDirectory(async (directory) => {
        const cwd = join(directory, name);
        mkdirSync(cwd);
        const pattern = join(directory, "work", "${REPOSITORY_NAME}");
        const workPath = join(directory, "work", name);
        mkdirSync(workPath, { recursive: true });
        const hiddenPath = join(workPath, "secret.txt");
        const credentialPath = join(workPath, "credential");
        writeFileSync(hiddenPath, "hidden");
        writeFileSync(credentialPath, "credential");
        const configPath = join(directory, "config.yaml");
        writeFileSync(
          configPath,
          JSON.stringify({
            read: [{ allow: "*" }, { deny: [join(pattern, "secret.*")] }],
            write: [{ allow: [pattern] }],
            credentials: [join(pattern, "credential")],
          }),
        );
        const sandbox = new Sandbox(cwd, configPath);
        await assert.rejects(
          () => sandbox.authorizePath("read", hiddenPath, { cwd }),
          /Access denied/,
        );
        for (const operation of ["read", "write"] as const) {
          await assert.rejects(
            () => sandbox.authorizePath(operation, credentialPath, { cwd }),
            /Access denied for credential path/,
          );
        }
        const laterSecret = join(workPath, "secret.later");
        writeFileSync(laterSecret, "hidden later");
        await assert.rejects(
          () => sandbox.authorizePath("read", laterSecret, { cwd }),
          /Access denied/,
        );
        assert.equal(sandbox.buildArgs("fs").includes(hiddenPath), true);
        assert.equal(sandbox.buildArgs("bash").includes(credentialPath), true);
      }),
    );
  }

  const classCases = [
    { name: "a", pattern: "[${REPOSITORY_NAME}]", matches: ["a"], misses: ["[a]", "b"] },
    { name: "*", pattern: "[${REPOSITORY_NAME}]", matches: ["*"], misses: ["[*]", "b"] },
    { name: "]", pattern: "[${REPOSITORY_NAME}]", matches: ["]"], misses: ["[]]", "b"] },
    { name: "[", pattern: "[${REPOSITORY_NAME}]", matches: ["["], misses: ["[[]", "b"] },
    { name: "^", pattern: "[${REPOSITORY_NAME}]", matches: ["^"], misses: ["a", "[^]"] },
    { name: "-", pattern: "[${REPOSITORY_NAME}]", matches: ["-"], misses: ["b", "[-]"] },
    { name: "\\", pattern: "[${REPOSITORY_NAME}]", matches: ["\\"], misses: ["b", "[\\]"] },
    {
      name: "a-z",
      pattern: "[${REPOSITORY_NAME}]",
      matches: ["a", "-", "z"],
      misses: ["b", "a-z"],
    },
    {
      name: "a]^\\-",
      pattern: "[${REPOSITORY_NAME}]",
      matches: ["a", "]", "^", "\\", "-"],
      misses: ["b", "a]^\\-"],
    },
    { name: "ab", pattern: "[${REPOSITORY_NAME}]", matches: ["a", "b"], misses: ["ab", "c"] },
    { name: "a", pattern: "[^${REPOSITORY_NAME}]", matches: ["b", "^"], misses: ["a", "[a]"] },
    { name: "a", pattern: "[!${REPOSITORY_NAME}]", matches: ["a", "!"], misses: ["b", "[!a]"] },
    { name: "c", pattern: "[a-${REPOSITORY_NAME}]", matches: ["a", "b", "c"], misses: ["d", "-"] },
    { name: "a", pattern: "[${REPOSITORY_NAME}-c]", matches: ["a", "b", "c"], misses: ["d", "-"] },
    { name: "^", pattern: "[^${REPOSITORY_NAME}]", matches: ["a", "b"], misses: ["^", "[^^]"] },
    { name: "]", pattern: "[${REPOSITORY_NAME}]]", matches: ["]]"], misses: ["]", "[]]]"] },
    {
      name: "a",
      pattern: "[${REPOSITORY_NAME}${REPOSITORY_NAME}]",
      matches: ["a"],
      misses: ["aa", "[aa]"],
    },
    { name: "n", pattern: "[\\${REPOSITORY_NAME}]", matches: ["n"], misses: ["\\", "\n"] },
    { name: "n", pattern: "[\\\\${REPOSITORY_NAME}]", matches: ["n", "\\"], misses: ["a", "\n"] },
    { name: "a", pattern: "[${REPOSITORY_NAME}", matches: ["[a"], misses: ["a", "[b"] },
    {
      name: "a",
      pattern: "[${REPOSITORY_NAME}]suffix",
      matches: ["asuffix"],
      misses: ["[a]suffix", "bsuffix"],
    },
  ];

  for (const { name, pattern, matches, misses } of classCases) {
    it(
      `selects configured character classes with literal REPOSITORY_NAME ${JSON.stringify({ name, pattern })}`,
      withTempDirectory(async (directory) => {
        const cwd = join(directory, "cwd", name);
        mkdirSync(cwd, { recursive: true });
        const workRoot = join(directory, "work");
        const expectedPaths = matches.map((entry) => join(workRoot, entry));
        const excludedPaths = misses.map((entry) => join(workRoot, entry));
        for (const path of [...expectedPaths, ...excludedPaths])
          mkdirSync(path, { recursive: true });
        const configuredPattern = join(workRoot, pattern);
        const section = expandPathSection(
          [{ action: "allow", patterns: [configuredPattern] }],
          cwd,
        );
        assert.deepEqual(section[0]?.paths.slice().sort(), expectedPaths.slice().sort());
        const configPath = join(directory, "config.yaml");
        writeFileSync(configPath, JSON.stringify({ write: [{ allow: [configuredPattern] }] }));
        const sandbox = new Sandbox(cwd, configPath);
        for (const path of expectedPaths) {
          await sandbox.authorizePath("write", join(path, "note.md"), { cwd });
          for (const mode of ["fs", "bash"] as const) {
            const args = sandbox.buildArgs(mode);
            assert.equal(args[args.indexOf(path) - 1], "--bind-try");
          }
        }
        for (const path of excludedPaths) {
          await assert.rejects(
            () => sandbox.authorizePath("write", join(path, "note.md"), { cwd }),
            /Access requires confirmation/,
          );
          for (const mode of ["fs", "bash"] as const)
            assert.equal(sandbox.buildArgs(mode).includes(path), false);
        }
      }),
    );

    it(
      `protects character-class read deny and credentials for REPOSITORY_NAME ${JSON.stringify({ name, pattern })}`,
      withTempDirectory(async (directory) => {
        const cwd = join(directory, "cwd", name);
        mkdirSync(cwd, { recursive: true });
        const workRoot = join(directory, "work");
        const expectedPaths = matches.map((entry) => join(workRoot, entry));
        const excludedPaths = misses.map((entry) => join(workRoot, entry));
        for (const path of [...expectedPaths, ...excludedPaths]) {
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, "secret"), "hidden");
          writeFileSync(join(path, "credential"), "credential");
        }
        const configuredPattern = join(workRoot, pattern);
        const configPath = join(directory, "config.yaml");
        writeFileSync(
          configPath,
          JSON.stringify({
            read: [{ allow: "*" }, { deny: [join(configuredPattern, "secret*")] }],
            write: [{ allow: [workRoot] }],
            credentials: [join(configuredPattern, "credential")],
          }),
        );
        const sandbox = new Sandbox(cwd, configPath);
        for (const path of expectedPaths) {
          await assert.rejects(
            () => sandbox.authorizePath("read", join(path, "secret"), { cwd }),
            /Access denied/,
          );
          for (const operation of ["read", "write"] as const) {
            await assert.rejects(
              () => sandbox.authorizePath(operation, join(path, "credential"), { cwd }),
              /Access denied for credential path/,
            );
          }
          const args = sandbox.buildArgs("fs");
          assert.equal(args.includes(join(path, "secret")), true);
          assert.equal(args.includes(join(path, "credential")), true);
          const bashArgs = sandbox.buildArgs("bash");
          const credentialIndex = bashArgs.indexOf(join(path, "credential"));
          assert.equal(bashArgs[credentialIndex - 1], "--ro-bind-try");
          writeFileSync(join(path, "secret.later"), "later");
          await assert.rejects(
            () => sandbox.authorizePath("read", join(path, "secret.later"), { cwd }),
            /Access denied/,
          );
        }
        for (const path of excludedPaths) {
          await sandbox.authorizePath("read", join(path, "secret"), { cwd });
          await sandbox.authorizePath("read", join(path, "credential"), { cwd });
          for (const mode of ["fs", "bash"] as const) {
            const args = sandbox.buildArgs(mode);
            assert.equal(args.includes(join(path, "secret")), false);
            assert.equal(args.includes(join(path, "credential")), false);
          }
        }
      }),
    );
  }

  it(
    "preserves configured glob and brace expansion around literal repository names",
    withTempDirectory((directory) => {
      const name = "{alpha,beta}[1]*";
      const cwd = join(directory, name);
      mkdirSync(cwd);
      const workRoot = join(directory, "work");
      const expectedPaths = ["a", "b"].map((parent) => join(workRoot, parent, name, "drafts"));
      for (const path of expectedPaths) mkdirSync(path, { recursive: true });
      mkdirSync(join(workRoot, "a", "alpha1", "drafts"), { recursive: true });
      const patterns = [
        join(workRoot, "{a,b}", "${REPOSITORY_NAME}", "*"),
        join(workRoot, "*", "${REPOSITORY_NAME}", "{drafts,absent}"),
      ];
      const section = expandPathSection([{ action: "allow", patterns }], cwd);
      assert.deepEqual([...new Set(section[0]?.paths)].sort(), expectedPaths.sort());
    }),
  );

  it(
    "keeps a special cwd literal when resolving relative repository patterns",
    withTempDirectory((directory) => {
      const name = "*";
      const cwd = join(directory, name);
      const otherCwd = join(directory, "other");
      const workPath = join(cwd, "work", name);
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(otherCwd, "work", name), { recursive: true });
      const patterns = ["work/${REPOSITORY_NAME}", "work/${REPOSITORY_NAME}/*"];
      const section = expandPathSection([{ action: "allow", patterns }], cwd);
      assert.deepEqual(section[0]?.paths, [workPath]);
      const configPath = join(directory, "config.yaml");
      writeFileSync(
        configPath,
        JSON.stringify({ write: [{ allow: ["work/${REPOSITORY_NAME}"] }] }),
      );
      const sandbox = new Sandbox(cwd, configPath);
      assert.equal(existsSync(workPath), true);
      assert.equal(sandbox.buildArgs("bash").includes(workPath), true);
      assert.equal(sandbox.buildArgs("bash").includes(join(otherCwd, "work", name)), false);
    }),
  );

  it(
    "creates configured brace branches around a literal repository name",
    withTempDirectory((directory) => {
      const name = "{alpha,beta}";
      const cwd = join(directory, name);
      mkdirSync(cwd);
      const configPath = join(directory, "config.yaml");
      writeFileSync(
        configPath,
        JSON.stringify({
          write: [{ allow: [join(directory, "work", "{a,b}", "${REPOSITORY_NAME}")] }],
        }),
      );
      const sandbox = new Sandbox(cwd, configPath);
      for (const branch of ["a", "b"]) {
        const workPath = join(directory, "work", branch, name);
        assert.equal(existsSync(workPath), true);
        assert.equal(sandbox.buildArgs("bash").includes(workPath), true);
        assert.equal(existsSync(join(directory, "work", branch, "alpha")), false);
        assert.equal(existsSync(join(directory, "work", branch, "beta")), false);
      }
      assert.equal(existsSync(join(directory, "work", "{a,b}")), false);
    }),
  );

  it(
    "does not grant the work parent for a root cwd",
    withTempDirectory((directory) => {
      const pattern = join(directory, "work", "${REPOSITORY_NAME}");
      assert.deepEqual(
        expandPathSection([{ action: "allow", patterns: [pattern] }], "/")[0]?.paths,
        [],
      );
      const configPath = join(directory, "config.yaml");
      writeFileSync(configPath, JSON.stringify({ write: [{ allow: [pattern] }] }));
      const sandbox = new Sandbox("/", configPath);
      assert.equal(existsSync(join(directory, "work")), false);
      assert.equal(sandbox.buildArgs("bash").includes(join(directory, "work")), false);
    }),
  );

  it(
    "does not treat a literal repository tilde as home expansion",
    withTempDirectory((directory) => {
      const cwd = join(directory, "~");
      mkdirSync(cwd);
      const section = expandPathSection(
        [{ action: "allow", patterns: ["${REPOSITORY_NAME}"] }],
        cwd,
      );
      assert.deepEqual(section[0]?.paths, [join(cwd, "~")]);
    }),
  );

  it(
    "lists repository work folders in the final allow guideline",
    withTempDirectory((directory) => {
      const configPath = join(directory, "config.yaml");
      const workPattern = join(directory, "work", "${REPOSITORY_NAME}");
      writeFileSync(configPath, JSON.stringify({ write: [{ allow: [workPattern] }] }));

      const guidance = captureRegisteredTools(configPath).get("ask_permission").promptGuidelines[0];
      const mainWorktreePath = resolveGitMainWorktreePath(process.cwd());
      const expectedWorkPath = join(directory, "work", basename(mainWorktreePath ?? process.cwd()));
      assert.ok(guidance.includes(JSON.stringify(expectedWorkPath)));
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
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(dir, "*")] }],
        "/cwd",
      );
      assert.equal(resolvePathAction(section, join(dir, "uv")), "allow");
      assert.equal(resolvePathAction(section, join(dir, "pip")), "allow");
    }),
  );

  it(
    "** は再帰的な既存パスに展開される",
    withGlobDir((dir) => {
      mkdirSync(join(dir, "uv", "nested", "deep"), { recursive: true });
      const section = expandPathSection(
        [{ action: "allow", patterns: [join(dir, "**")] }],
        "/cwd",
      );
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

  it('"*" 単体はすべてのパスを read 許可にする', () => {
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
    withGlobDir((dir) => {
      writeFileSync(join(dir, "credential"), "secret");
      return withSandbox(
        `
read:
  - {allow: [/]}
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
  - {allow: "${join(dir, "*")}"}
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
  - {deny: "${join(dir, "*")}"}
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

  it("一致しないパスは deny になる", () => {
    const section = expandPathSection([{ action: "allow", patterns: ["."] }], projectRoot);
    assert.equal(resolvePathAction(section, "/tmp/file.txt"), "deny");
  });
});

describe("§2.3 確認ダイアログの一致パターン表示", () => {
  it("コマンド ask は一致したパターンと一致範囲を返す", () => {
    const match = resolveCommandActionMatch(
      compiled([
        { action: "allow", pattern: ".*", args: [] },
        { action: "ask", pattern: "git", args: ["push"] },
        { action: "ask", pattern: "gh", args: ["pr", "create"] },
      ]),
      "git push -u origin main",
    );
    assert.deepEqual(match, {
      action: "ask",
      matched: '{"command":"git","args":["push"]}',
      matchSpan: {
        ranges: [
          { index: 0, length: 3 },
          { index: 4, length: 4 },
        ],
      },
    });
  });

  it("正規表現の一致範囲を返す", () => {
    const match = resolveCommandActionMatch(
      compiled([{ action: "ask", pattern: "(npm|pnpm)", args: ["publish"] }]),
      "npm publish",
    );
    assert.deepEqual(match, {
      action: "ask",
      matched: '{"command":"(npm|pnpm)","args":["publish"]}',
      matchSpan: {
        ranges: [
          { index: 0, length: 3 },
          { index: 4, length: 7 },
        ],
      },
    });
  });

  it("前方一致しない正規表現は一致位置を一致範囲として返す", () => {
    const match = resolveCommandActionMatch(
      compiled([{ action: "ask", pattern: "git", args: ["p"] }]),
      "git push",
    );
    assert.deepEqual(match, { action: "deny" });
  });

  it("複合コマンドは ask セグメントの一致パターンを返す", () => {
    const match = resolveCommandActionMatch(
      compiled([
        { action: "allow", pattern: "ls", args: [] },
        { action: "ask", pattern: "git", args: ["push"] },
      ]),
      "ls; git push -u origin main",
    );
    assert.deepEqual(match, {
      action: "ask",
      matched: '{"command":"git","args":["push"]}',
      matchSpan: {
        ranges: [
          { index: 4, length: 3 },
          { index: 8, length: 4 },
        ],
      },
    });
  });

  it("後の deny エントリが前のエントリを上書きするとき deny の一致パターンを返す", () => {
    const match = resolveCommandActionMatch(
      compiled([
        { action: "allow", pattern: ".*", args: [] },
        { action: "ask", pattern: "git", args: ["push"] },
        { action: "deny", pattern: "sudo", args: [] },
      ]),
      "sudo git push",
    );
    assert.deepEqual(match, {
      action: "deny",
      matched: '{"command":"sudo","args":[]}',
      matchSpan: { ranges: [{ index: 0, length: 4 }] },
    });
  });

  it("どのパターンにも一致しないコマンドは matched なしの deny", () => {
    const match = resolveCommandActionMatch(
      compiled([{ action: "allow", pattern: "git", args: ["status"] }]),
      "git push",
    );
    assert.deepEqual(match, { action: "deny" });
  });

  it("パス ask は展開後の一致パスを返す", () => {
    const section = expandPathSection(
      [
        { action: "allow", patterns: ["."] },
        { action: "ask", patterns: ["/opt/data"] },
      ],
      "/workspace/project",
    );
    const match = resolvePathActionMatch(section, "/opt/data/file.txt");
    assert.deepEqual(match, { action: "ask", matched: "/opt/data" });
  });

  it("設定に一致しないパスは matched なしの deny", () => {
    const section = expandPathSection(
      [{ action: "allow", patterns: ["."] }],
      "/workspace/project",
    );
    const match = resolvePathActionMatch(section, "/tmp/file.txt");
    assert.deepEqual(match, { action: "deny" });
  });

  it(
    "コマンド確認ダイアログのタイトルに一致パターンを表示する",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push`,
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
            theme: uiTheme,
          },
        });
        assert.ok(title.includes('matched: {"command":"git","args":["push"]}'), title);
        assert.ok(title.includes(`${highlighted("git")} ${highlighted("push")}`), title);
      },
    ),
  );

  it(
    "コマンド確認ダイアログは先頭の VAR= を読み飛ばした位置を強調する",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push`,
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
            theme: uiTheme,
          },
        });
        assert.ok(
          title.includes(`FOO=1 ${`${highlighted("git")} ${highlighted("push")}`} origin main`),
          title,
        );
      },
    ),
  );

  it(
    "コマンド確認ダイアログは語境界にない部分一致を飛ばして次の出現を強調する",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push`,
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
            theme: uiTheme,
          },
        });
        assert.ok(
          title.includes(`echo mygit pushx; ${`${highlighted("git")} ${highlighted("push")}`}`),
          title,
        );
      },
    ),
  );

  it(
    "token ranges preserve multiple spaces in highlights",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push`,
      "/cwd",
      async (sandbox) => {
        let title = "";
        await sandbox.authorizeCommand("git  push origin main", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => true,
            select: async (dialogTitle) => {
              title = dialogTitle;
              return "Yes, allow";
            },
            theme: uiTheme,
          },
        });
        assert.ok(
          title.includes(`${highlighted("git")}  ${highlighted("push")} origin main`),
          title,
        );
      },
    ),
  );

  it(
    "quoted matching tokens are highlighted at their original ranges",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push`,
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
            theme: uiTheme,
          },
        });
        assert.ok(
          title.includes(`${highlighted("git")} ${highlighted('"push"')} origin main`),
          title,
        );
      },
    ),
  );

  it(
    "UI がテーマを提供しないときは強調しない",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push`,
      "/cwd",
      async (sandbox) => {
        let title = "";
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
        assert.ok(title.includes("git push origin main"), title);
        for (const ansi of HIGHLIGHT_ANSI) assert.ok(!title.includes(ansi), title);
      },
    ),
  );

  it(
    "NO_COLOR が設定されているときは強調しない",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - git:
      - ask:
          - push`,
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
              theme: uiTheme,
            },
          });
        } finally {
          if (previousNoColor === undefined) delete process.env.NO_COLOR;
          else process.env.NO_COLOR = previousNoColor;
        }
        assert.ok(title.includes("git push origin main"), title);
        for (const ansi of HIGHLIGHT_ANSI) assert.ok(!title.includes(ansi), title);
      },
    ),
  );

  it(
    "ask パスの確認ダイアログは一致パターンを表示する",
    withSandbox(
      `
read:
  - {ask: [~/sandboxed-tools-ask-dir]}
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
        assert.ok(
          title.includes(`matched: ${join(homedir(), "sandboxed-tools-ask-dir")}`),
          title,
        );
      },
    ),
  );

  it(
    "未設定パスの許可要求ダイアログは一致パターンなしを表示する",
    withSandbox("read: []\nwrite: []\n", "/cwd", async (sandbox) => {
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

describe("§2.3 承認ノート", () => {
  const withApprovalSandbox =
    (
      configYaml: string | ((dir: string) => string),
      test: (dir: string, sandbox: Sandbox) => Promise<void> | void,
    ) =>
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-approval-"));
      try {
        const configPath = join(dir, "config.yaml");
        writeFileSync(
          configPath,
          typeof configYaml === "function" ? configYaml(dir) : configYaml,
        );
        await test(dir, new Sandbox(dir, configPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

  /** Replace Sandbox.run with a canned run-tools envelope; restore via the return value. */
  const stubSandboxRun = (resultText: string) => {
    const envelope = JSON.stringify({
      ok: true,
      result: { content: [{ type: "text", text: resultText }] },
    });
    const sandboxPrototype = Sandbox.prototype as unknown as {
      run: (command: string, commandArgs: string[], options: any) => Promise<unknown>;
    };
    const originalRun = sandboxPrototype.run;
    sandboxPrototype.run = async () => ({
      exitCode: 0,
      stdout: Buffer.from(envelope),
      stderr: Buffer.alloc(0),
    });
    return () => {
      sandboxPrototype.run = originalRun;
    };
  };

  const resultTexts = (result: any): string[] => result.content.map((block: any) => block.text);

  it(
    "write のファイルスコープ承認は approval を返す",
    withApprovalSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
      const filePath = join(dir, "file.txt");
      const approval = await sandbox.authorizePath("write", filePath, {
        cwd: dir,
        hasUI: true,
        ui: { confirm: async () => true },
      });
      assert.deepEqual(approval, {
        operation: "write",
        scope: "file",
        grantedPath: filePath,
        bashWritable: true,
      });
    }),
  );

  it(
    "write のディレクトリスコープ承認は grant ディレクトリを返す",
    withApprovalSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
      const approval = await sandbox.authorizePath("write", join(dir, "file.txt"), {
        cwd: dir,
        hasUI: true,
        ui: { confirm: async () => true, select: async (_title, options) => options[1] },
      });
      assert.deepEqual(approval, {
        operation: "write",
        scope: "directory",
        grantedPath: dir,
        bashWritable: true,
      });
    }),
  );

  it(
    "read の承認も approval を返す",
    withApprovalSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
      const filePath = join(dir, "file.txt");
      const approval = await sandbox.authorizePath("read", filePath, {
        cwd: dir,
        hasUI: true,
        ui: { confirm: async () => true },
      });
      assert.deepEqual(approval, { operation: "read", scope: "file", grantedPath: filePath });
    }),
  );

  it(
    "ask に確定したパスへの承認は bash から書けない approval を返す",
    withApprovalSandbox(
      (dir) => `write:\n  - {ask: "${join(dir, "asked.txt")}"}\n`,
      async (dir, sandbox) => {
        const approval = await sandbox.authorizePath("write", join(dir, "asked.txt"), {
          cwd: dir,
          hasUI: true,
          ui: { confirm: async () => true },
        });
        assert.deepEqual(approval, {
          operation: "write",
          scope: "file",
          grantedPath: join(dir, "asked.txt"),
          bashWritable: false,
        });
      },
    ),
  );

  it(
    "許可済みパスの再 authorize は approval を返さない",
    withApprovalSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
      const filePath = join(dir, "file.txt");
      const context = {
        cwd: dir,
        hasUI: true,
        ui: { confirm: async () => true },
      };
      await sandbox.authorizePath("write", filePath, context);
      const second = await sandbox.authorizePath("write", filePath, context);
      assert.equal(second, undefined);
    }),
  );

  it(
    "allow コマンドは approval なし、ask コマンドの承認は approval を返す",
    withApprovalSandbox(
      `commands:
  - echo:
      - allow: []
  - git:
      - ask:
          - push`,
      async (dir, sandbox) => {
        const context = {
          cwd: dir,
          hasUI: true,
          ui: { confirm: async () => true },
        };
        assert.equal(await sandbox.authorizeCommand("echo hi", context), false);
        assert.equal(await sandbox.authorizeCommand("git push origin main", context), true);
      },
    ),
  );

  it("writeApprovalNote はスコープごとの承認ノート文言を返す", () => {
    assert.equal(
      writeApprovalNote({ operation: "write", scope: "file", grantedPath: "/tmp/a.txt" }),
      "User approved write access via confirmation (scope: file /tmp/a.txt); writable for the rest of the session, including via bash.",
    );
    assert.equal(
      writeApprovalNote({ operation: "write", scope: "directory", grantedPath: "/tmp/dir" }),
      "User approved write access via confirmation (scope: directory /tmp/dir); the subtree is writable for the rest of the session, including via bash.",
    );
  });

  it("writeApprovalNote は ask 確定パスの承認で bash 不可の文言を返す", () => {
    assert.equal(
      writeApprovalNote({
        operation: "write",
        scope: "file",
        grantedPath: "/tmp/a.txt",
        bashWritable: false,
      }),
      "User approved write access via confirmation (scope: file /tmp/a.txt); writable via fs tools for the rest of the session, but not via bash (ask-configured paths stay read-only in the bash sandbox).",
    );
    assert.equal(
      writeApprovalNote({
        operation: "write",
        scope: "directory",
        grantedPath: "/tmp/dir",
        bashWritable: false,
      }),
      "User approved write access via confirmation (scope: directory /tmp/dir); the subtree is writable via fs tools for the rest of the session, but not via bash (ask-configured paths stay read-only in the bash sandbox).",
    );
  });

  it("write のディレクトリスコープ承認は subtree の承認ノートを付け、以降の同配下書き込みには付かない", async () => {
    // The grant directory must already exist so the dynamic grant performs no host-side writes.
    const filePath = join(homedir(), "projects", "sandboxed-tools-note-probe.txt");
    const restore = stubSandboxRun(`Successfully wrote 10 bytes to ${filePath}`);
    try {
      const writeTool = captureRegisteredTools().get("write");
      const first = await writeTool.execute(
        "t",
        { path: filePath, content: "x" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title: string, options: string[]) => options[1],
          },
        },
      );
      assert.deepEqual(resultTexts(first), [
        `Successfully wrote 10 bytes to ${filePath}`,
        `User approved write access via confirmation (scope: directory ${dirname(filePath)}); the subtree is writable for the rest of the session, including via bash.`,
      ]);
      const second = await writeTool.execute(
        "t",
        { path: filePath, content: "x" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          // A dialog here would throw: the directory grant must suppress it, and no note is appended.
          ui: { confirm: async () => false, select: async () => "No, deny (reason next)" },
        },
      );
      assert.deepEqual(resultTexts(second), [`Successfully wrote 10 bytes to ${filePath}`]);
    } finally {
      restore();
    }
  });

  it("write のディレクトリスコープ承認は subtree の承認ノートを付ける", async () => {
    const filePath = join(homedir(), "projects", "sandboxed-tools-note-dir.txt");
    const restore = stubSandboxRun(`Successfully wrote 10 bytes to ${filePath}`);
    try {
      const result = await captureRegisteredTools()
        .get("write")
        .execute("t", { path: filePath, content: "x" }, undefined, undefined, {
          cwd: process.cwd(),
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title: string, options: string[]) => options[1],
          },
        });
      assert.deepEqual(resultTexts(result), [
        `Successfully wrote 10 bytes to ${filePath}`,
        `User approved write access via confirmation (scope: directory ${dirname(filePath)}); the subtree is writable for the rest of the session, including via bash.`,
      ]);
    } finally {
      restore();
    }
  });

  it("edit の write 承認で結果末尾に承認ノートが付く", async () => {
    const filePath = join(homedir(), "projects", "sandboxed-tools-note-edit.txt");
    const restore = stubSandboxRun(`Successfully replaced 1 block(s) in ${filePath}.`);
    try {
      const result = await captureRegisteredTools()
        .get("edit")
        .execute("t", { path: filePath, edits: [] }, undefined, undefined, {
          cwd: process.cwd(),
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title: string, options: string[]) => options[1],
          },
        });
      assert.deepEqual(resultTexts(result), [
        `Successfully replaced 1 block(s) in ${filePath}.`,
        `User approved write access via confirmation (scope: directory ${dirname(filePath)}); the subtree is writable for the rest of the session, including via bash.`,
      ]);
    } finally {
      restore();
    }
  });

  it("bash の ask 承認で結果末尾に承認ノートが付く", async () => {
    const restore = stubSandboxRun("1 file changed, 2 insertions(+)");
    try {
      const result = await captureRegisteredTools()
        .get("bash")
        .execute("t", { command: "git push origin main" }, undefined, undefined, {
          cwd: process.cwd(),
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title: string, options: string[]) => options[0],
          },
        });
      assert.deepEqual(resultTexts(result), [
        "1 file changed, 2 insertions(+)",
        "User approved this command via confirmation.",
      ]);
    } finally {
      restore();
    }
  });

  it("bash の EROFS ではヒント文の後に承認ノートが最終行に来る", async () => {
    const restore = stubSandboxRun("touch: cannot touch '/outside/x': Read-only file system");
    try {
      const result = await captureRegisteredTools()
        .get("bash")
        .execute("t", { command: "git push origin main" }, undefined, undefined, {
          cwd: process.cwd(),
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title: string, options: string[]) => options[0],
          },
        });
      assert.deepEqual(resultTexts(result), [
        "touch: cannot touch '/outside/x': Read-only file system",
        "Sandbox blocked this write. Do not rewrite the command and retry with bash. Request access with ask_permission only when the target's effective write action is ask or unset and it is not a credentials path; explicit deny cannot be granted. If the result says bash writes are unavailable, use fs tools instead.",
        "User approved this command via confirmation.",
      ]);
    } finally {
      restore();
    }
  });

  it("read の結果には承認ノートを付けない", async () => {
    const filePath = join(process.cwd(), "sandboxed-tools-note-noappend.txt");
    const restore = stubSandboxRun("file body");
    try {
      const result = await captureRegisteredTools()
        .get("read")
        .execute("t", { path: filePath }, undefined, undefined, {
          cwd: process.cwd(),
          hasUI: true,
          ui: { confirm: async () => true },
        });
      assert.deepEqual(resultTexts(result), ["file body"]);
    } finally {
      restore();
    }
  });
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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
      writeFileSync(configPath, `read: []\nwrite:\n  - {deny: "**/.env"}\n`);
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
    withDynamicSandbox("read: []\nwrite: []\n", async (dir, sandbox) => {
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

describe("§3 許可要求ツール", () => {
  const withAskPermissionSandbox =
    (
      configYaml: (dir: string) => string,
      test: (dir: string, sandbox: Sandbox) => Promise<void> | void,
    ) =>
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-ask-perm-"));
      try {
        const configPath = join(dir, "config.yaml");
        writeFileSync(configPath, configYaml(dir));
        await test(dir, new Sandbox(dir, configPath));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

  const grantUi = {
    confirm: async () => false,
    select: async (_title: string, options: string[]) => options[0],
    input: async () => "",
  };
  const denyUi = {
    confirm: async () => false,
    // Deny is the last option in every dialog (2-option paths and 3-option
    // commands), so selecting the last one always denies.
    select: async (_title: string, options: string[]) => options[options.length - 1],
    input: async () => "",
  };
  const noDialogUi = {
    confirm: async () => {
      throw new Error("unexpected dialog");
    },
    select: async () => {
      throw new Error("unexpected dialog");
    },
  };

  it(
    "write.deny に一致するパスは許可要求できない",
    withAskPermissionSandbox(
      (dir) => `write:\n  - {deny: ${dir}/secret}\n`,
      async (dir, sandbox) => {
        await assert.rejects(
          () =>
            sandbox.requestWritePermission(join(dir, "secret"), "to edit the secret file", {
              cwd: dir,
              hasUI: true,
              ui: noDialogUi,
            }),
          /Access denied: /,
        );
      },
    ),
  );

  it(
    "credentials パスは許可要求できない",
    withAskPermissionSandbox(
      (dir) => `write: []\ncredentials: [${dir}/cred]\n`,
      async (dir, sandbox) => {
        await assert.rejects(
          () =>
            sandbox.requestWritePermission(join(dir, "cred"), "to edit the credential file", {
              cwd: dir,
              hasUI: true,
              ui: noDialogUi,
            }),
          /Access denied for credential path/,
        );
      },
    ),
  );

  it(
    "write.allow のパスはダイアログなしで許可済みを返す",
    withAskPermissionSandbox(
      (dir) => `write:\n  - {allow: ${dir}}\n`,
      async (dir, sandbox) => {
        const outcome = await sandbox.requestWritePermission(
          join(dir, "sub"),
          "to start editing",
          {
            cwd: dir,
            hasUI: true,
            ui: noDialogUi,
          },
        );
        assert.deepEqual(outcome, {
          status: "already granted",
          grantedPath: join(dir, "sub"),
          bashWritable: true,
        });
      },
    ),
  );

  it(
    "確認ダイアログを提供できない UI ではエラーになる",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        await assert.rejects(
          () =>
            sandbox.requestWritePermission(join(dir, "work"), "to start editing", {
              cwd: dir,
              hasUI: false,
            }),
          /Access requires confirmation: /,
        );
      },
    ),
  );

  it(
    "動的許可済みの配下はダイアログなしで許可済みを返す",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        await sandbox.authorizePath("write", join(dir, "file.txt"), {
          cwd: dir,
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title, options) => options[1],
          },
        });
        const outcome = await sandbox.requestWritePermission(
          join(dir, "sub"),
          "to start editing",
          {
            cwd: dir,
            hasUI: true,
            ui: noDialogUi,
          },
        );
        assert.deepEqual(outcome, {
          status: "already granted",
          grantedPath: join(dir, "sub"),
          bashWritable: true,
        });
      },
    ),
  );

  it(
    "未設定パスは選択肢2つの確認ダイアログを表示する",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        const selectionOptions: string[][] = [];
        await sandbox.requestWritePermission(
          join(dir, "work"),
          "to edit files in the new worktree",
          {
            cwd: dir,
            hasUI: true,
            ui: {
              ...grantUi,
              select: async (_title, options) => {
                selectionOptions.push(options);
                return options[0];
              },
            },
          },
        );
        assert.deepEqual(selectionOptions, [["Yes, allow", "No, deny (reason next)"]]);
      },
    ),
  );

  it(
    "ask_permission のダイアログは問いかけ・理由・設定パターンを行順どおりに表示する",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        let title = "";
        await sandbox.requestWritePermission(
          join(dir, "work"),
          "to edit files in the new worktree",
          {
            cwd: dir,
            hasUI: true,
            ui: {
              ...grantUi,
              select: async (dialogTitle, options) => {
                title = dialogTitle;
                return options[0];
              },
            },
          },
        );
        assert.equal(
          title,
          [
            "Allow write access to directory subtree?",
            join(dir, "work"),
            "reason: to edit files in the new worktree",
            "no matching pattern (default ask)",
          ].join("\n"),
        );
      },
    ),
  );

  it(
    "write.ask に一致するダイアログは一致パターンを表示する",
    withAskPermissionSandbox(
      (dir) => `write:\n  - {ask: ${dir}/asked}\n`,
      async (dir, sandbox) => {
        let title = "";
        await sandbox.requestWritePermission(
          join(dir, "asked"),
          "to edit files under the asked directory",
          {
            cwd: dir,
            hasUI: true,
            ui: {
              ...grantUi,
              select: async (dialogTitle, options) => {
                title = dialogTitle;
                return options[0];
              },
            },
          },
        );
        assert.ok(title.includes(`matched: ${join(dir, "asked")}`), title);
      },
    ),
  );

  it(
    "select を提供しない UI では confirm に置き換えて理由行を表示する",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        const confirmed: { question: string; message: string }[] = [];
        const outcome = await sandbox.requestWritePermission(
          join(dir, "work"),
          "to edit files in the new worktree",
          {
            cwd: dir,
            hasUI: true,
            ui: {
              confirm: async (question, message) => {
                confirmed.push({ question, message });
                return true;
              },
            },
          },
        );
        assert.deepEqual(outcome, {
          status: "granted",
          grantedPath: join(dir, "work"),
          bashWritable: true,
        });
        assert.equal(confirmed.length, 1);
        assert.equal(confirmed[0]?.question, "Allow write access to directory subtree?");
        assert.equal(
          confirmed[0]?.message,
          [
            join(dir, "work"),
            "reason: to edit files in the new worktree",
            "no matching pattern (default ask)",
          ].join("\n"),
        );
      },
    ),
  );

  it(
    "承認は path 配下をセッション内で書き込み可にし bind に追加する",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        const outcome = await sandbox.requestWritePermission(
          dir,
          "to start editing the repository",
          {
            cwd: dir,
            hasUI: true,
            ui: grantUi,
          },
        );
        assert.deepEqual(outcome, {
          status: "granted",
          grantedPath: dir,
          bashWritable: true,
        });
        await sandbox.authorizePath("write", join(dir, "any", "file.txt"), { cwd: dir });
        const args = sandbox.buildArgs("bash");
        const bindAt = args.indexOf(dir, args.indexOf(dir) + 2);
        assert.deepEqual(args.slice(bindAt - 1, bindAt + 2), ["--bind-try", dir, dir]);
      },
    ),
  );

  it(
    "承認時に存在しないディレクトリをフェンス外で作成する",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        const target = join(dir, "made", "worktree");
        await sandbox.requestWritePermission(target, "to create a worktree", {
          cwd: dir,
          hasUI: true,
          ui: grantUi,
        });
        assert.equal(existsSync(target), true);
      },
    ),
  );

  it(
    "拒否はエラーにならず以降の write は従来どおり確認される",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        const outcome = await sandbox.requestWritePermission(
          dir,
          "to start editing the repository",
          {
            cwd: dir,
            hasUI: true,
            ui: { ...denyUi, input: async () => "not now" },
          },
        );
        assert.deepEqual(outcome, { status: "denied", grantedPath: dir, reason: "not now" });
        let confirmCalls = 0;
        await assert.rejects(
          () =>
            sandbox.authorizePath("write", join(dir, "file.txt"), {
              cwd: dir,
              hasUI: true,
              ui: {
                confirm: async () => {
                  confirmCalls++;
                  return false;
                },
                input: async () => "",
              },
            }),
          /Access denied by user/,
        );
        assert.equal(confirmCalls, 1);
      },
    ),
  );

  it(
    "path がファイルのときは親ディレクトリ配下をスコープにする",
    withAskPermissionSandbox(
      () => "read: []\nwrite: []\n",
      async (dir, sandbox) => {
        const filePath = join(dir, "existing.txt");
        writeFileSync(filePath, "");
        const outcome = await sandbox.requestWritePermission(
          filePath,
          "to edit the existing file",
          {
            cwd: dir,
            hasUI: true,
            ui: grantUi,
          },
        );
        assert.deepEqual(outcome, {
          status: "granted",
          grantedPath: dir,
          bashWritable: true,
        });
        await sandbox.authorizePath("write", join(dir, "other.txt"), { cwd: dir });
      },
    ),
  );

  it(
    "ask に確定したパスへの承認は bash から書けないことを結果に含める",
    withAskPermissionSandbox(
      (dir) => `read: []\nwrite:\n  - {ask: ${dir}/asked}\n`,
      async (dir, sandbox) => {
        const outcome = await sandbox.requestWritePermission(
          join(dir, "asked"),
          "to edit the asked directory",
          {
            cwd: dir,
            hasUI: true,
            ui: grantUi,
          },
        );
        assert.deepEqual(outcome, {
          status: "granted",
          grantedPath: join(dir, "asked"),
          bashWritable: false,
        });
      },
    ),
  );

  it("ask_permission ツールの承認は動的許可と承認文言を返す", async () => {
    // The test runner itself is inside the bash sandbox, so the §6.1 host-side
    // directory creation is stubbed out (same pattern as stubSandboxRun).
    const probeDirectory = join(homedir(), "projects", "sandboxed-tools-ask-perm-probe");
    const createdGrants: { grantPath: string; scope: string }[] = [];
    const sandboxPrototype = Sandbox.prototype as unknown as {
      ensureGrantPathExists: (grantPath: string, scope: "file" | "directory") => void;
    };
    const originalEnsure = sandboxPrototype.ensureGrantPathExists;
    sandboxPrototype.ensureGrantPathExists = (grantPath, scope) => {
      createdGrants.push({ grantPath, scope });
    };
    try {
      const result = await captureRegisteredTools()
        .get("ask_permission")
        .execute(
          "t",
          { path: probeDirectory, reason: "to edit files in the probe directory" },
          undefined,
          undefined,
          {
            cwd: process.cwd(),
            hasUI: true,
            ui: grantUi,
          },
        );
      assert.deepEqual(result.content, [
        {
          type: "text",
          text: `User approved write access via confirmation (scope: directory ${probeDirectory}); the subtree is writable for the rest of the session, including via bash.`,
        },
      ]);
      assert.deepEqual(result.details, {
        status: "granted",
        grantedPath: probeDirectory,
      });
      assert.deepEqual(createdGrants, [{ grantPath: probeDirectory, scope: "directory" }]);
    } finally {
      sandboxPrototype.ensureGrantPathExists = originalEnsure;
    }
  });

  it("ask_permission ツールの拒否は拒否と理由を結果として返す", async () => {
    const deniedDirectory = join(homedir(), "projects", "sandboxed-tools-ask-perm-denied");
    const result = await captureRegisteredTools()
      .get("ask_permission")
      .execute(
        "t",
        { path: deniedDirectory, reason: "to edit files in the denied directory" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: { ...denyUi, input: async () => "not now" },
        },
      );
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: `User denied write access to ${deniedDirectory}.\nUser reason: not now`,
      },
    ]);
    assert.deepEqual(result.details, {
      status: "denied",
      grantedPath: deniedDirectory,
      reason: "not now",
    });
  });

  it("ask_permission ツールの拒否で理由が空欄のときは理由行を付けない", async () => {
    const deniedDirectory = join(
      homedir(),
      "projects",
      "sandboxed-tools-ask-perm-denied-empty",
    );
    const result = await captureRegisteredTools()
      .get("ask_permission")
      .execute(
        "t",
        { path: deniedDirectory, reason: "to edit files in the denied directory" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: denyUi,
        },
      );
    assert.deepEqual(result.content, [
      { type: "text", text: `User denied write access to ${deniedDirectory}.` },
    ]);
    assert.deepEqual(result.details, { status: "denied", grantedPath: deniedDirectory });
  });

  it("ask_permission ツールは許可済みパスに許可済みを返す", async () => {
    const result = await captureRegisteredTools()
      .get("ask_permission")
      .execute(
        "t",
        { path: process.cwd(), reason: "to edit files in the cwd" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: noDialogUi,
        },
      );
    assert.deepEqual(result.details, {
      status: "already granted",
      grantedPath: process.cwd(),
    });
    assert.match(result.content[0].text, /Already granted: /);
  });

  it("ask_permission は @・~・相対パスを cwd 基準で解決する", async () => {
    const requested: string[] = [];
    const originalRequest = Sandbox.prototype.requestWritePermission;
    Sandbox.prototype.requestWritePermission = async function (path: string, reason: string) {
      assert.equal(typeof reason, "string");
      requested.push(path);
      return { status: "denied", grantedPath: path };
    };
    const tool = captureRegisteredTools().get("ask_permission");
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      ui: denyUi,
    };
    try {
      await tool.execute(
        "t",
        { path: "@/abs/ask-permission-target", reason: "probe" },
        undefined,
        undefined,
        context,
      );
      await tool.execute(
        "t",
        { path: "~/sandboxed-tools-tilde-probe", reason: "probe" },
        undefined,
        undefined,
        context,
      );
      await tool.execute(
        "t",
        { path: "relative/probe", reason: "probe" },
        undefined,
        undefined,
        context,
      );
    } finally {
      Sandbox.prototype.requestWritePermission = originalRequest;
    }
    assert.deepEqual(requested, [
      "/abs/ask-permission-target",
      join(homedir(), "sandboxed-tools-tilde-probe"),
      resolve(process.cwd(), "relative/probe"),
    ]);
  });

  it(
    "command のダイアログは問いかけ・理由・設定パターンを行順どおりに表示する",
    withAskPermissionSandbox(
      () => `
commands:
  - ".*":
      - allow: []
  - sudo:
      - ask_with_reason: []
`,
      async (_dir, sandbox) => {
        let title = "";
        await sandbox.requestCommandPermission("sudo reboot", "to restart the hung service", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            ...grantUi,
            select: async (dialogTitle, options) => {
              title = dialogTitle;
              return options[0];
            },
          },
        });
        assert.equal(
          title,
          [
            "Allow command execution?",
            "sudo reboot",
            "reason: to restart the hung service",
            'matched: {"command":"sudo","args":[]}',
          ].join("\n"),
        );
      },
    ),
  );

  it(
    "command の確認ダイアログは一致範囲を強調表示する",
    withAskPermissionSandbox(
      () => `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      async (_dir, sandbox) => {
        const dialogTitles: string[] = [];
        await sandbox.requestCommandPermission("sudo reboot", "to restart the hung service", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (title, options) => {
              dialogTitles.push(title);
              return options[1];
            },
            theme: uiTheme,
          },
        });
        assert.deepEqual(dialogTitles, [
          [
            "Allow command execution?",
            `${highlighted("sudo")} reboot`,
            "reason: to restart the hung service",
            'matched: {"command":"sudo","args":[]}',
          ].join("\n"),
        ]);
      },
    ),
  );

  it(
    "command の拒否は拒否と理由を結果として返し以降も差し戻される",
    withAskPermissionSandbox(
      () => `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      async (_dir, sandbox) => {
        const outcome = await sandbox.requestCommandPermission(
          "sudo reboot",
          "to restart the hung service",
          {
            cwd: "/cwd",
            hasUI: true,
            ui: { ...denyUi, input: async () => "not now" },
          },
        );
        assert.deepEqual(outcome, {
          status: "denied",
          command: "sudo reboot",
          reason: "not now",
        });
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("sudo reboot", {
            cwd: "/cwd",
            hasUI: true,
            ui: approvingUi,
          });
        }, /Command requires a reason: sudo reboot/);
      },
    ),
  );

  it(
    "allow コマンドはダイアログなしで許可済みを返す",
    withAskPermissionSandbox(
      () => `commands:
  - ls:
      - allow: []`,
      async (_dir, sandbox) => {
        const outcome = await sandbox.requestCommandPermission("ls -la", "to list files", {
          cwd: "/cwd",
          hasUI: true,
          ui: noDialogUi,
        });
        assert.deepEqual(outcome, { status: "already granted", command: "ls -la" });
      },
    ),
  );

  it(
    "deny コマンドは許可要求できない",
    withAskPermissionSandbox(
      () => `commands:
  - sudo:
      - deny: []`,
      async (_dir, sandbox) => {
        await assert.rejects(
          () =>
            sandbox.requestCommandPermission("sudo reboot", "to restart", {
              cwd: "/cwd",
              hasUI: true,
              ui: noDialogUi,
            }),
          /Command denied: sudo reboot/,
        );
      },
    ),
  );

  it(
    "ask_permission の Allow in this session はパターン単位のセッション承認を返す",
    withAskPermissionSandbox(
      () => `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      async (_dir, sandbox) => {
        const sessionUi = {
          confirm: async () => false,
          select: async (_title: string, options: string[]) => options[1],
          input: async () => "",
        };
        const outcome = await sandbox.requestCommandPermission(
          "sudo reboot",
          "to restart the hung service",
          { cwd: "/cwd", hasUI: true, ui: sessionUi },
        );
        assert.deepEqual(outcome, {
          status: "granted",
          command: "sudo reboot",
          grant: "session",
          approvedPattern: '{"command":"sudo","args":[]}',
        });
        // Same-pattern commands other than the approved one pass unconfirmed.
        const approved = await sandbox.authorizeCommand("sudo rm /tmp/f", {
          cwd: "/cwd",
          hasUI: true,
          ui: noDialogUi,
        });
        assert.equal(approved, true);
        // Session grants are never consumed.
        const approvedAgain = await sandbox.authorizeCommand("sudo reboot", {
          cwd: "/cwd",
          hasUI: true,
          ui: noDialogUi,
        });
        assert.equal(approvedAgain, true);
        // A later ask_permission resolves without a dialog.
        const outcomeAgain = await sandbox.requestCommandPermission(
          "sudo shutdown -h now",
          "to shut down",
          { cwd: "/cwd", hasUI: true, ui: noDialogUi },
        );
        assert.deepEqual(outcomeAgain, {
          status: "already granted",
          command: "sudo shutdown -h now",
          approvedPattern: '{"command":"sudo","args":[]}',
        });
      },
    ),
  );

  it("ask_permission ツールのコマンド承認は1回限りの実行承認を返す", async () => {
    const result = await captureRegisteredTools()
      .get("ask_permission")
      .execute(
        "t",
        { command: "sudo reboot", reason: "to restart the hung service" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: grantUi,
        },
      );
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: "User approved this command via ask_permission; re-send the same bash call to run it (one-shot).",
      },
    ]);
    assert.deepEqual(result.details, {
      status: "granted",
      command: "sudo reboot",
      grant: "once",
    });
  });

  it("ask_permission ツールのコマンド拒否は拒否と理由を結果として返す", async () => {
    const result = await captureRegisteredTools()
      .get("ask_permission")
      .execute(
        "t",
        { command: "sudo reboot", reason: "to restart the hung service" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: { ...denyUi, input: async () => "not now" },
        },
      );
    assert.deepEqual(result.content, [
      { type: "text", text: "User denied this command.\nUser reason: not now" },
    ]);
    assert.deepEqual(result.details, {
      status: "denied",
      command: "sudo reboot",
      reason: "not now",
    });
  });

  it("ask_permission ツールのセッション承認はパターン単位の許可テキストを返す", async () => {
    const result = await captureRegisteredTools()
      .get("ask_permission")
      .execute(
        "t",
        { command: "sudo reboot", reason: "to restart the hung service" },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title: string, options: string[]) => options[1],
            input: async () => "",
          },
        },
      );
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: 'User approved this command via ask_permission (in this session). Every command matching the pattern {"command":"sudo","args":[]} now runs via bash without further confirmation for the rest of the session.',
      },
    ]);
    assert.deepEqual(result.details, {
      status: "granted",
      command: "sudo reboot",
      grant: "session",
      approvedPattern: '{"command":"sudo","args":[]}',
    });
  });

  it("ask_permission ツールはセッション承認済みパターンの再リクエストを許可済みで返す", async () => {
    const execute = captureRegisteredTools().get("ask_permission").execute;
    const sessionUi = {
      confirm: async () => false,
      select: async (_title: string, options: string[]) => options[1],
      input: async () => "",
    };
    await execute(
      "t",
      { command: "sudo reboot", reason: "to restart the hung service" },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: true, ui: sessionUi },
    );
    const result = await execute(
      "t",
      { command: "sudo shutdown -h now", reason: "to shut down" },
      undefined,
      undefined,
      { cwd: process.cwd(), hasUI: true, ui: noDialogUi },
    );
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: 'No approval needed: every command matching the session-approved pattern {"command":"sudo","args":[]} runs via bash without confirmation.',
      },
    ]);
    assert.deepEqual(result.details, {
      status: "already granted",
      command: "sudo shutdown -h now",
      approvedPattern: '{"command":"sudo","args":[]}',
    });
  });

  it("ask_permission のパラメータは単一オブジェクトで reason を必須とする", () => {
    const tool = captureRegisteredTools().get("ask_permission");
    const schema = tool.parameters as {
      type?: string;
      anyOf?: unknown;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.type, "object");
    assert.equal(schema.anyOf, undefined);
    assert.ok(schema.properties?.path !== undefined);
    assert.ok(schema.properties?.command !== undefined);
    assert.deepEqual(schema.required, ["reason"]);
  });

  it("ask_permission は path と command の両方指定では排他エラーを返す", async () => {
    const tool = captureRegisteredTools().get("ask_permission");
    await assert.rejects(
      tool.execute(
        "t",
        { path: "/some/dir", command: "git push", reason: "probe" },
        undefined,
        undefined,
        { cwd: process.cwd(), hasUI: true, ui: denyUi },
      ),
      /requires exactly one of "path" or "command"/,
    );
  });

  it("ask_permission は path も command も無い呼び出しで排他エラーを返す", async () => {
    const tool = captureRegisteredTools().get("ask_permission");
    await assert.rejects(
      tool.execute("t", { reason: "probe" }, undefined, undefined, {
        cwd: process.cwd(),
        hasUI: true,
        ui: denyUi,
      }),
      /requires exactly one of "path" or "command"/,
    );
  });

  it("ツール説明と promptGuidelines は書き込み許可の境界を示す", () => {
    const tools = captureRegisteredTools();
    const permissionTool = tools.get("ask_permission");
    assert.match(permissionTool.description, /effective write action is ask or unset/i);
    assert.match(
      permissionTool.description,
      /explicit deny and credentials cannot be granted/i,
    );
    assert.match(permissionTool.description, /before edit-heavy work/i);
    assert.match(permissionTool.description, /worktree/i);
    assert.match(permissionTool.description, /exact rejected command/i);
    assert.equal(permissionTool.promptGuidelines?.length, 2);
    assert.match(
      permissionTool.promptGuidelines[0],
      /Effective write paths grouped by final action/,
    );
    assert.match(permissionTool.promptGuidelines[0], /allow needs no permission request/);
    assert.match(
      permissionTool.promptGuidelines[0],
      /ask can be requested but remains read-only through bash/,
    );
    assert.match(permissionTool.promptGuidelines[0], /deny cannot be granted/);
    assert.match(permissionTool.promptGuidelines[0], /no matching write rule can be requested/);
    assert.match(permissionTool.promptGuidelines[0], /worktree/i);
    assert.match(permissionTool.promptGuidelines[0], /creation path or parent/);
    assert.match(permissionTool.promptGuidelines[0], /Credentials override listed ancestors/);
    assert.match(
      permissionTool.promptGuidelines[0],
      /last matching rule determines each action/,
    );
    assert.match(permissionTool.promptGuidelines[1], /Command requires a reason/);
    for (const toolName of ["write", "edit"]) {
      const description = tools.get(toolName).description;
      assert.match(description, /effective action is ask or unset/);
      assert.match(
        description,
        /explicit deny and credentials paths are rejected without a prompt/i,
      );
    }
  });

  it(
    "promptGuidelines は write の実効 allow/ask/deny を示し credentials と commands を除く",
    withTempDirectory((directory) => {
      const allowedPath = join(directory, "allowed");
      const secondAllowedPath = join(directory, "second-allowed");
      const overriddenPath = join(directory, "overridden");
      const restrictedPath = join(allowedPath, "restricted");
      const deniedPath = join(directory, "denied");
      const credentialPath = join(allowedPath, "credential");
      const askCredentialPath = join(directory, "ask-credential");
      const denyCredentialPath = join(directory, "deny-credential");
      const credentialRoot = join(directory, "credential-root");
      const credentialDescendants = {
        allow: join(credentialRoot, "allow"),
        ask: join(credentialRoot, "ask"),
        deny: join(credentialRoot, "deny"),
      };
      const configPath = join(directory, "sandbox.yaml");
      writeFileSync(
        configPath,
        [
          "write:",
          `  - {allow: ${JSON.stringify(allowedPath)}}`,
          `  - {allow: ${JSON.stringify(secondAllowedPath)}}`,
          `  - {allow: ${JSON.stringify(credentialPath)}}`,
          `  - {allow: ${JSON.stringify(credentialDescendants.allow)}}`,
          `  - {ask: ${JSON.stringify(restrictedPath)}}`,
          `  - {ask: ${JSON.stringify(askCredentialPath)}}`,
          `  - {ask: ${JSON.stringify(credentialDescendants.ask)}}`,
          `  - {deny: ${JSON.stringify(deniedPath)}}`,
          `  - {deny: ${JSON.stringify(denyCredentialPath)}}`,
          `  - {deny: ${JSON.stringify(credentialDescendants.deny)}}`,
          `  - {ask: ${JSON.stringify(overriddenPath)}}`,
          `  - {allow: ${JSON.stringify(overriddenPath)}}`,
          `credentials: [${[
            credentialPath,
            askCredentialPath,
            denyCredentialPath,
            credentialRoot,
          ]
            .map((path) => JSON.stringify(path))
            .join(", ")}]`,
          `commands:
  - sudo:
      - ask_with_reason: []`,
          "",
        ].join("\n"),
      );

      const guidance =
        captureRegisteredTools(configPath).get("ask_permission").promptGuidelines[0];
      const allowSection = guidance.split("\nask:\n")[0] ?? "";
      const askSection = guidance.split("\nask:\n")[1]?.split("\ndeny:\n")[0] ?? "";
      const denySection = guidance.split("\ndeny:\n")[1] ?? "";
      assert.ok(allowSection.includes(JSON.stringify(allowedPath)));
      assert.ok(allowSection.includes(JSON.stringify(secondAllowedPath)));
      assert.ok(allowSection.includes(JSON.stringify(overriddenPath)));
      assert.ok(askSection.includes(JSON.stringify(restrictedPath)));
      assert.ok(!askSection.includes(JSON.stringify(overriddenPath)));
      assert.ok(denySection.includes(JSON.stringify(deniedPath)));
      for (const path of [
        credentialPath,
        askCredentialPath,
        denyCredentialPath,
        ...Object.values(credentialDescendants),
      ]) {
        assert.ok(!guidance.includes(JSON.stringify(path)), `credential path leaked: ${path}`);
      }
      assert.ok(!guidance.includes("sudo"));
      assert.ok(guidance.includes("The last matching rule determines each action"));
      assert.ok(guidance.includes("Credentials override listed ancestors"));
      assert.ok(guidance.includes("no matching write rule can be requested"));
      assert.match(guidance, /ask can be requested but remains read-only through bash/);
    }),
  );

  it("ask_permission のコール行とサマリー表示", () => {
    const tool = captureRegisteredTools().get("ask_permission");
    const call = renderToolCall("ask_permission", { path: join(process.cwd(), "work") });
    assert.equal(call, "ask_permission ./work");
    const commandCall = renderToolCall("ask_permission", { command: "sudo reboot" });
    assert.equal(commandCall, "ask_permission sudo reboot");
    const longCommand = `sudo systemctl restart ${"x".repeat(100)}`;
    assert.equal(
      renderToolCall("ask_permission", { command: longCommand }),
      `ask_permission ${truncateText(longCommand, ASK_PERMISSION_TARGET_PREVIEW_LIMIT)}`,
    );
    const longPath = `${"d".repeat(100)}/file.txt`;
    assert.equal(
      renderToolCall("ask_permission", { path: longPath }),
      `ask_permission ${truncateText(`./${longPath}`, ASK_PERMISSION_TARGET_PREVIEW_LIMIT)}`,
    );
    const summary = (status: string) =>
      tool
        .renderResult(
          { content: [{ type: "text", text: status }], details: { status } },
          { isPartial: false },
          plainTheme,
          { isError: false, args: {} },
        )
        .render(200)
        .join("\n")
        .trimEnd();
    assert.equal(summary("granted"), "granted");
    assert.equal(summary("denied"), "denied");
    assert.equal(summary("already granted"), "already granted");
    const summaryWithReason = tool
      .renderResult(
        {
          content: [{ type: "text", text: "denied" }],
          details: { status: "denied", reason: "not now" },
        },
        { isPartial: false },
        plainTheme,
        { isError: false, args: {} },
      )
      .render(200)
      .join("\n")
      .trimEnd();
    assert.equal(summaryWithReason, "denied — not now");
  });
});

describe("§3 ツール引数パスの正規化", () => {
  it("@・~ 付き引数は審査パスと run-tools 実行パスを一致させる", async () => {
    const authorized: { operation: string; path: string }[] = [];
    const runToolCalls: { toolName: string; params: any }[] = [];
    const originalAuthorizePath = Sandbox.prototype.authorizePath;
    const originalRunTool = Sandbox.prototype.runTool;
    Sandbox.prototype.authorizePath = async function (operation, path) {
      authorized.push({ operation, path });
    };
    Sandbox.prototype.runTool = async function (toolName, params, _options) {
      runToolCalls.push({ toolName, params });
      return { content: [{ type: "text", text: "stub" }], details: undefined };
    };
    try {
      const tools = captureRegisteredTools();
      const cases: {
        toolName: string;
        params: Record<string, unknown>;
        expectedPath: string;
      }[] = [
        {
          toolName: "read",
          params: { path: "@/abs/read-target.txt" },
          expectedPath: "/abs/read-target.txt",
        },
        {
          toolName: "write",
          params: { path: "@/abs/write-target.txt", content: "" },
          expectedPath: "/abs/write-target.txt",
        },
        {
          toolName: "edit",
          params: { path: "@/abs/edit-target.txt", edits: [] },
          expectedPath: "/abs/edit-target.txt",
        },
        {
          toolName: "grep",
          params: { pattern: "needle", path: "@/abs/grep-root" },
          expectedPath: "/abs/grep-root",
        },
        {
          toolName: "find",
          params: { pattern: "*.ts", path: "@/abs/find-root" },
          expectedPath: "/abs/find-root",
        },
        {
          toolName: "ls",
          params: { path: "@/abs/ls-root" },
          expectedPath: "/abs/ls-root",
        },
        {
          toolName: "read",
          params: { path: "~/normalized-note.txt" },
          expectedPath: join(homedir(), "normalized-note.txt"),
        },
        {
          toolName: "write",
          params: { path: "@~/normalized-note.txt", content: "" },
          expectedPath: join(homedir(), "normalized-note.txt"),
        },
      ];
      for (const testCase of cases) {
        authorized.length = 0;
        runToolCalls.length = 0;
        await tools
          .get(testCase.toolName)
          .execute("t", testCase.params, undefined, undefined, { hasUI: false });
        assert.equal(runToolCalls.length, 1, testCase.toolName);
        assert.equal(runToolCalls[0]!.toolName, testCase.toolName);
        assert.equal(
          resolve(process.cwd(), runToolCalls[0]!.params.path),
          testCase.expectedPath,
          testCase.toolName,
        );
        assert.ok(authorized.length >= 1, testCase.toolName);
        for (const entry of authorized)
          assert.equal(entry.path, testCase.expectedPath, testCase.toolName);
      }
    } finally {
      Sandbox.prototype.authorizePath = originalAuthorizePath;
      Sandbox.prototype.runTool = originalRunTool;
    }
  });

  it("正規化により ~ 付き引数は deny エントリに照合されブロックされる", async () => {
    const readTool = captureRegisteredTools().get("read");
    for (const deniedPath of ["@~/.pi/agent/auth.json", "~/.pi/agent/auth.json"]) {
      await assert.rejects(
        () =>
          readTool.execute("t", { path: deniedPath }, undefined, undefined, { hasUI: false }),
        /Access denied/,
      );
    }
  });
});

describe("§4 bash コマンドの実行結果", () => {
  it("deny エントリにマッチしないコマンドは前の allow エントリのまま", () => {
    assert.equal(
      resolveCommandAction(
        compiled([
          { action: "allow", pattern: "git", args: ["status"] },
          { action: "deny", pattern: "sudo", args: [] },
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
          { action: "allow", pattern: ".*", args: [] },
          { action: "deny", pattern: "sudo", args: [] },
        ]),
        "sudo ls",
      ),
      "deny",
    );
  });

  it("後の allow エントリが前の ask エントリを上書きする（systemctl 3分類）", () => {
    const entries = compiled([
      { action: "allow", pattern: ".*", args: [] },
      { action: "ask", pattern: "systemctl", args: [] },
      {
        action: "allow",
        pattern: "systemctl", args: ["status|list-[\\s\\S]*"],
      },
      { action: "deny", pattern: "systemctl", args: ["(reboot|poweroff|halt|shutdown)"] },
      { action: "deny", pattern: "(shutdown|reboot|poweroff|halt)", args: [] },
    ]);
    assert.equal(resolveCommandAction(entries, "systemctl status nginx"), "allow");
    assert.equal(resolveCommandAction(entries, "systemctl list-units --all"), "allow");
    assert.equal(resolveCommandAction(entries, "systemctl restart nginx"), "ask");
    assert.equal(resolveCommandAction(entries, "systemctl reboot"), "deny");
    assert.equal(resolveCommandAction(entries, "reboot"), "deny");
  });

  it(
    "ask コマンドは承認で実行される",
    withSandbox(
      `commands:
  - git:
      - ask:
          - push`,
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
            theme: uiTheme,
          },
        });
        assert.deepEqual(confirmedCommands, [
          `${`${highlighted("git")} ${highlighted("push")}`} origin main
matched: {"command":"git","args":["push"]}`,
        ]);
      },
    ),
  );

  it(
    "ask コマンドで Yes を選ぶと承認される",
    withSandbox(
      `commands:
  - git:
      - ask:
          - push`,
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
        assert.deepEqual(selectionOptions, [
          ["Allow once", "Allow in this session", "Allow in this turn", "No, deny (reason next)"],
        ]);
      },
    ),
  );

  it(
    "ask コマンドで No を選び理由を入力するとエラーメッセージに含まれる",
    withSandbox(
      `commands:
  - git:
      - ask:
          - push`,
      "/cwd",
      async (sandbox) => {
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("git push origin main", {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => false,
              select: async (_title, options) => options[options.length - 1],
              input: async () => "force push は禁止",
            },
          });
        }, /Command denied by user: git push origin main\nUser reason: force push は禁止$/);
      },
    ),
  );

  it(
    "ask コマンドで Allow in this session を選ぶと同一パターン以降は無確認で通る",
    withSandbox(
      `commands:
  - git:
      - ask:
          - push`,
      "/cwd",
      async (sandbox) => {
        const approved = await sandbox.authorizeCommand("git push origin main", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async (_title, options) => options[1],
          },
        });
        assert.equal(approved, true);
        // A same-pattern command passes without any dialog.
        const approvedAgain = await sandbox.authorizeCommand("git push origin develop", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => {
              throw new Error("unexpected dialog");
            },
            select: async () => {
              throw new Error("unexpected dialog");
            },
          },
        });
        assert.equal(approvedAgain, true);
      },
    ),
  );

  it(
    "ask コマンドの選択をキャンセルしたら理由入力のキャンセル後に理由なしで拒否される",
    withSandbox(
      `commands:
  - git:
      - ask:
          - push`,
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
      `commands:
  - git:
      - ask:
          - push`,
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
      `commands:
  - sudo:
      - deny: []`,
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
    const section = compiled([
      { action: "allow", pattern: ".*", args: [] },
      { action: "ask", pattern: "git", args: ["push"] },
      { action: "ask", pattern: "gh", args: ["pr", "create"] },
      { action: "deny", pattern: "sudo", args: [] },
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
    assert.equal(
      resolveCommandAction(section, "cat body.md | gh pr create --body-file -"),
      "ask",
    );
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
      { action: "allow", pattern: ".*", args: [] },
      { action: "ask", pattern: "gh", args: ["pr", "create"] },
    ]);
    assert.equal(
      resolveCommandAction(section, "cat << 'EOF'\ngh pr create --repo owner/repo\nEOF"),
      "allow",
    );
    assert.equal(
      resolveCommandAction(
        section,
        "cat <<-EOF\ngh pr create --repo owner/repo\nEOF\necho done",
      ),
      "allow",
    );
    assert.equal(
      resolveCommandAction(section, "echo 'gh pr create --repo owner/repo'"),
      "allow",
    );
    assert.equal(
      resolveCommandAction(section, "git status # gh pr create --repo owner/repo"),
      "allow",
    );
  });

  it("env と環境変数代入の後ろにあるコマンドを照合する", () => {
    const section = compiled([
      { action: "allow", pattern: ".*", args: [] },
      { action: "ask", pattern: "git", args: ["push"] },
      { action: "ask", pattern: "gh", args: ["pr", "create"] },
    ]);
    assert.equal(
      resolveCommandAction(section, "GH_PAGER=cat gh pr create --repo owner/repo"),
      "ask",
    );
    assert.equal(resolveCommandAction(section, "env git push -u origin main"), "ask");
  });

  it("empty commands have no executable token and default to deny", () => {
    assert.equal(
      resolveCommandAction(compiled([{ action: "allow", pattern: ".*", args: [] }]), ""),
      "deny",
    );
  });

  it("ask_with_reason は deny > ask_with_reason > ask > allow の順序を適用する", () => {
    const entries = compiled([
      { action: "allow", pattern: ".*", args: [] },
      { action: "ask", pattern: "git", args: ["push"] },
      { action: "ask_with_reason", pattern: "sudo", args: [] },
    ]);
    assert.equal(resolveCommandAction(entries, "sudo reboot"), "ask_with_reason");
    assert.equal(resolveCommandAction(entries, "git push && sudo reboot"), "ask_with_reason");
    assert.equal(resolveCommandAction(entries, "git push"), "ask");
    const withDeny = [
      ...entries,
      ...compiled([{ action: "deny", pattern: "mkfs", args: [] }]),
    ];
    assert.equal(resolveCommandAction(withDeny, "sudo reboot; mkfs /dev/sda"), "deny");
  });

  it(
    "ask_with_reason コマンドはダイアログを出さず理由必須で差し戻す",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      "/cwd",
      async (sandbox) => {
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("sudo reboot", {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => {
                throw new Error("unexpected dialog");
              },
            },
          });
        }, /Command requires a reason: sudo reboot\nThis command requires a reason\. Call ask_permission with this exact command and a reason; do not rewrite the command to bypass the gate\./);
      },
    ),
  );

  it(
    "ask_with_reason の承認は同一コマンドを1回だけ通す",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      "/cwd",
      async (sandbox) => {
        const outcome = await sandbox.requestCommandPermission(
          "sudo reboot",
          "to restart the hung service",
          { cwd: "/cwd", hasUI: true, ui: approvingUi },
        );
        assert.deepEqual(outcome, {
          status: "granted",
          command: "sudo reboot",
          grant: "once",
        });
        const approved = await sandbox.authorizeCommand("sudo reboot", {
          cwd: "/cwd",
          hasUI: true,
          ui: approvingUi,
        });
        assert.equal(approved, true);
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("sudo reboot", {
            cwd: "/cwd",
            hasUI: true,
            ui: approvingUi,
          });
        }, /Command requires a reason: sudo reboot/);
      },
    ),
  );

  it(
    "承認は引用の付け方の違いを同一コマンドとみなす",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      "/cwd",
      async (sandbox) => {
        await sandbox.requestCommandPermission(
          'sudo systemctl restart "foo bar"',
          "to restart the service",
          { cwd: "/cwd", hasUI: true, ui: approvingUi },
        );
        const approved = await sandbox.authorizeCommand("sudo systemctl restart 'foo bar'", {
          cwd: "/cwd",
          hasUI: true,
          ui: approvingUi,
        });
        assert.equal(approved, true);
      },
    ),
  );

  it(
    "承認済みコマンドの一部改変は再ゲートされる",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      "/cwd",
      async (sandbox) => {
        await sandbox.requestCommandPermission("sudo reboot", "to restart", {
          cwd: "/cwd",
          hasUI: true,
          ui: approvingUi,
        });
        await assert.rejects(async () => {
          await sandbox.authorizeCommand("sudo reboot now", {
            cwd: "/cwd",
            hasUI: true,
            ui: approvingUi,
          });
        }, /Command requires a reason: sudo reboot now/);
      },
    ),
  );

  it(
    "ask コマンドは事前承認の対象外",
    withSandbox(
      `commands:
  - git:
      - ask:
          - push`,
      "/cwd",
      async (sandbox) => {
        await assert.rejects(
          () =>
            sandbox.requestCommandPermission("git push origin main", "to publish", {
              cwd: "/cwd",
              hasUI: true,
              ui: approvingUi,
            }),
          /Command is confirmed when run via bash; no pre-approval needed: git push origin main/,
        );
      },
    ),
  );

  it(
    "ask_with_reason の許可要求は確認ダイアログを提供できない UI ではエラーになる",
    withSandbox(
      `commands:
  - .*:
      - allow: []
  - sudo:
      - ask_with_reason: []`,
      "/cwd",
      async (sandbox) => {
        await assert.rejects(
          () =>
            sandbox.requestCommandPermission("sudo reboot", "to restart", {
              cwd: "/cwd",
              hasUI: false,
            }),
          /Access requires confirmation: sudo reboot/,
        );
      },
    ),
  );

  it("bash の説明文は許可要求の境界と理由必須ゲートを示す", () => {
    const tool = captureRegisteredTools().get("bash");
    assert.match(tool.description, /effective write action is ask or unset/);
    assert.match(tool.description, /explicit deny and credentials paths cannot be granted/);
    assert.match(tool.description, /Command requires a reason/);
    assert.match(tool.description, /do not rewrite them to bypass the gate/);
  });

  it(
    "未設定コマンドはブロックされる",
    withSandbox("read: []\n", "/cwd", async (sandbox) => {
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
        writeFileSync(configPath, "read: []\nwrite: []\n");
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
      `commands:
  - git:
      - ask:
          - push`,
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

describe("§6 commands パターンの正規表現評価", () => {
  it("command and args patterns match whole tokens", () => {
    assert.equal(
      resolveCommandAction(
        compiled([{ action: "ask", pattern: "git", args: ["push"] }]),
        "git push",
      ),
      "ask",
    );
    assert.equal(
      resolveCommandAction(
        compiled([{ action: "ask", pattern: "push", args: [] }]),
        "git push",
      ),
      "deny",
    );
  });

  it("正規表現の量指定子が使え、コマンドパターンのブレース展開はしない", () => {
    const section = compiled([{ action: "allow", pattern: "a{2}", args: [] }]);
    assert.equal(resolveCommandAction(section, "aa"), "allow");
    assert.equal(resolveCommandAction(section, "a{2}"), "deny");
    assert.equal(resolveCommandAction(section, "a2"), "deny");
  });

  it("splitCommandSegments preserves token boundaries and quoted whitespace", () => {
    assert.deepEqual(splitCommandSegments("  pi chat  "), [["pi", "chat"]]);
    assert.deepEqual(splitCommandSegments("env '  pi chat  '"), [["  pi chat  "]]);
  });

  it("セグメント先頭アンカーは引用符内のパイプ+コマンド名に誤マッチしない", () => {
    const section = compiled([
      { action: "allow", pattern: ".*", args: [] },
      { action: "ask", pattern: "pi", args: [] },
    ]);
    assert.equal(resolveCommandAction(section, "rtk grep -n 'a\\|pi b' x.md"), "allow");
    assert.equal(resolveCommandAction(section, "cat x | pi 'sum'"), "ask");
    assert.equal(resolveCommandAction(section, "cat x|pi 'sum'"), "ask");
  });

  it("無効な正規表現パターンだけが無視され、無効パターンとして報告される", () => {
    const { entries, invalidPatterns } = compileCommandRuleEntries([
      { action: "allow", pattern: "*", args: [] },
      { action: "ask", pattern: "git", args: ["push"] },
      { action: "ask", pattern: "[unclosed", args: [] },
    ]);
    assert.deepEqual(invalidPatterns, [
      JSON.stringify({ command: "*", args: [] }),
      JSON.stringify({ command: "[unclosed", args: [] }),
    ]);
    assert.equal(resolveCommandAction(entries, "git push origin main"), "ask");
  });

  it("Sandbox は無効パターンを重複なしで列挙し、有効なエントリは動く", async () => {
    await withSandbox(
      `commands:
  - "*":
      - allow: []
      - allow: []
  - sudo:
      - deny: []`,
      "/cwd",
      async (sandbox) => {
        assert.deepEqual(sandbox.invalidCommandPatterns, [
          JSON.stringify({ command: "*", args: [] }),
        ]);
        await assert.rejects(
          async () =>
            sandbox.authorizeCommand("sudo ls", {
              cwd: "/cwd",
              hasUI: true,
              ui: { confirm: async () => true },
            }),
          /Command denied/,
        );
      },
    )();
  });

  it("session_start で無効パターンを warning で列挙する", () => {
    const notifications = runSessionStart(
      'commands:\n  - "*":\n      - allow: []\n  - sudo:\n      - deny: []\n',
    );
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.level, "warning");
    assert.ok(
      notifications[0]!.message.includes("command") && notifications[0]!.message.includes("*"),
      notifications[0]!.message,
    );
  });

  it("無効パターンがなければ session_start で通知しない", () => {
    const notifications = runSessionStart(`commands:
  - sudo:
      - deny: []`);
    assert.deepEqual(notifications, []);
  });
});

describe("§6 設定", () => {
  it("全セクションを読み込む", () => {
    const config = parseSandboxedToolsConfig(`read:
  - allow: "*"
write:
  - allow: .
  - deny: "**/.env"
credentials:
  - ~/.ssh
commands:
  - git:
      - allow:
          - status
  - sudo:
      - deny: []`);
    assert.deepEqual(config.read, [{ action: "allow", patterns: ["*"] }]);
    assert.deepEqual(config.write, [
      { action: "allow", patterns: ["."] },
      { action: "deny", patterns: ["**/.env"] },
    ]);
    assert.deepEqual(config.credentials, ["~/.ssh"]);
    assert.deepEqual(config.commands, [
      { action: "allow", pattern: "git", args: ["status"] },
      { action: "deny", pattern: "sudo", args: [] },
    ]);
  });

  it("各ファミリーは単一のコマンドパターンを宣言する", () => {
    const config = parseSandboxedToolsConfig(`commands:
  - git:
      - ask:
          - push
  - gh:
      - ask:
          - pr
          - create`);
    assert.deepEqual(config.commands, [
      { action: "ask", pattern: "git", args: ["push"] },
      { action: "ask", pattern: "gh", args: ["pr", "create"] },
    ]);
  });

  it("path pattern lists and credentials reject non-strings and unknown sections are errors", () => {
    assert.throws(() => parseSandboxedToolsConfig("commands: [{allow: [{command: ls}, 1, null]}]"));
    assert.throws(() => parseSandboxedToolsConfig('read: [{allow: ["*", 2]}]'));
    assert.throws(() => parseSandboxedToolsConfig("credentials: [~/.ssh, 1]\n"));
    assert.throws(() =>
      parseSandboxedToolsConfig('read: [{allow: "*"}]\ncommand: [{allow: {command: ls}}]\n'),
    );
    const config = parseSandboxedToolsConfig('read: [{allow: "*"}]');
    assert.deepEqual(config.read, [{ action: "allow", patterns: ["*"] }]);
  });

  it("commands は ask_with_reason を読み込む", () => {
    const config = parseSandboxedToolsConfig(`commands:
  - sudo:
      - ask_with_reason: []
  - chmod:
      - ask_with_reason:
          - -R`);
    assert.deepEqual(config.commands, [
      { action: "ask_with_reason", pattern: "sudo", args: [] },
      { action: "ask_with_reason", pattern: "chmod", args: ["-R"] },
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

  it("記法を満たさない config では Sandbox の構築が失敗する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sandboxed-tools-test-"));
    try {
      const configPath = join(tempDir, "config.yaml");
      writeFileSync(configPath, 'read:\n  allow: ["."]\n');
      assert.throws(
        () => new Sandbox("/cwd", configPath),
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            `sandbox.yaml (${configPath}): sandboxed-tools config schema violation: /read must be array`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("config が存在しなければ Sandbox の構築が失敗する", () => {
    const configPath = join(tmpdir(), "sandboxed-tools-missing-config", "sandbox.yaml");
    assert.throws(() => new Sandbox("/cwd", configPath), /ENOENT/);
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
      writeFileSync(configPath, `write:\n  - {allow: "${targetDir}"}\n`);
      new Sandbox("/cwd", configPath);
      assert.equal(existsSync(targetDir), true);
    }),
  );

  it(
    "実在保証に失敗した write の動的許可は bind 対象に追加しない",
    withSandboxDir(async (dir, configPath) => {
      writeFileSync(configPath, 'read:\n  - {allow: "*"}\nwrite: []\n');
      const sandbox = new Sandbox(dir, configPath);
      const failedGrantPath = join(dir, "uncreated", "file.txt");
      let confirmationCount = 0;
      const context = {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async (_title: string, _message: string) => {
            confirmationCount++;
            return true;
          },
        },
      };
      const mutableSandbox = sandbox as unknown as { ensureGrantPathExists: () => void };
      mutableSandbox.ensureGrantPathExists = () => {
        throw new Error("grant path unavailable");
      };

      await assert.rejects(
        () => sandbox.authorizePath("write", failedGrantPath, context),
        /grant path unavailable/,
      );
      await assert.rejects(
        () => sandbox.authorizePath("write", failedGrantPath, context),
        /grant path unavailable/,
      );
      assert.equal(confirmationCount, 2);
      assert.equal(sandbox.buildArgs("fs").includes(failedGrantPath), false);
    }),
  );

  it(
    "fs モードは deny ディレクトリを空ディレクトリで隠す",
    withSandboxDir((dir, configPath) => {
      const secretDir = join(dir, "secret-dir");
      mkdirSync(secretDir);
      writeFileSync(configPath, `read:\n  - {deny: "${secretDir}"}\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      const tmpfsAt = args.indexOf(secretDir);
      assert.deepEqual(args.slice(tmpfsAt - 1, tmpfsAt + 1), ["--tmpfs", secretDir]);
    }),
  );

  it(
    "fs モードは後勝ちで allow が確定したパスも deny 宣言されていれば隠す",
    withSandboxDir((dir, configPath) => {
      const secretDir = join(dir, "secret-dir");
      mkdirSync(secretDir);
      writeFileSync(
        configPath,
        `read:\n  - {deny: "${secretDir}"}\n  - {allow: "${secretDir}"}\n`,
      );
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      // The allow entry adds --ro-bind-try first, but the deny-declared mask
      // (--tmpfs) mounts later in bwrap args and therefore hides the content.
      const tmpfsAt = args.lastIndexOf(secretDir);
      assert.deepEqual(args.slice(tmpfsAt - 1, tmpfsAt + 1), ["--tmpfs", secretDir]);
    }),
  );

  it(
    "fs モードは deny ファイルを空ファイルで隠す",
    withSandboxDir((dir, configPath) => {
      const secretFile = join(dir, "secret.txt");
      writeFileSync(secretFile, "secret");
      writeFileSync(configPath, `read:\n  - {deny: "${secretFile}"}\n`);
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
    "bash モードは write の deny に確定したパスを書き込み可能 bind より後に read-only bind する",
    withSandboxDir((dir, configPath) => {
      const protectedFile = join(dir, "protected.txt");
      writeFileSync(protectedFile, "config");
      writeFileSync(
        configPath,
        `write:\n  - {allow: "${dir}"}\n  - {deny: "${protectedFile}"}\n`,
      );
      const args = new Sandbox("/cwd", configPath).buildArgs("bash");
      const writableBindAt = args.indexOf(dir);
      assert.deepEqual(args.slice(writableBindAt - 1, writableBindAt + 2), [
        "--bind-try",
        dir,
        dir,
      ]);
      const roBindAt = args.indexOf(protectedFile);
      assert.deepEqual(args.slice(roBindAt - 1, roBindAt + 1), [
        "--ro-bind-try",
        protectedFile,
      ]);
      assert.ok(roBindAt > writableBindAt, "deny re-bind must mount after the writable bind");
    }),
  );

  it(
    "fs モードは write の deny パスを bind し直さない",
    withSandboxDir((dir, configPath) => {
      const protectedFile = join(dir, "protected.txt");
      writeFileSync(protectedFile, "config");
      writeFileSync(
        configPath,
        `write:\n  - {allow: "${dir}"}\n  - {deny: "${protectedFile}"}\n`,
      );
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      assert.equal(args.includes(protectedFile), false);
    }),
  );

  it(
    "後勝ちで allow が確定したパスは read-only bind し直さない",
    withSandboxDir((dir, configPath) => {
      const allowedFile = join(dir, "allowed.txt");
      writeFileSync(allowedFile, "x");
      writeFileSync(
        configPath,
        `write:\n  - {deny: "${allowedFile}"}\n  - {allow: "${allowedFile}"}\n`,
      );
      const args = new Sandbox("/cwd", configPath).buildArgs("bash");
      const bindAt = args.indexOf(allowedFile);
      assert.deepEqual(args.slice(bindAt - 1, bindAt + 2), [
        "--bind-try",
        allowedFile,
        allowedFile,
      ]);
      assert.equal(
        args.indexOf(allowedFile, bindAt + 2),
        -1,
        "no read-only re-bind after allow",
      );
    }),
  );

  it(
    "書き込み可能 bind の対象外にある deny パスは bind しない",
    withSandboxDir((dir, configPath) => {
      const deniedFile = join(dir, "denied.txt");
      writeFileSync(deniedFile, "x");
      writeFileSync(configPath, `write:\n  - {deny: "${deniedFile}"}\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("bash");
      assert.equal(args.includes("--bind-try"), false);
      assert.equal(args.includes(deniedFile), false);
    }),
  );

  it(
    "同一パスを allow から deny へ上書きしたときは書き込み可能 bind しない",
    withSandboxDir((dir, configPath) => {
      const file = join(dir, "same.txt");
      writeFileSync(file, "x");
      writeFileSync(configPath, `write:\n  - {allow: "${file}"}\n  - {deny: "${file}"}\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("bash");
      // The file resolves to deny (§3 last-match-wins), so it never becomes a
      // writable bind; no writable ancestor exists, so no read-only re-bind
      // is needed either — bash and fs tools agree it is not writable.
      assert.equal(args.includes("--bind-try"), false);
      assert.equal(args.includes(file), false);
    }),
  );

  it(
    "後勝ちで deny に確定した allow 宣言パスは書き込み可能 bind しない",
    withSandboxDir(async (dir, configPath) => {
      const childDir = join(dir, "x", "y");
      mkdirSync(childDir, { recursive: true });
      writeFileSync(
        configPath,
        `write:\n  - {allow: "${childDir}"}\n  - {deny: "${join(dir, "x")}"}\n`,
      );
      const sandbox = new Sandbox("/cwd", configPath);
      // fs tools deny the child write (the later deny of the parent wins) …
      await assert.rejects(
        () => sandbox.authorizePath("write", join(childDir, "new.txt"), { cwd: "/cwd" }),
        /Access denied/,
      );
      // … and the bash sandbox mounts no writable bind for it either.
      const args = sandbox.buildArgs("bash");
      assert.equal(args.includes("--bind-try"), false);
      assert.equal(args.includes(childDir), false);
      assert.equal(args.includes(join(dir, "x")), false);
    }),
  );

  it(
    "後勝ちで deny に確定したパスは起動時に作成しない",
    withSandboxDir((dir, configPath) => {
      writeFileSync(
        configPath,
        `write:\n  - {allow: "${join(dir, "x", "y")}"}\n  - {deny: "${join(dir, "x")}"}\n`,
      );
      new Sandbox("/cwd", configPath);
      assert.equal(existsSync(join(dir, "x", "y")), false);
    }),
  );

  it(
    "ask に確定したパスを書き込み可能 bind より後に read-only bind する",
    withSandboxDir(async (dir, configPath) => {
      const askedFile = join(dir, "asked.txt");
      writeFileSync(askedFile, "x");
      writeFileSync(configPath, `write:\n  - {allow: "${dir}"}\n  - {ask: "${askedFile}"}\n`);
      const sandbox = new Sandbox("/cwd", configPath);
      // fs tools ask before the child write (no UI here, so confirmation
      // throws) …
      await assert.rejects(
        () => sandbox.authorizePath("write", askedFile, { cwd: "/cwd" }),
        /Access requires confirmation/,
      );
      // … and the bash sandbox keeps it read-only behind the allowed parent.
      const args = sandbox.buildArgs("bash");
      const writableBindAt = args.indexOf(dir);
      assert.deepEqual(args.slice(writableBindAt - 1, writableBindAt + 2), [
        "--bind-try",
        dir,
        dir,
      ]);
      const roBindAt = args.indexOf(askedFile);
      assert.deepEqual(args.slice(roBindAt - 1, roBindAt + 1), ["--ro-bind-try", askedFile]);
      assert.ok(roBindAt > writableBindAt, "ask re-bind must mount after the writable bind");
    }),
  );

  it(
    "ask に確定したパスへの動的許可があっても read-only bind が後勝ちする",
    withSandboxDir(async (dir, configPath) => {
      const askedFile = join(dir, "asked.txt");
      writeFileSync(askedFile, "x");
      writeFileSync(
        configPath,
        `read:\n  - {allow: "*"}\nwrite:\n  - {allow: "${dir}"}\n  - {ask: "${askedFile}"}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      await sandbox.authorizePath("write", askedFile, {
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async () => false,
          select: async (_title, options) => options[0],
        },
      });
      const args = sandbox.buildArgs("bash");
      const grantBindAt = args.indexOf(askedFile);
      assert.deepEqual(args.slice(grantBindAt - 1, grantBindAt + 2), [
        "--bind-try",
        askedFile,
        askedFile,
      ]);
      const roBindAt = args.indexOf(askedFile, grantBindAt + 2);
      assert.deepEqual(args.slice(roBindAt - 1, roBindAt + 1), ["--ro-bind-try", askedFile]);
      assert.ok(roBindAt > grantBindAt, "ask re-bind must win over the dynamic grant bind");
    }),
  );

  it(
    "動的許可の配下でも write の deny パスは read-only bind する",
    withSandboxDir(async (dir, configPath) => {
      const protectedFile = join(dir, "protected.txt");
      writeFileSync(protectedFile, "x");
      writeFileSync(
        configPath,
        `read:\n  - {allow: "*"}\nwrite:\n  - {deny: "${protectedFile}"}\n`,
      );
      const sandbox = new Sandbox(dir, configPath);
      await sandbox.authorizePath("write", join(dir, "note.txt"), {
        cwd: dir,
        hasUI: true,
        ui: { confirm: async () => true, select: async (_title, options) => options[1] },
      });
      const args = sandbox.buildArgs("bash");
      const grantBindAt = args.indexOf(dir);
      assert.deepEqual(args.slice(grantBindAt - 1, grantBindAt + 2), ["--bind-try", dir, dir]);
      const roBindAt = args.indexOf(protectedFile);
      assert.deepEqual(args.slice(roBindAt - 1, roBindAt + 1), [
        "--ro-bind-try",
        protectedFile,
      ]);
      assert.ok(roBindAt > grantBindAt, "deny re-bind must mount after the dynamic grant bind");
    }),
  );

  it(
    "write の glob deny は展開先を実体として read-only bind する",
    withSandboxDir((dir, configPath) => {
      writeFileSync(join(dir, "a.yaml"), "x");
      writeFileSync(join(dir, "b.txt"), "x");
      writeFileSync(
        configPath,
        `write:\n  - {allow: "${dir}"}\n  - {deny: "${join(dir, "*.yaml")}"}\n`,
      );
      const args = new Sandbox("/cwd", configPath).buildArgs("bash");
      const yamlFile = join(dir, "a.yaml");
      const roBindAt = args.indexOf(yamlFile);
      assert.deepEqual(args.slice(roBindAt - 1, roBindAt + 1), ["--ro-bind-try", yamlFile]);
      assert.equal(args.includes(join(dir, "b.txt")), false);
    }),
  );

  it(
    'read.allow "*" はルート全体を read-only bind する',
    withSandboxDir((_dir, configPath) => {
      writeFileSync(configPath, `read:\n  - {allow: "*"}\n`);
      const args = new Sandbox("/cwd", configPath).buildArgs("fs");
      const rootBindAt = args.indexOf("/");
      assert.deepEqual(args.slice(rootBindAt - 1, rootBindAt + 2), ["--ro-bind", "/", "/"]);
      const procMountAt = args.indexOf("--proc");
      assert.ok(
        procMountAt > rootBindAt,
        "the fresh proc mount must remain visible over the root bind",
      );
      assert.deepEqual(args.slice(procMountAt, procMountAt + 2), ["--proc", "/proc"]);
    }),
  );

  it(
    "bash sandbox は WSL の GPU デバイスを dev bind する",
    withSandboxDir((_dir, configPath) => {
      writeFileSync(configPath, `read:\n  - {allow: "*"}\n`);
      const sandbox = new Sandbox("/cwd", configPath);
      const bashArgs = sandbox.buildArgs("bash");
      const devAt = bashArgs.indexOf("--dev");
      assert.deepEqual(bashArgs.slice(devAt, devAt + 8), [
        "--dev",
        "/dev",
        "--dev-bind-try",
        "/dev/dxg",
        "/dev/dxg",
        "--dev-bind-try",
        "/dev/dri",
        "/dev/dri",
      ]);
      const fsArgs = sandbox.buildArgs("fs");
      assert.equal(fsArgs.includes("/dev/dxg"), false);
      assert.equal(fsArgs.includes("/dev/dri"), false);
    }),
  );

  it(
    "cwd の read-only bind は write.allow の writable bind より前に出る",
    withSandboxDir((dir, configPath) => {
      writeFileSync(configPath, `write:\n  - {allow: "${dir}"}\n`);
      const args = new Sandbox(dir, configPath).buildArgs("fs");
      const roBindAt = args.indexOf(dir);
      assert.deepEqual(args.slice(roBindAt - 1, roBindAt + 1), ["--ro-bind-try", dir]);
      const writableBindAt = args.indexOf(dir, roBindAt + 2);
      assert.deepEqual(args.slice(writableBindAt - 1, writableBindAt + 1), ["--bind-try", dir]);
      assert.ok(
        writableBindAt > roBindAt,
        "writable bind must mount after the cwd read-only bind",
      );
      assert.equal(
        args.indexOf("--ro-bind-try", writableBindAt),
        -1,
        "no read-only bind may shadow the writable bind",
      );
    }),
  );

  it("cwd の read-only bind は write の動的許可より前に出る", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandboxed-tools-bind-"));
    try {
      const configPath = join(dir, "config.yaml");
      writeFileSync(configPath, "write: []\n");
      const sandbox = new Sandbox(dir, configPath);
      await sandbox.authorizePath("write", join(dir, "note.txt"), {
        cwd: dir,
        hasUI: true,
        ui: { confirm: async () => true },
      });
      const args = sandbox.buildArgs("fs");
      const roBindAt = args.indexOf(dir);
      assert.deepEqual(args.slice(roBindAt - 1, roBindAt + 1), ["--ro-bind-try", dir]);
      const notePath = join(dir, "note.txt");
      const grantBindAt = args.indexOf(notePath);
      assert.deepEqual(args.slice(grantBindAt - 1, grantBindAt + 1), ["--bind-try", notePath]);
      assert.ok(
        grantBindAt > roBindAt,
        "dynamic grant must mount after the cwd read-only bind",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("§7 bash の stderr 逐次表示", () => {
  it("stderr 行を onUpdate へ逐次流し、最終結果は完了時に一度に返る", async () => {
    const envelope = JSON.stringify({
      ok: true,
      result: { content: [{ type: "text", text: "final output" }] },
    });
    // Simulate a slow run-tools child: delayed stderr lines (one split across
    // chunks, one empty) and the JSON envelope on stdout only at completion.
    // bwrap is not usable in every test environment, so replace Sandbox.run's
    // child spawn; runTool and the bash execute stay real.
    const childScript = [
      "echo one >&2",
      "sleep 0.3",
      "printf par >&2",
      "sleep 0.1",
      "printf 'tial\\n' >&2",
      "echo >&2",
      "sleep 0.3",
      "echo two >&2",
      `printf '%s\\n' '${envelope}'`,
    ].join("; ");
    const sandboxPrototype = Sandbox.prototype as unknown as {
      run: (command: string, commandArgs: string[], options: any) => Promise<unknown>;
    };
    const originalRun = sandboxPrototype.run;
    sandboxPrototype.run = function (_command, _commandArgs, runOptions) {
      return new Promise((resolveRun, rejectRun) => {
        const child = spawn("bash", ["-c", childScript], { stdio: ["ignore", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
          runOptions.onData?.(chunk, "stdout");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
          runOptions.onData?.(chunk, "stderr");
        });
        child.on("error", rejectRun);
        child.on("close", (exitCode) =>
          resolveRun({
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          }),
        );
      });
    };
    try {
      const updates: { text: string; at: number }[] = [];
      const result = await captureRegisteredTools()
        .get("bash")
        .execute(
          "t",
          { command: "simulated slow command" },
          undefined,
          (partial: any) =>
            updates.push({ text: partial.content[0]?.text ?? "", at: Date.now() }),
          { hasUI: false },
        );
      assert.deepEqual(
        updates.map((update) => update.text),
        ["one", "partial", "two"],
      );
      assert.ok(
        updates[2]!.at - updates[0]!.at >= 200,
        `stderr lines must stream during execution (gap: ${updates[2]!.at - updates[0]!.at}ms)`,
      );
      assert.equal(result.content[0].text, "final output");
    } finally {
      sandboxPrototype.run = originalRun;
    }
  });

  it("実行中の表示は直近の stderr 行、無ければ Running... になる", () => {
    const bashTool = captureRegisteredTools().get("bash");
    const renderPartial = (result: unknown): string =>
      bashTool
        .renderResult(result, { isPartial: true }, plainTheme, {})
        .render(200)
        .join("\\n")
        .trimEnd();
    assert.equal(renderPartial({ content: [] }), "Running...");
    assert.equal(renderPartial({ content: [{ type: "text", text: "one" }] }), "one");
  });

  it("実コマンドの stderr が行単位で onUpdate へ流れ、最終結果は envelope から一度に返る", async () => {
    // Full chain without bwrap (unavailable in every test environment):
    // replace Sandbox.run's bwrap spawn with a direct bun spawn of run-tools,
    // keeping runTool, execute, and parseRunToolsResponse real. Inside
    // run-tools the real pi bash definition runs the command with the stderr
    // tee commandPrefix, so the command's stderr reaches this process's
    // stderr only through the new forwarding path.
    const sandboxPrototype = Sandbox.prototype as unknown as {
      run: (command: string, commandArgs: string[], options: any) => Promise<unknown>;
    };
    const originalRun = sandboxPrototype.run;
    sandboxPrototype.run = function (_command, _commandArgs, runOptions) {
      return new Promise((resolveRun, rejectRun) => {
        const child = spawn(_command, _commandArgs, {
          cwd: process.cwd(),
          env: runOptions.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
          runOptions.onData?.(chunk, "stdout");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
          runOptions.onData?.(chunk, "stderr");
        });
        child.on("error", rejectRun);
        child.on("close", (exitCode) =>
          resolveRun({
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          }),
        );
        child.stdin?.end(runOptions.input);
      });
    };
    try {
      // Delayed stderr with a multibyte line split across two chunks, an empty
      // line, and a trailing partial line without a newline.
      const updates: { text: string; at: number }[] = [];
      const result = await captureRegisteredTools()
        .get("bash")
        .execute(
          "t",
          {
            command:
              "echo first >&2; sleep 0.3; printf '進' >&2; sleep 0.15; printf '行中\\n' >&2; printf '\\n' >&2; echo done; printf 'tail' >&2",
          },
          undefined,
          (partial: any) =>
            updates.push({ text: partial.content[0]?.text ?? "", at: Date.now() }),
          { hasUI: false },
        );
      assert.deepEqual(
        updates.map((update) => update.text),
        ["first", "進行中"],
      );
      assert.ok(
        updates[1]!.at - updates[0]!.at >= 200,
        `stderr lines must stream during execution (gap: ${updates[1]!.at - updates[0]!.at}ms)`,
      );
      // pi's accumulator interleaves stdout and stderr chunks in arrival
      // order, so characters of a stderr line may be separated by stdout in
      // the final text (e.g. "進done\n行中"); assert per-character presence
      // for the result and keep the reassembly check on onUpdate, which sees
      // the stderr stream alone.
      const finalText = result.content[0].text;
      assert.ok(finalText.includes("done"), `stdout missing from result: ${finalText}`);
      assert.ok(finalText.includes("first"), `stderr missing from result: ${finalText}`);
      assert.ok(finalText.includes("進"), `split multibyte broken in result: ${finalText}`);
      assert.ok(finalText.includes("行中"), `split multibyte broken in result: ${finalText}`);
      assert.ok(finalText.includes("tail"), `partial tail missing from result: ${finalText}`);
    } finally {
      sandboxPrototype.run = originalRun;
    }
  });

  it("falls back after a refused receiver connection and preserves the command result", async () => {
    // Close the receiver before the command's /dev/tcp connection attempt.
    const tee = await startStderrTeeReceiver();
    await tee.close();
    const pi = await import("@earendil-works/pi-coding-agent");
    const runBash = (options: { commandPrefix: string } | undefined) =>
      pi
        .createBashToolDefinition(process.cwd(), options)
        .execute(
          "t",
          { command: "echo out; echo err >&2; exit 7" },
          undefined,
          undefined,
          undefined as unknown as ExtensionToolContext,
        );
    const fallbackResult = await runBash({ commandPrefix: tee.commandPrefix });
    const plainResult = await runBash(undefined);
    assert.equal(fallbackResult.isError, true);
    assert.equal((fallbackResult.structuredContent as { exit_code: number }).exit_code, 7);
    assert.equal(plainResult.isError, true);
    assert.equal((plainResult.structuredContent as { exit_code: number }).exit_code, 7);
    const fallbackTextContent = fallbackResult.content.find(
      (content) => content.type === "text",
    );
    const plainTextContent = plainResult.content.find((content) => content.type === "text");
    assert.ok(fallbackTextContent);
    assert.ok(plainTextContent);
    const fallbackText = fallbackTextContent.text;
    const plainText = plainTextContent.text;
    for (const resultText of [fallbackText, plainText]) {
      assert.ok(resultText.includes("out"), `stdout missing from result: ${resultText}`);
      assert.ok(resultText.includes("err"), `stderr missing from result: ${resultText}`);
      assert.ok(resultText.includes("Command exited with code 7"), resultText);
    }
    // pi's accumulator interleaves stdout and stderr in arrival order, so
    // compare the output as an unordered set of lines.
    const messageLines = (message: string) =>
      message
        .split("\n")
        .filter((line) => line !== "")
        .sort();
    assert.deepEqual(messageLines(fallbackText), messageLines(plainText));
  });
});

describe("§7 WSL の子プロセス PATH", () => {
  it("WSL の Windows PATH だけを除外し、他の PATH と入力環境を保つ", () => {
    const originalPath = [
      "/nix/profile/bin",
      "/mnt/c/Windows/System32",
      "/home/user/bin",
      "/home/user/rtk/bin",
      "/mnt/d/Program Files/tool",
      "/mnt/data/bin",
    ].join(delimiter);
    const environment = { PATH: originalPath, WSL_INTEROP: "/run/interop" };

    const sanitized = sanitizeSandboxEnvironment(environment, "6.8.0-generic");

    assert.equal(
      sanitized.PATH,
      ["/nix/profile/bin", "/home/user/bin", "/home/user/rtk/bin", "/mnt/data/bin"].join(
        delimiter,
      ),
    );
    assert.equal(environment.PATH, originalPath);
  });

  it("WSL でない Linux の /mnt PATH は除外しない", () => {
    const environment = { PATH: ["/mnt/c/tools", "/mnt/data/bin", "/usr/bin"].join(delimiter) };

    assert.equal(isWslEnvironment(environment, "6.8.0-generic"), false);
    assert.equal(
      sanitizeSandboxEnvironment(environment, "6.8.0-generic").PATH,
      environment.PATH,
    );
  });

  it("WSL kernel marker でも Windows PATH を除外する", () => {
    const environment = { PATH: ["/mnt/c/tools", "/usr/bin"].join(delimiter) };

    assert.equal(isWslEnvironment(environment, "5.15.153.1-microsoft-standard-WSL2"), true);
    assert.equal(
      sanitizeSandboxEnvironment(environment, "5.15.153.1-microsoft-standard-WSL2").PATH,
      "/usr/bin",
    );
  });
});

describe("§7 sandbox 実行の同時数の上限", () => {
  /**
   * Replace Sandbox.runSandboxProcess (the semaphore-gated run() delegates
   * here) with a counting stub; restore via the return value. The stub
   * records call start order and peak concurrency, then delegates the
   * outcome to `behavior` per call index.
   */
  const stubCountingRun = (behavior: (callIndex: number) => Promise<unknown>) => {
    const sandboxPrototype = Sandbox.prototype as unknown as {
      runSandboxProcess: (
        command: string,
        commandArgs: string[],
        options: any,
      ) => Promise<unknown>;
    };
    const originalRun = sandboxPrototype.runSandboxProcess;
    let active = 0;
    let maxActive = 0;
    let callIndex = 0;
    const startOrder: number[] = [];
    sandboxPrototype.runSandboxProcess = function () {
      const index = callIndex++;
      startOrder.push(index);
      active++;
      maxActive = Math.max(maxActive, active);
      return behavior(index).finally(() => {
        active--;
      });
    };
    return {
      maxActive: () => maxActive,
      resetMaxActive: () => {
        maxActive = 0;
      },
      startOrder: () => startOrder,
      restore: () => {
        sandboxPrototype.runSandboxProcess = originalRun;
      },
    };
  };

  const okEnvelope = () =>
    Buffer.from(
      JSON.stringify({ ok: true, result: { content: [{ type: "text", text: "done" }] } }),
    );
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it(
    "並行 runTool の同時 sandbox 実行は最大4で、開始順に実行され全呼び出しが完了する",
    withSandbox("read: []\nwrite: []\n", process.cwd(), async (sandbox) => {
      const stub = stubCountingRun(async () => {
        await delay(60);
        return { exitCode: 0, stdout: okEnvelope(), stderr: Buffer.alloc(0) };
      });
      try {
        const results = await Promise.all(
          Array.from({ length: 6 }, (_unused, i) =>
            sandbox.runTool("read", { path: `/tmp/concurrent-${i}.txt` }, { mode: "fs" }),
          ),
        );
        assert.equal(results.length, 6);
        for (const result of results)
          assert.equal((result.content[0] as { text: string } | undefined)?.text, "done");
        assert.equal(stub.maxActive(), 4);
        assert.deepEqual(stub.startOrder(), [0, 1, 2, 3, 4, 5]);
      } finally {
        stub.restore();
      }
    }),
  );

  it(
    "sandbox 実行が失敗しても待機中の呼び出しが開始される",
    withSandbox("read: []\nwrite: []\n", process.cwd(), async (sandbox) => {
      const stub = stubCountingRun((index) =>
        index === 0
          ? Promise.reject(new Error("boom"))
          : delay(30).then(() => ({
              exitCode: 0,
              stdout: okEnvelope(),
              stderr: Buffer.alloc(0),
            })),
      );
      try {
        const settled = await Promise.allSettled(
          Array.from({ length: 6 }, (_unused, i) =>
            sandbox.runTool("read", { path: `/tmp/fail-release-${i}.txt` }, { mode: "fs" }),
          ),
        );
        assert.match(String((settled[0] as PromiseRejectedResult).reason), /boom/);
        for (const outcome of settled.slice(1)) assert.equal(outcome.status, "fulfilled");
        assert.equal(stub.maxActive(), 4);
        assert.deepEqual(stub.startOrder(), [0, 1, 2, 3, 4, 5]);
      } finally {
        stub.restore();
      }
    }),
  );

  it(
    "続く2度目の並行バッチでも同時実行は最大4を維持する",
    withSandbox("read: []\nwrite: []\n", process.cwd(), async (sandbox) => {
      const stub = stubCountingRun(async () => {
        await delay(50);
        return { exitCode: 0, stdout: okEnvelope(), stderr: Buffer.alloc(0) };
      });
      const runBatch = () =>
        Promise.all(
          Array.from({ length: 6 }, (_unused, i) =>
            sandbox.runTool("read", { path: `/tmp/wave-${i}.txt` }, { mode: "fs" }),
          ),
        );
      try {
        await runBatch();
        assert.equal(stub.maxActive(), 4);
        stub.resetMaxActive();
        await runBatch();
        assert.equal(
          stub.maxActive(),
          4,
          "second batch must keep the full cap (no leftover slot accounting)",
        );
      } finally {
        stub.restore();
      }
    }),
  );

  it(
    "Sandbox インスタンスが違っても同時実行はプロセス全体で最大4",
    withSandbox("read: []\nwrite: []\n", process.cwd(), async (sandbox) => {
      const other = new Sandbox(process.cwd());
      const stub = stubCountingRun(async () => {
        await delay(50);
        return { exitCode: 0, stdout: okEnvelope(), stderr: Buffer.alloc(0) };
      });
      try {
        const results = await Promise.all([
          ...Array.from({ length: 3 }, (_unused, i) =>
            sandbox.runTool("read", { path: `/tmp/multi-a-${i}.txt` }, { mode: "fs" }),
          ),
          ...Array.from({ length: 3 }, (_unused, i) =>
            other.runTool("read", { path: `/tmp/multi-b-${i}.txt` }, { mode: "fs" }),
          ),
        ]);
        assert.equal(results.length, 6);
        assert.equal(stub.maxActive(), 4);
      } finally {
        stub.restore();
      }
    }),
  );
});

describe("§8 表示", () => {
  it("read の成功サマリーは画像のとき image input、エラーは先頭3行", () => {
    const tool = captureRegisteredTools().get("read");
    const summary = tool
      .renderResult(
        { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
        { isPartial: false },
        plainTheme,
        { isError: false, args: {} },
      )
      .render(200)
      .join("\n")
      .trimEnd();
    assert.equal(summary, "image input");

    const errorResult = {
      content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\n" }],
    };
    const renderedError = tool
      .renderResult(errorResult, { isPartial: false }, plainTheme, {
        isError: true,
        args: {},
      })
      .render(200)
      .map((line: string) => line.trimEnd())
      .join("\n");
    assert.equal(renderedError, "line 1\nline 2\nline 3\n…");
  });

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

    for (const toolName of [
      "ask_permission",
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]) {
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

  it("長いコマンドを300文字に切り詰める", () => {
    const longCommand = "a".repeat(COMMAND_PREVIEW_LIMIT + 1);
    assert.equal(truncateText(longCommand).length, COMMAND_PREVIEW_LIMIT);
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

describe("turn command approvals", () => {
  const turnConfig = `commands:
  - git:
      - ask: [push]
      - ask: [fetch]
  - sudo:
      - ask_with_reason: []
`;
  const turnUi = {
    confirm: async () => false,
    select: async () => "Allow in this turn",
  };
  const noUi = { cwd: "/cwd", hasUI: false };

  for (const route of ["bash", "permission"] as const) {
    function request(sandbox: Sandbox, context: Parameters<Sandbox["authorizeCommand"]>[1]) {
      return route === "bash"
        ? sandbox.authorizeCommand("git push origin main", context)
        : sandbox.requestCommandPermission("sudo reboot", "restart", context);
    }

    it(
      `${route} reuses its pattern until expiry and keeps other patterns gated`,
      withSandbox(turnConfig, "/cwd", async (sandbox) => {
        await request(sandbox, { cwd: "/cwd", hasUI: true, ui: turnUi });
        const command = route === "bash" ? "git push origin develop" : "sudo shutdown";
        assert.equal(await sandbox.authorizeCommand(command, noUi), true);
        assert.equal(await sandbox.authorizeCommand(command, noUi), true);
        await assert.rejects(async () => sandbox.authorizeCommand("git fetch", noUi));
        sandbox.expireTurnCommandApprovals();
        await assert.rejects(async () => sandbox.authorizeCommand(command, noUi));
      }),
    );

    it(
      `${route} rejects a turn answer that crosses expiry`,
      withSandbox(turnConfig, "/cwd", async (sandbox) => {
        const shown = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<string>();
        const pending = request(sandbox, {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async () => {
              shown.resolve();
              return answer.promise;
            },
          },
        });
        await shown.promise;
        sandbox.expireTurnCommandApprovals();
        answer.resolve("Allow in this turn");
        if (route === "bash") await assert.rejects(async () => pending, /Turn approval expired/);
        else
          assert.deepEqual(await pending, {
            status: "denied",
            command: "sudo reboot",
            reason: "Turn approval expired. Request approval again.",
          });
        await assert.rejects(async () =>
          sandbox.authorizeCommand(route === "bash" ? "git push" : "sudo reboot", noUi),
        );
      }),
    );

    it(
      `${route} rejects turn approval after waiting for the UI lock`,
      withSandbox(turnConfig, "/cwd", async (sandbox) => {
        const shown = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<string>();
        const blocker = sandbox.authorizeCommand("git fetch", {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async () => {
              shown.resolve();
              return answer.promise;
            },
          },
        });
        await shown.promise;
        const pending = request(sandbox, { cwd: "/cwd", hasUI: true, ui: turnUi });
        sandbox.expireTurnCommandApprovals();
        answer.resolve("Allow once");
        await blocker;
        if (route === "bash") await assert.rejects(async () => pending, /Turn approval expired/);
        else assert.equal(((await pending) as { status: string }).status, "denied");
      }),
    );

    it(
      `${route} rechecks approvals granted while waiting for the UI lock`,
      withSandbox(turnConfig, "/cwd", async (sandbox) => {
        const shown = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<string>();
        let dialogs = 0;
        const context = {
          cwd: "/cwd",
          hasUI: true,
          ui: {
            confirm: async () => false,
            select: async () => {
              dialogs++;
              shown.resolve();
              return answer.promise;
            },
          },
        };
        const first = request(sandbox, context);
        await shown.promise;
        const second = request(sandbox, context);
        answer.resolve("Allow in this turn");
        await Promise.all([first, second]);
        assert.equal(dialogs, 1);
      }),
    );

    for (const choice of ["Allow once", "Allow in this session"]) {
      it(
        `${route} preserves ${choice} answers across user input`,
        withSandbox(turnConfig, "/cwd", async (sandbox) => {
          const shown = Promise.withResolvers<void>();
          const answer = Promise.withResolvers<string>();
          const pending = request(sandbox, {
            cwd: "/cwd",
            hasUI: true,
            ui: {
              confirm: async () => false,
              select: async () => {
                shown.resolve();
                return answer.promise;
              },
            },
          });
          await shown.promise;
          sandbox.expireTurnCommandApprovals();
          answer.resolve(choice);
          const outcome = await pending;
          if (route === "bash") assert.equal(outcome, true);
          else assert.equal((outcome as { status: string }).status, "granted");
          if (choice === "Allow in this session") {
            sandbox.expireTurnCommandApprovals();
            assert.equal(
              await sandbox.authorizeCommand(route === "bash" ? "git push" : "sudo reboot", noUi),
              true,
            );
          }
        }),
      );
    }
  }

  it(
    "keeps multiple turn patterns and session grants independent",
    withSandbox(turnConfig, "/cwd", async (sandbox) => {
      await sandbox.authorizeCommand("git push", { cwd: "/cwd", hasUI: true, ui: turnUi });
      await sandbox.authorizeCommand("git fetch", { cwd: "/cwd", hasUI: true, ui: turnUi });
      await sandbox.requestCommandPermission("sudo reboot", "restart", {
        cwd: "/cwd",
        hasUI: true,
        ui: { confirm: async () => false, select: async () => "Allow in this session" },
      });
      assert.equal(await sandbox.authorizeCommand("git push", noUi), true);
      assert.equal(await sandbox.authorizeCommand("git fetch", noUi), true);
      sandbox.expireTurnCommandApprovals();
      await assert.rejects(async () => sandbox.authorizeCommand("git push", noUi));
      await assert.rejects(async () => sandbox.authorizeCommand("git fetch", noUi));
      assert.equal(await sandbox.authorizeCommand("sudo shutdown", noUi), true);
    }),
  );

  const expiryEvents = [
    ["input", { source: "interactive", text: "next" }],
    ["input", { source: "rpc", text: "next", streamingBehavior: "steer" }],
    ["input", { source: "extension", text: "next", streamingBehavior: "followUp" }],
    ["message_start", { message: { role: "user", content: "next" } }],
    ["session_start", {}],
    ["session_shutdown", {}],
  ] as const;
  for (const [eventName, event] of expiryEvents) {
    it(
      `expires through ${eventName} ${JSON.stringify(event)}`,
      withTempDirectory(async (directory) => {
        const configPath = join(directory, "sandbox.yaml");
        writeFileSync(configPath, turnConfig);
        const handlers = new Map<string, (event: any, context?: any) => unknown>();
        const execute = captureRegisteredTools(configPath, handlers).get("ask_permission").execute;
        const params = { command: "sudo reboot", reason: "restart" };
        const granted = await execute("t", params, undefined, undefined, {
          cwd: directory,
          hasUI: true,
          ui: turnUi,
        });
        assert.equal(granted.details.grant, "turn");
        assert.match(granted.content[0].text, /until the next user message/);
        const already = await execute("t", params, undefined, undefined, noUi);
        assert.equal(already.details.grant, "turn");
        assert.match(already.content[0].text, /turn-approved pattern/);
        assert.ok(handlers.has(eventName));
        await handlers.get(eventName)!(event, { ui: { notify() {} } });
        await assert.rejects(
          async () => execute("t", params, undefined, undefined, noUi),
          /Access requires confirmation/,
        );
      }),
    );
  }

  it(
    "expires again when queued user input is delivered, but not during tool turns",
    withTempDirectory(async (directory) => {
      const configPath = join(directory, "sandbox.yaml");
      writeFileSync(configPath, turnConfig);
      const handlers = new Map<string, (event: any, context?: any) => unknown>();
      const execute = captureRegisteredTools(configPath, handlers).get("ask_permission").execute;
      const params = { command: "sudo reboot", reason: "restart" };
      await handlers.get("input")!({ source: "rpc", streamingBehavior: "followUp" });
      await execute("t", params, undefined, undefined, { cwd: directory, hasUI: true, ui: turnUi });
      for (const role of ["assistant", "toolResult"])
        await handlers.get("message_start")!({ message: { role } });
      handlers.get("turn_start")?.({});
      handlers.get("turn_end")?.({});
      assert.equal((await execute("t", params, undefined, undefined, noUi)).details.grant, "turn");
      await handlers.get("message_start")!({ message: { role: "user" } });
      await assert.rejects(
        async () => execute("t", params, undefined, undefined, noUi),
        /Access requires confirmation/,
      );
    }),
  );
});
