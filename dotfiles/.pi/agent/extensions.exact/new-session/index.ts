import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const NEW_SESSION_COMMAND_NAME = "new-session";
export const NEW_SESSION_ALIAS = "ns";

export default function newSessionExtension(pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const draftMessage = args.trim();

    await ctx.newSession({
      withSession: async (newSessionContext) => {
        if (draftMessage) {
          newSessionContext.ui.setEditorText(draftMessage);
        }
      },
    });
  };

  pi.registerCommand(NEW_SESSION_COMMAND_NAME, {
    description:
      "Start a clean new session. An optional argument is placed in the new session's editor as a draft.",
    handler,
  });
  pi.registerCommand(NEW_SESSION_ALIAS, {
    description:
      "Start a clean new session. An optional argument is placed in the new session's editor as a draft.",
    handler,
  });
}
