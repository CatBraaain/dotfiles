import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { translateTools } from "./tool-allowlist.ts";

const known = new Set([
  "read",
  "write",
  "edit",
  "read_image",
  "glob",
  "grep",
  "bash",
  "web_search",
  "web_fetch",
  "subagent",
  "subagent_fork",
]);

describe("translateTools", () => {
  it('leaves ["*"] unrestricted', () => {
    assert.deepEqual(translateTools(["*"], known), { filter: undefined, skipped: [] });
  });

  it('translates ["*", "!x"] to a deny list', () => {
    const result = translateTools(["*", "!subagent_fork"], known);
    assert.deepEqual(result.filter, { deny: ["subagent_fork"] });
    assert.deepEqual(result.skipped, []);
  });

  it("translates a pure allowlist to an allow list", () => {
    const result = translateTools(["web_search", "web_fetch"], known);
    assert.deepEqual(result.filter, { allow: ["web_search", "web_fetch"] });
  });

  it("keeps negations beside an explicit allowlist", () => {
    const result = translateTools(["web_search", "!read"], known);
    assert.deepEqual(result.filter, { allow: ["web_search"], deny: ["read"] });
  });

  it("drops names unknown to the registry and reports them", () => {
    const result = translateTools(["*", "!handoff_session"], known);
    assert.deepEqual(result.filter, undefined);
    assert.deepEqual(result.skipped, ["handoff_session"]);
  });

  it("drops unknown names from an allowlist, keeping the known remainder", () => {
    const result = translateTools(["web_search", "handoff_session"], known);
    assert.deepEqual(result.filter, { allow: ["web_search"] });
    assert.deepEqual(result.skipped, ["handoff_session"]);
  });

  it("returns an unrestricted filter when an allowlist is entirely unknown", () => {
    const result = translateTools(["handoff_session"], known);
    assert.deepEqual(result.filter, undefined);
    assert.deepEqual(result.skipped, ["handoff_session"]);
  });

  it("falls back to deny-only when only denials are known", () => {
    const result = translateTools(["handoff_session", "!read"], known);
    assert.deepEqual(result.filter, { deny: ["read"] });
    assert.deepEqual(result.skipped, ["handoff_session"]);
  });

  it("treats an empty list as unrestricted (nothing restrictable)", () => {
    const result = translateTools([], known);
    assert.deepEqual(result, { filter: undefined, skipped: [] });
  });
});
