import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "bun:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import toolsExtension from "./index.ts";

it.skipIf(process.platform !== "win32")(
  "hides the direct PowerShell tool and uses the shipped Bash policy",
  async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-windows-shell-"));
    const environment = { PI_OFFLINE: "1", RTK_DISABLED: "1" };
    const saved = Object.keys(environment).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, environment);
    try {
      const config = join(agentDir, "guardrails.json");
      const shipped = parse(
        readFileSync(
          new URL("../../../../.agents/config.exact/guardrails.yaml", import.meta.url),
          "utf8",
        ),
      );
      writeFileSync(config, JSON.stringify({ commands: shipped.commands }));
      const cwd = process.cwd();
      const settingsManager = SettingsManager.inMemory({});
      const resourceLoader = new DefaultResourceLoader({
        agentDir,
        cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [(pi) => toolsExtension(pi, config)],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const { session } = await createAgentSession({
        agentDir,
        cwd,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
      });
      try {
        await session.bindExtensions({});
        const tools = session.getAllTools();
        assert.equal(tools.find((tool) => tool.name === "powershell")?.exposure, "hidden");
        session.setActiveToolsByName(tools.map((tool) => tool.name));
        assert.equal(session.getActiveToolNames().includes("powershell"), false);
        assert.equal(session.getCallableToolNames().includes("powershell"), false);
        const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
        assert.ok(bash);
        const normal = await bash.execute("ordinary", { command: "git --version" });
        assert.notEqual(normal.isError, true);
        assert.match(JSON.stringify(normal.content), /git version .*windows/i);
        const result = await bash.execute("powershell", {
          command: `powershell.exe -NoProfile -NonInteractive -Command "Write-Output 'guardrails-windows-ok'"`,
        });
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result.content), /guardrails-windows-ok/);
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(agentDir, { recursive: true, force: true });
    }
  },
  45_000,
);
