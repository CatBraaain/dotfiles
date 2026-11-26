import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { Operation } from "./cli-arguments";
import { type Config, prepareDirectory, type TmuxConfig } from "./configuration";
import { InitialRequestFiles } from "./initial-request-files";
import { createNew, openSaved, resolveSaved } from "./launch-session";
import { windowsClaimLock, withLock } from "./locks";
import { promoteSession } from "./pane-inventory";
import { platform } from "./platform";
import { snapshotSessions, startAndRestore, type WindowsBootstrap } from "./restoration";
import { registerWorkspaces, SnapshotReadError } from "./restore-state";
import { configuredSessionRoot, rememberSessionRoot } from "./saved-sessions";
import { errorMessage, type Pane } from "./session-model";
import { windowsManagement } from "./tmux";
import { switchSession, switchWindowsNewClient } from "./tmux-clients";

type SessionStartOperation = Extract<Operation, { kind: "new" | "open" | "restore" }>;

export async function startSession(
  config: Config,
  operation: SessionStartOperation,
): Promise<number> {
  if (operation.kind === "new" && operation.cwd !== undefined) {
    if (!statSync(operation.cwd).isDirectory())
      throw new Error(`Workspace is not a directory: ${operation.cwd}`);
    process.chdir(operation.cwd);
  }
  const result = await withLock(config, async () => {
    prepareDirectory(config.directory);
    if (operation.kind === "new") {
      if (platform.windows || process.platform === "linux") InitialRequestFiles.sweep(config);
      const preferred = await configuredSessionRoot(config);
      if (preferred) rememberSessionRoot(config, preferred);
    }
    let temporaryTarget: string | undefined;
    let bootstrap: WindowsBootstrap = "start";
    if (operation.kind === "open" && operation.temporary) {
      const selected = await resolveSaved(config, operation.id);
      if (!selected.running && !selected.managed) temporaryTarget = operation.id;
      if (platform.windows) bootstrap = selected.windowsBasis ?? "fresh";
    }
    const { failures, basis } = await startAndRestore(
      config,
      operation.kind === "restore",
      temporaryTarget,
      bootstrap,
    );
    if (operation.kind === "restore") return failures > 0 ? 2 : 0;
    const management = basis ? windowsManagement(config) : undefined;
    const target =
      operation.kind === "open"
        ? await openSaved(config, operation.id, operation.temporary ? "temporary" : "normal", basis)
        : await createNew(config, operation.request, basis);
    if (management && basis) await management.assertLive(basis);
    if (operation.kind === "open") {
      try {
        if (management && target.startup === "ready") {
          if (!basis || !management.startupState(basis)?.restored)
            throw new Error("Cannot verify the Windows pi-mux startup state");
          if (management.startupState(basis)?.restoring.includes(target.id.toLowerCase()))
            await management.clearRestoring(basis, target.id, windowsClaimLock(management));
        }
        if (!operation.temporary) await promoteSession(config, target.session, target.id);
        await snapshotSessions(config, basis?.instance, "repair");
      } catch (error) {
        if (!(error instanceof SnapshotReadError))
          throw new Error(`Cannot update open session ${operation.id}: ${errorMessage(error)}`);
      }
    }
    try {
      registerWorkspaces(config, [target.cwd]);
    } catch (error) {
      if (!(error instanceof SnapshotReadError)) throw error;
      console.error(`pi-mux: workspace registration deferred: ${errorMessage(error)}`);
    }
    rememberSessionRoot(config, dirname(target.file));
    if (management && basis) await management.assertLive(basis);
    const clientPid = operation.kind === "new" ? operation.clientPid : undefined;
    if (operation.detached || clientPid !== undefined) {
      if (clientPid !== undefined) {
        if (platform.windows) {
          if (!management || !basis)
            throw new Error("Missing Windows pi-mux management generation");
          await switchWindowsNewClient(config, target, clientPid, management, basis);
        } else await switchSession(config, target.id, clientPid);
      }
      printDetachedSession(config, target);
      return 0;
    }
    return target;
  });
  if (typeof result === "number") return result;
  const client = Bun.spawn(attachCommand(config, result), {
    env: config.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await client.exited;
}

export function printDetachedSession(config: TmuxConfig, target: Pane): void {
  const attach = platform.quoteCommand(attachCommand(config, target));
  console.log(`Pi session ${target.id}\nAttach with: ${attach}`);
}

function attachCommand(config: TmuxConfig, target: Pane): string[] {
  const sessionTarget = platform.windows ? `=${target.name}` : target.session;
  return [config.tmux, "-S", config.socket, "attach-session", "-t", sessionTarget];
}
