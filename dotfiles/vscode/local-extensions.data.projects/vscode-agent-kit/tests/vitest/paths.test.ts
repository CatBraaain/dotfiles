import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAgentDir, resolveConfiguredSessionRoot, resolveSessionDir } from "../../src/paths";
import { cleanup, tempDir } from "./fixtures";

describe("directory resolution", () => {
  it("defaults to ~/.pi/agent and <agentDir>/sessions", () => {
    expect(resolveAgentDir({}, "/home/user")).toBe("/home/user/.pi/agent");
    expect(resolveSessionDir({}, "/home/user")).toBe("/home/user/.pi/agent/sessions");
  });

  it("honors PI_CODING_AGENT_DIR", () => {
    const env = { PI_CODING_AGENT_DIR: "/custom/agent" };
    expect(resolveAgentDir(env, "/home/user")).toBe("/custom/agent");
    expect(resolveSessionDir(env, "/home/user")).toBe("/custom/agent/sessions");
  });

  it.each([
    ["~", "/home/user"],
    ["~/", "/home/user"],
    ["~/custom-agent", "/home/user/custom-agent"],
    ["custom-agent", "/extension-host/custom-agent"],
    ["../custom-agent", "/custom-agent"],
  ])("normalizes agent directory %s for settings and default sessions", (input, expected) => {
    const env = { PI_CODING_AGENT_DIR: input };
    expect(resolveAgentDir(env, "/home/user", "/extension-host")).toBe(expected);
    expect(resolveSessionDir(env, "/home/user", "/extension-host")).toBe(
      join(expected, "sessions"),
    );
  });

  it("resolves relative agent directories from the host cwd by default", () => {
    const env = { PI_CODING_AGENT_DIR: "custom-agent" };
    expect(resolveAgentDir(env, "/home/user")).toBe(join(process.cwd(), "custom-agent"));
  });

  it("honors PI_CODING_AGENT_SESSION_DIR independently", () => {
    const env = { PI_CODING_AGENT_SESSION_DIR: "/custom/sessions" };
    expect(resolveSessionDir(env, "/home/user")).toBe("/custom/sessions");
    expect(resolveAgentDir(env, "/home/user")).toBe("/home/user/.pi/agent");
  });

  it("treats empty-string env values as unset (pi truthiness semantics)", () => {
    const env = { PI_CODING_AGENT_DIR: "", PI_CODING_AGENT_SESSION_DIR: "" };
    expect(resolveAgentDir(env, "/home/user")).toBe("/home/user/.pi/agent");
    expect(resolveSessionDir(env, "/home/user")).toBe("/home/user/.pi/agent/sessions");
  });
});

describe("resolveConfiguredSessionRoot", () => {
  let home: string;
  let agent: string;
  let project: string;

  beforeEach(async () => {
    home = await tempDir("pi-root-home-");
    agent = join(home, ".pi", "agent");
    project = join(home, "project");
    await mkdir(join(agent), { recursive: true });
    await mkdir(join(project, ".pi"), { recursive: true });
  });

  afterEach(async () => {
    await cleanup(home);
  });

  async function writeSettings(path: string, text: string): Promise<void> {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, text, "utf8");
  }

  describe.each([
    [undefined, ".pi/agent"],
    ["", ".pi/agent"],
    ["~", "."],
    ["~/", "."],
    ["~/custom-agent", "custom-agent"],
    ["custom-agent", "project/custom-agent"],
    ["../custom-agent", "custom-agent"],
  ])("with agent directory %s", (input, directory) => {
    it("uses the normalized agent directory for default sessions", async () => {
      const expected = join(home, directory, "sessions");
      const actual = await resolveConfiguredSessionRoot(
        { PI_CODING_AGENT_DIR: input },
        home,
        project,
      );
      expect(actual).toBe(expected);
    });

    it("reads sessionDir from normalized agent settings and preserves precedence", async () => {
      const env = { PI_CODING_AGENT_DIR: input };
      await writeSettings(
        join(home, directory, "settings.json"),
        JSON.stringify({ sessionDir: "~/agent-history" }),
      );
      expect(await resolveConfiguredSessionRoot(env, home, project)).toBe(
        join(home, "agent-history"),
      );
      await writeSettings(
        join(project, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: "project-history" }),
      );
      expect(await resolveConfiguredSessionRoot(env, home, project)).toBe(
        join(project, "project-history"),
      );
      expect(
        await resolveConfiguredSessionRoot(
          { ...env, PI_CODING_AGENT_SESSION_DIR: "env-history" },
          home,
          project,
        ),
      ).toBe(join(project, "env-history"));
    });
  });

  it("prefers PI_CODING_AGENT_SESSION_DIR over settings and expands ~", async () => {
    await writeSettings(
      join(agent, "settings.json"),
      JSON.stringify({ sessionDir: "/from/settings" }),
    );
    expect(
      await resolveConfiguredSessionRoot(
        { PI_CODING_AGENT_SESSION_DIR: "~/sessions" },
        home,
        project,
      ),
    ).toBe(join(home, "sessions"));
  });

  it("prefers the project sessionDir over agent settings and then the default", async () => {
    await writeSettings(
      join(agent, "settings.json"),
      JSON.stringify({ sessionDir: "/from/agent" }),
    );
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe("/from/agent");
    await writeSettings(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: "/from/project" }),
    );
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe("/from/project");
    await writeSettings(join(project, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe("/from/agent");
    await writeSettings(join(agent, "settings.json"), JSON.stringify({}));
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe(join(agent, "sessions"));
  });

  it("resolves relative sessionDir values and file URLs from the invocation cwd", async () => {
    await writeSettings(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: "history" }),
    );
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe(join(project, "history"));
    await writeSettings(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: pathToFileURL(join(project, "url-root")).href }),
    );
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe(join(project, "url-root"));
  });

  it("treats an empty env value as unset and reads settings instead", async () => {
    await writeSettings(
      join(agent, "settings.json"),
      JSON.stringify({ sessionDir: "/from/agent" }),
    );
    expect(
      await resolveConfiguredSessionRoot({ PI_CODING_AGENT_SESSION_DIR: "" }, home, project),
    ).toBe("/from/agent");
  });

  it("parses JSONC comments and trailing commas like the CLI settings reader", async () => {
    await writeSettings(
      join(agent, "settings.json"),
      `{
        // stored outside the default tree
        "sessionDir": "/jsonc/root",
      }`,
    );
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe("/jsonc/root");
  });

  it.each([
    "/tmp/history,}",
    "/tmp/history,]",
    '/tmp/escaped-quote-"-and-,}',
    "/tmp/backslash-\\-and-,]",
    "/tmp/history//literal/*literal*/end,}",
  ])("preserves JSONC string content: %s", async (sessionDir) => {
    await writeSettings(
      join(agent, "settings.json"),
      `{
        /* ignored outside strings */
        "other": ["literal,}", "literal,]",],
        "sessionDir": ${JSON.stringify(sessionDir)}, // trailing comma
      }`,
    );
    expect(await resolveConfiguredSessionRoot({}, home, project)).toBe(
      resolve(project, sessionDir),
    );
  });

  it("fails on invalid settings or a non-string sessionDir", async () => {
    await writeSettings(join(agent, "settings.json"), "{ invalid");
    await expect(resolveConfiguredSessionRoot({}, home, project)).rejects.toThrow(/settings/);
    await writeSettings(join(agent, "settings.json"), JSON.stringify({ sessionDir: 5 }));
    await expect(resolveConfiguredSessionRoot({}, home, project)).rejects.toThrow(/sessionDir/);
  });
});
