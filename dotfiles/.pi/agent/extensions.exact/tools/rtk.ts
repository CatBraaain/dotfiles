import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { Type } from "typebox";
import { Value } from "typebox/value";

const REWRITE_TIMEOUT_SECONDS = 2;
const rewriteOutputSchema = Type.Object({
  output: Type.String(),
  exit_code: Type.Union([Type.Literal(0), Type.Literal(3)]),
  truncated: Type.Literal(false),
});

export async function rewriteBashCommand(
  command: string,
  context: Pick<ExtensionToolContext, "executeTool">,
  signal?: AbortSignal,
): Promise<string> {
  if (
    command.trim() === "" ||
    command.startsWith("rtk ") ||
    process.env.RTK_DISABLED === "1" ||
    signal?.aborted ||
    typeof context?.executeTool !== "function"
  )
    return command;

  try {
    const outcome = await context.executeTool(
      "bash",
      {
        command: `${quote(["rtk", "rewrite", command])} 2>/dev/null`,
        timeout: REWRITE_TIMEOUT_SECONDS,
      },
      { signal },
    );
    if (signal?.aborted) return command;
    const output = outcome.result.structuredContent;
    if (!Value.Check(rewriteOutputSchema, output)) return command;
    if ((outcome.isError || outcome.result.isError) && output.exit_code !== 3) return command;
    return output.output.trim() || command;
  } catch (error) {
    console.warn("[rtk] rewrite failed; passing through command", error);
    return command;
  }
}
