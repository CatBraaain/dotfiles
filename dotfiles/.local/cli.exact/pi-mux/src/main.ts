import { realpathSync, statSync } from "node:fs";
import { parseOperation } from "./cli-arguments";
import {
  configuration,
  prepareDirectory,
  resolveAgentDirectory,
  tmuxConfiguration,
} from "./configuration";
import { inspectSession, launchDispatchedTicket, openExactSession } from "./launch-session";
import {
  mergeSessionLists,
  renderActiveTable,
  renderHistoryTable,
  renderTable,
  renderUnifiedTable,
} from "./list-output";
import { LockBusyError, withLock } from "./locks";
import { platform } from "./platform";
import { reloadPanes } from "./reload";
import { snapshotSessions } from "./restoration";
import { registerWorkspaces } from "./restore-state";
import { historySessions, readSessionMetadata } from "./saved-sessions";
import { serverLifecycle } from "./server-lifecycle";
import { listWorkspaces } from "./session-list";
import { sendSessionMessage, sendViewReceipt } from "./session-message";
import { sessionMetadata, SessionMetadataCache } from "./session-metadata";
import { errorMessage } from "./session-model";
import { closeSession, unregisterWorkspace } from "./session-removal";
import { printDetachedSession, startSession } from "./session-start";
import { notifyState } from "./state-notification";
import { windowsManagement } from "./tmux";
import { displayedSessions, SwitchResolutionError, switchSession } from "./tmux-clients";
import {
  claimWindowsLaunch,
  createWindowsDispatchWorker,
  auditWindowsDispatchInventory,
} from "./windows-launch";
import { claimWindowsReload } from "./windows-reload";
import { getWorktreeSnapshot } from "./worktree-snapshot";

export { parseOperation };
export { firstInputDirectory } from "./pane-inventory";
export type { StateSource } from "./pane-state";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const operation = parseOperation(argv);
    if (operation.kind === "help") {
      console.log(`Usage:
  pi-mux
  pi-mux -h | --help
  pi-mux new [--detached] [--client-pid <pid>] [--cwd <absolute-cwd>] [initial-request]
  pi-mux open [--temporary] [--detached] <session-id>
  pi-mux open --detached --expect-file <absolute-jsonl-path> <session-id>
  pi-mux inspect <session-id>
  pi-mux metadata <session-id>
  pi-mux state <session-id> <state> --source <JSON> --title <JSON>
  pi-mux state <session-id> --clear --source <JSON>
  pi-mux send [--wait <seconds>] <session-id> <text...>
  pi-mux close [--if-temporary] <session-id>
  pi-mux list [--json]
  pi-mux list --active [--json]
  pi-mux list --saved [--cwd <absolute-cwd>] [--json]
  pi-mux list --displayed [--client-pid <pid>] [--json]
  pi-mux switch <session-id> [--client-pid <pid>]
  pi-mux history [--cwd <absolute-cwd>] [--json]
  pi-mux workspace register <cwd>
  pi-mux workspace unregister <cwd>
  pi-mux snapshot [server-generation]
  pi-mux restore
  pi-mux stop
  pi-mux reload [<session-id>]
  pi-mux restart [--force]`);
      return 0;
    }
    if (operation.kind === "inspect") {
      try {
        const result = await inspectSession(
          { ...tmuxConfiguration(), noStart: true },
          operation.id,
        );
        console.log(JSON.stringify(result));
        return 0;
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error;
        console.error(`pi-mux: Cannot inspect session ${operation.id}: ${errorMessage(error)}`);
        return 75;
      }
    }
    if (operation.kind === "inspect-management") {
      if (!platform.windows) throw new Error("This management query requires Windows");
      const config = { ...tmuxConfiguration(), noStart: true } as const;
      if (operation.socket !== config.socket)
        throw new Error("Ticket dispatch socket does not match pi-mux");
      await withLock(config, async () => {
        const management = windowsManagement(config);
        const basis = await management.currentBasis();
        if (!basis || !management.startupState(basis)?.restored)
          throw new Error("The dedicated psmux management generation is not restored and running");
        console.log(JSON.stringify({ state: "ready", generation: basis.instance }));
      });
      return 0;
    }
    if (
      operation.kind === "inspect-dispatch-inventory" ||
      operation.kind === "inspect-create-dispatch-worker"
    ) {
      if (!platform.windows) throw new Error("This dispatch operation requires Windows");
      const config = { ...tmuxConfiguration(), noStart: true } as const;
      if (operation.socket !== config.socket)
        throw new Error("Ticket dispatch socket does not match pi-mux");
      await withLock(
        config,
        async () => {
          if (operation.kind === "inspect-dispatch-inventory") {
            const { sessions } = await auditWindowsDispatchInventory(config);
            console.log(JSON.stringify({ sessions }));
          } else await createWindowsDispatchWorker(config, operation);
        },
        "try",
      );
      return 0;
    }
    if (operation.kind === "windows-claim-launch") {
      if (!platform.windows) throw new Error("This launch operation requires Windows");
      return operation.reload
        ? await claimWindowsReload(operation.token, operation.command, operation.reload)
        : await claimWindowsLaunch(operation.token, operation.command, operation.cwd);
    }
    if (operation.kind === "worktree-snapshot") {
      console.log(JSON.stringify(getWorktreeSnapshot(operation.request)));
      return 0;
    }
    if (operation.kind === "metadata") {
      const { id, viewFile } = operation;
      if (viewFile !== undefined) {
        const file = realpathSync(viewFile);
        const history = await new SessionMetadataCache(id, `view:${file}`, "").read(
          async () => file,
        );
        console.log(
          JSON.stringify({
            file,
            fileIdentity: history.identity,
            responseId: history.summary.response?.id ?? null,
          }),
        );
      } else {
        const config = { agentDir: resolveAgentDirectory(), env: process.env };
        const history = await readSessionMetadata(config, id);
        console.log(JSON.stringify(sessionMetadata(id, history.summary)));
      }
      return 0;
    }
    if (operation.kind === "record-view") {
      await sendViewReceipt(
        { ...tmuxConfiguration(), noStart: true },
        operation.id,
        operation.receipt,
      );
      return 0;
    }
    if (operation.kind === "open-exact") {
      if (!platform.windows && process.platform !== "linux")
        throw new Error("Exact session reopen requires Linux or Windows");
      const config = { ...configuration(), noStart: true } as const;
      printDetachedSession(config, await openExactSession(config, operation.id, operation.file));
      return 0;
    }
    if (operation.kind === "inspect-dispatch-ticket") {
      const result = await launchDispatchedTicket(
        { ...tmuxConfiguration(), noStart: true },
        operation,
      );
      console.log(JSON.stringify(result));
      return 0;
    }
    if (operation.kind === "state") {
      const config = tmuxConfiguration();
      prepareDirectory(config.stateDirectory);
      try {
        return await notifyState(config, operation.id, operation.source, operation.notification);
      } catch (error) {
        console.error(`pi-mux: state ${operation.id}: ${errorMessage(error)}`);
        return 1;
      }
    }
    if (operation.kind === "send") {
      return await sendSessionMessage(
        tmuxConfiguration(),
        operation.id,
        operation.text,
        operation.waitSeconds,
      );
    }
    if (
      operation.kind === "history" ||
      (operation.kind === "list" && operation.scope === "saved")
    ) {
      const history = await historySessions(tmuxConfiguration(), operation.cwd);
      console.log(operation.json ? JSON.stringify(history) : renderHistoryTable(history));
      return 0;
    }
    if (operation.kind === "list") {
      const config = tmuxConfiguration();
      if (operation.scope === "displayed") {
        const sessions = await displayedSessions({ ...config, noStart: true }, operation.clientPid);
        console.log(
          operation.json
            ? JSON.stringify(sessions)
            : renderTable(
                ["CLIENT PID", "WORKSPACE", "SESSION ID", "TMUX TARGET", "FILE"],
                sessions.map(({ clientPid, cwd, id, target, file }) => [
                  String(clientPid),
                  cwd,
                  id,
                  target,
                  file,
                ]),
              ),
        );
        return 0;
      }
      const active = await listWorkspaces(config);
      if (operation.scope === "active") {
        console.log(operation.json ? JSON.stringify(active) : renderActiveTable(active));
      } else {
        const history = await historySessions(config, undefined);
        const unified = mergeSessionLists(active, history);
        console.log(operation.json ? JSON.stringify(unified) : renderUnifiedTable(unified));
      }
      return 0;
    }
    if (operation.kind === "switch") {
      try {
        await switchSession(tmuxConfiguration(), operation.id, operation.clientPid);
        return 0;
      } catch (error) {
        if (!(error instanceof SwitchResolutionError)) throw error;
        console.error(`pi-mux: ${error.message}`);
        return error.exitCode;
      }
    }
    if (operation.kind === "close") {
      const config = tmuxConfiguration();
      prepareDirectory(config.stateDirectory);
      return await withLock(config, async () => {
        await closeSession(config, operation.id, operation.ifTemporary);
        return 0;
      });
    }
    if (operation.kind === "workspace") {
      const config = tmuxConfiguration();
      prepareDirectory(config.stateDirectory);
      return await withLock(config, async () => {
        if (operation.action === "register") {
          if (!statSync(operation.cwd).isDirectory())
            throw new Error(`Workspace is not a directory: ${operation.cwd}`);
          registerWorkspaces(config, [operation.cwd]);
        } else await unregisterWorkspace(config, operation.cwd);
        return 0;
      });
    }
    const config = configuration();
    const insideDedicatedServer = process.env.TMUX?.split(",")[0] === config.socket;
    if ((operation.kind === "restart" || operation.kind === "reload") && insideDedicatedServer)
      throw new Error("Run restart and reload from a terminal outside the dedicated tmux server");
    if (operation.kind === "stop" && insideDedicatedServer)
      throw new Error("Run stop from a terminal outside the dedicated tmux server");
    if (operation.kind === "restart") config.piCommand();
    prepareDirectory(config.stateDirectory);
    if (operation.kind === "stop" || operation.kind === "restart")
      return await serverLifecycle(config, operation);
    if (operation.kind === "reload") return await reloadPanes(config, operation.id);
    if (operation.kind === "snapshot") {
      return await withLock(config, async () => {
        await snapshotSessions(config, operation.generation);
        return 0;
      });
    }
    return await startSession(config, operation);
  } catch (error) {
    console.error(`pi-mux: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
