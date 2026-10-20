import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { isCamoufoxServerCommand } from "./backends";

describe("isCamoufoxServerCommand", () => {
  const scriptPath = "/opt/cli/browse";
  const serverSubcommand = "__server";

  it("matches the compiled-binary command line [executable, __server]", () => {
    const args = [scriptPath, serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), true);
  });

  it("matches the source-run command line [bun, script, __server]", () => {
    const args = ["/usr/bin/bun", scriptPath, serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), true);
  });

  it("matches a compiled-binary command line with extra args", () => {
    const args = [scriptPath, serverSubcommand, "--flag"];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), true);
  });

  it("rejects a different subcommand", () => {
    const args = [scriptPath, "search"];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), false);
  });

  it("rejects a different script path", () => {
    const args = ["/elsewhere/browse", serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), false);
  });

  it("rejects the source form when the script path differs", () => {
    const args = ["/usr/bin/bun", "/elsewhere/browse", serverSubcommand];
    assert.equal(isCamoufoxServerCommand(args, scriptPath, serverSubcommand), false);
  });

  it("rejects an empty command line", () => {
    assert.equal(isCamoufoxServerCommand([], scriptPath, serverSubcommand), false);
  });
});
