import { describe, expect, it } from "vitest";
import { sessionStatePath, resolveAgentDir, resolveSessionDir } from "../src/paths";

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

  it("places the session state store at <agentDir>/session-state.json", () => {
    expect(sessionStatePath("/custom/agent")).toBe("/custom/agent/session-state.json");
  });
});
