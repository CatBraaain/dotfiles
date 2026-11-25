import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { parseGuardrailConfig, resolvePathAction } from "./config.ts";
import { writePaths } from "./sandbox.ts";

const DIRECTORY = "GUARDRAILS_TEST_ENV_DIRECTORY";
const SEGMENT = "GUARDRAILS_TEST_ENV_SEGMENT";
const VARIABLES = ["WSL_DISTRO_NAME", DIRECTORY, SEGMENT];

const linuxDirectory = "/tmp/guardrails-linux";
const windowsDirectory = "/mnt/c/Users/Guardrails";
const directoryPattern = `\${${DIRECTORY}}`;
const segmentPattern = `\${${SEGMENT}}`;

function resolveRules(
  rules: object[],
  readWindowsEnvironment: (names: readonly string[]) => ReadonlyMap<string, string>,
) {
  const config = parseGuardrailConfig(JSON.stringify({ write: rules }), readWindowsEnvironment);
  return writePaths(config, "/tmp", new Map());
}

describe.skipIf(process.platform !== "linux")("WSL write.allow environment variables", () => {
  let previous: Map<string, string | undefined>;

  beforeEach(() => {
    previous = new Map(VARIABLES.map((name) => [name, process.env[name]]));
    process.env.WSL_DISTRO_NAME = "GuardrailsTest";
    delete process.env[DIRECTORY];
    delete process.env[SEGMENT];
  });

  afterEach(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("keeps both complete candidates in the original rule position", () => {
    process.env[DIRECTORY] = linuxDirectory;
    process.env[SEGMENT] = "local";
    const section = resolveRules(
      [
        { ask: "/mnt" },
        { allow: `${directoryPattern}/${segmentPattern}` },
        { deny: `${windowsDirectory}/remote/blocked` },
      ],
      (names) => {
        assert.deepEqual(names, [DIRECTORY, SEGMENT]);
        return new Map([
          [DIRECTORY, windowsDirectory],
          [SEGMENT, "remote"],
        ]);
      },
    );
    assert.deepEqual(section[1]?.paths, [`${linuxDirectory}/local`, `${windowsDirectory}/remote`]);
    assert.equal(resolvePathAction(section, `${windowsDirectory}/remote/file`), "allow");
    assert.equal(resolvePathAction(section, `${windowsDirectory}/remote/blocked`), "deny");
    assert.equal(resolvePathAction(section, `${windowsDirectory}/sibling`), "ask");
  });

  it("does not combine variables from different environments", () => {
    process.env[DIRECTORY] = linuxDirectory;
    const section = resolveRules(
      [{ allow: `${directoryPattern}/${segmentPattern}` }],
      () => new Map([[SEGMENT, "remote"]]),
    );
    assert.deepEqual(section[0]?.paths, []);
  });

  it("uses the Windows candidate when the Linux value is empty", () => {
    process.env[DIRECTORY] = "";
    const section = resolveRules(
      [{ allow: `${directoryPattern}/pi-work` }],
      () => new Map([[DIRECTORY, windowsDirectory]]),
    );
    assert.deepEqual(section[0]?.paths, [`${windowsDirectory}/pi-work`]);
  });

  it("retains the Linux candidate if the Windows lookup fails", () => {
    process.env[DIRECTORY] = linuxDirectory;
    const section = resolveRules([{ allow: directoryPattern }], () => {
      throw new Error("Windows interop unavailable");
    });
    assert.deepEqual(section[0]?.paths, [linuxDirectory]);
  });

  it("deduplicates normalized paths within the rule without changing rule precedence", () => {
    process.env[DIRECTORY] = windowsDirectory;
    const section = resolveRules(
      [{ allow: directoryPattern }, { deny: windowsDirectory }, { allow: directoryPattern }],
      () => new Map([[DIRECTORY, `${windowsDirectory}/.`]]),
    );
    assert.deepEqual(section[0]?.paths, [windowsDirectory]);
    assert.deepEqual(section[2]?.paths, [windowsDirectory]);
    assert.equal(resolvePathAction(section, windowsDirectory), "allow");
  });

  it("reads only environment variables in write.allow and keeps their values literal", () => {
    const config = parseGuardrailConfig(
      JSON.stringify({
        read: [{ deny: "/${GUARDRAILS_READ_TEST_VARIABLE}" }],
        write: [
          { ask: "/${GUARDRAILS_ASK_TEST_VARIABLE}" },
          { allow: `${directoryPattern}/\${REPOSITORY_NAME}` },
        ],
        credentials: ["/${GUARDRAILS_CREDENTIAL_TEST_VARIABLE}"],
      }),
      (names) => {
        assert.deepEqual(names, [DIRECTORY]);
        return new Map([[DIRECTORY, `${windowsDirectory}/[name]`]]);
      },
    );
    assert.deepEqual(writePaths(config, "/tmp", new Map())[1]?.paths, [
      `${windowsDirectory}/[name]/tmp`,
    ]);
  });
});
