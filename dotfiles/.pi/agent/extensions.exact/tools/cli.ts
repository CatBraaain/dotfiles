import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
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

function bashPath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function quoteRecoveryPath(path: unknown, platform: NodeJS.Platform): string {
  if (typeof path === "string" && !path.includes("\0")) {
    const shellPath = bashPath(path, platform);
    if (platform !== "win32" && path.startsWith("/")) return quoteShell(path);
    if (platform === "win32") {
      const posixAbsolute = path.startsWith("/") && !shellPath.startsWith("//");
      const windowsAbsolute = /^(?:[a-z]:\/|\/\/(?![?.]\/)[^/]+\/[^/]+\/)/i.test(shellPath);
      if (posixAbsolute || windowsAbsolute) return quoteShell(shellPath);
    }
  }
  throw new Error("Truncated registered bash output has no valid full_output_path");
}

function quoteWindowsArgument(argument: string): string {
  return argument
    .split(/(?<=\\)(?=\\)/)
    .map(quoteShell)
    .join("");
}

export function createCliCommand(params: CliParams, platform = process.platform): string {
  const quoteArgument = platform === "win32" ? quoteWindowsArgument : quoteShell;
  const executable = bashPath(params.executable, platform);
  const invocation = [quoteShell(executable), ...params.args.map(quoteArgument)].join(" ");
  const argConversion = platform === "win32" ? "MSYS2_ARG_CONV_EXCL='*' " : "";
  const tempTemplate = platform === "win32" ? "-t pi-cli.XXXXXXXXXX" : "/tmp/pi-cli.XXXXXXXXXX";
  return [
    "set -o pipefail",
    ...(params.cwd === undefined
      ? []
      : [`cd -- ${quoteShell(bashPath(params.cwd, platform))} || exit`]),
    `cli_tmp=$(mktemp -d ${tempTemplate}) || exit`,
    "trap 'rm -rf -- \"$cli_tmp\"' EXIT",
    "cli_code=0",
    `${argConversion}${invocation} >"$cli_tmp/stdout" 2>"$cli_tmp/stderr" || cli_code=$?`,
    "printf 'PI_CLI_V1:%s\\n' \"$cli_code\"",
    "base64 <\"$cli_tmp/stdout\" | tr -d '\\n' || exit",
    "printf '\\n'",
    "base64 <\"$cli_tmp/stderr\" | tr -d '\\n' || exit",
    "printf '\\nPI_CLI_END\\n'",
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
      const quotedPath = quoteRecoveryPath(first.full_output_path, platform);
      const sizeResult = await execute(`wc -c < ${quotedPath}`);
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
        const chunk = await execute(
          `dd if=${quotedPath} bs=${RECOVERY_CHUNK_BYTES} skip=${offsetBytes / RECOVERY_CHUNK_BYTES} count=1 status=none`,
        );
        const expectedBytes = Math.min(RECOVERY_CHUNK_BYTES, sizeBytes - offsetBytes);
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
