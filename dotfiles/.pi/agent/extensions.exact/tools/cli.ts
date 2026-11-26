import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTURE_SCRIPT = fileURLToPath(new URL("./cli-capture.ts", import.meta.url));
const RECOVERY_CHUNK_BYTES = 524_288;
export type CliResponse = { result: AgentToolResult<unknown>; isError: boolean };
export type CliOutcome =
  | ({ status: "completed"; cli: CliResult } & CliResponse)
  | ({ status: "failed"; error: unknown } & Partial<CliResponse>)
  | ({ status: "aborted"; reason: unknown } & Partial<CliResponse>);
export type CliParams = {
  executable: string;
  args: readonly string[];
  cwd?: string;
  timeout?: number;
};
export type CliResult = { stdout: string; stderr: string; code: number };

export class CliFailure extends Error {
  constructor(
    message: string,
    readonly response: CliResponse | undefined,
    readonly diagnostic: { reason?: unknown; error?: unknown } = {},
  ) {
    super(message);
  }
  get toolResult(): AgentToolResult<unknown> {
    return {
      content: [{ type: "text", text: this.message }],
      isError: true,
      details: { bash: this.response, ...this.diagnostic },
    };
  }
}

export function quoteShell(argument: string): string {
  if (argument.includes("\0")) throw new Error("CLI argument contains a NUL byte");
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}

export function cliExecutableName(name: string, platform = process.platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

export function bashPath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function isGitBashPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

function recoveryPath(path: unknown, platform: NodeJS.Platform): string {
  if (typeof path === "string" && !path.includes("\0")) {
    if (platform !== "win32" && path.startsWith("/")) return path;
    if (platform === "win32") {
      const shellPath = bashPath(path, platform);
      const windowsAbsolute = /^(?:[a-z]:\/|\/\/(?![?.]\/)[^/]+\/[^/]+\/)/i.test(shellPath);
      if ((path.startsWith("/") && isGitBashPath(shellPath)) || windowsAbsolute) return shellPath;
    }
  }
  throw new Error("Truncated registered bash output has no valid full_output_path");
}

export function quoteWindowsArgument(argument: string): string {
  return argument
    .split(/(?<=\\)(?=\\)/)
    .map((part) => part.split("\r").map(quoteShell).join("$'\\r'"))
    .join("");
}

export function buildWindowsCliInvocation(executable: string, args: readonly string[]): string {
  const command = quoteShell(bashPath(executable, "win32"));
  return ["MSYS2_ARG_CONV_EXCL='*'", command, ...args.map(quoteWindowsArgument)].join(" ");
}

function captureCommand(
  platform: NodeJS.Platform,
  mode: "create" | "cleanup" | "frame" | "size" | "read",
  ...args: string[]
): string {
  const invocationArgs = [
    "--no-install",
    "--no-env-file",
    "--cwd",
    bashPath(dirname(CAPTURE_SCRIPT), platform),
    bashPath(CAPTURE_SCRIPT, platform),
    mode,
    ...args,
  ];
  if (platform !== "win32") return ["bun", ...invocationArgs.map(quoteShell)].join(" ");
  const path = mode === "size" || mode === "read" ? args[0] : undefined;
  const argConversionExclusion = path && isGitBashPath(path) ? "" : "*";
  return [
    `MSYS2_ARG_CONV_EXCL='${argConversionExclusion}'`,
    "bun",
    ...invocationArgs.map(quoteWindowsArgument),
  ].join(" ");
}

export function createCliCommand(params: CliParams, platform = process.platform): string {
  const invocation =
    platform === "win32"
      ? buildWindowsCliInvocation(params.executable, params.args)
      : [params.executable, ...params.args].map(quoteShell).join(" ");
  const cleanup = captureCommand(platform, "cleanup") + ' "$cli_tmp"';
  return [
    ...(params.cwd === undefined
      ? []
      : [`cd -- ${quoteShell(bashPath(params.cwd, platform))} || exit`]),
    `cli_tmp=$(${captureCommand(platform, "create")}) || exit`,
    `trap ${quoteShell(cleanup)} EXIT`,
    "cli_code=0",
    `${invocation} >"$cli_tmp/stdout" 2>"$cli_tmp/stderr" || cli_code=$?`,
    captureCommand(platform, "frame") + ' "$cli_tmp" "$cli_code"',
  ].join("\n");
}

export function parseCliOutput(output: string): CliResult {
  const frame = /^PI_CLI_V1:(\d+)\n([A-Za-z0-9+/=]*)\n([A-Za-z0-9+/=]*)\nPI_CLI_END\n$/.exec(
    output,
  );
  if (!frame) throw new Error("Registered bash returned an invalid CLI output frame");
  const code = Number(frame[1]);
  if (!Number.isInteger(code) || code < 0 || code > 255)
    throw new Error("Registered bash returned an invalid CLI exit code");
  return { code, stdout: decodeStream(frame[2]!), stderr: decodeStream(frame[3]!) };
}

function decodeStream(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Invalid CLI stream encoding");
  return bytes.toString("utf8");
}

export async function runCliViaBash(request: {
  context: Pick<ExtensionToolContext, "executeTool">;
  params: CliParams;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
}): Promise<CliOutcome> {
  const platform = request.platform ?? process.platform;
  let received: Partial<CliResponse> = {};
  let firstResponse: Partial<CliResponse> = {};
  async function execute(command: string) {
    received = firstResponse;
    request.signal?.throwIfAborted();
    const outcome = await request.context.executeTool(
      "bash",
      {
        command,
        ...(request.params.timeout === undefined ? {} : { timeout: request.params.timeout }),
      },
      { signal: request.signal },
    );
    received = { result: outcome.result, isError: outcome.isError };
    request.signal?.throwIfAborted();
    if (!outcome.result || !Array.isArray(outcome.result.content))
      throw new Error("Invalid registered Bash result");
    const bash = outcome.result.structuredContent as
      | { output?: unknown; truncated?: unknown; exit_code?: unknown; full_output_path?: unknown }
      | undefined;
    if (outcome.isError || outcome.result.isError)
      throw new Error(resultText(outcome.result) ?? "Registered bash failed");
    if (
      !bash ||
      typeof bash.output !== "string" ||
      typeof bash.truncated !== "boolean" ||
      typeof bash.exit_code !== "number"
    )
      throw new Error("Registered bash returned invalid structured output");
    if (bash.exit_code !== 0) throw new Error(`Registered bash exited with code ${bash.exit_code}`);
    return {
      response: { result: outcome.result, isError: outcome.isError },
      output: bash.output,
      truncated: bash.truncated,
      full_output_path: bash.full_output_path,
    };
  }
  try {
    const first = await execute(createCliCommand(request.params, platform));
    request.signal?.throwIfAborted();
    firstResponse = first.response;
    let output = first.output;
    if (first.truncated) {
      const path = recoveryPath(first.full_output_path, platform);
      const sizeResult = await execute(captureCommand(platform, "size", path));
      const sizeText = sizeResult.output.trim();
      const sizeBytes = Number(sizeText);
      if (
        sizeResult.truncated ||
        !/^\d+$/.test(sizeText) ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes <= 0
      )
        throw new Error("Registered bash returned an invalid full output size");
      const chunks: string[] = [];
      for (let offsetBytes = 0; offsetBytes < sizeBytes; offsetBytes += RECOVERY_CHUNK_BYTES) {
        const expectedBytes = Math.min(RECOVERY_CHUNK_BYTES, sizeBytes - offsetBytes);
        const chunk = await execute(
          captureCommand(platform, "read", path, String(offsetBytes), String(expectedBytes)),
        );
        if (chunk.truncated || Buffer.byteLength(chunk.output, "utf8") !== expectedBytes)
          throw new Error("Registered bash full output recovery was truncated or incomplete");
        chunks.push(chunk.output);
      }
      output = chunks.join("");
    }
    received = first.response;
    request.signal?.throwIfAborted();
    return {
      status: "completed",
      ...first.response,
      cli: parseCliOutput(output),
    };
  } catch (error) {
    return request.signal?.aborted
      ? { status: "aborted", reason: request.signal.reason, ...received }
      : { status: "failed", error, ...received };
  }
}

function resultText(result: AgentToolResult<unknown>): string | undefined {
  return result.content?.find((block) => block.type === "text")?.text?.trim() || undefined;
}
