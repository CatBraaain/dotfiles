import * as vscode from "vscode";

const GLOBAL_DISPATCHER_ROW =
  /^\(all\) {2,}ticket_dispatch_all {2,}\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const PROJECT_DISPATCHER_ROW =
  / {2,}ticket_dispatch_[0-9a-f]+ {2,}\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const READY_CONTEXT = "agentKit.ticketDispatchReady";
const RUNNING_CONTEXT = "agentKit.ticketDispatchRunning";

type DispatchAction = "start" | "stop";

export function registerTicketDispatch(
  context: vscode.ExtensionContext,
  runTicket: (args: readonly string[]) => Promise<{ stdout: string }>,
  log: vscode.LogOutputChannel,
): void {
  let isBusy = false;

  async function readGlobalDispatcher(): Promise<boolean> {
    const { stdout } = await runTicket(["dispatch", "list"]);
    const output = stdout.trimEnd();
    if (output === "no dispatcher running") return false;

    const rows = output.split(/\r?\n/);
    const isRunning = rows.some((row) => GLOBAL_DISPATCHER_ROW.test(row));
    if (!isRunning && !rows.some((row) => PROJECT_DISPATCHER_ROW.test(row))) {
      throw new Error("Unrecognized ticket dispatch list response");
    }
    return isRunning;
  }

  function reportFailure(error: unknown, operation: string, notify: boolean): void {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `Could not ${operation}: ${reason}`;
    log.error(message);
    if (notify) void vscode.window.showErrorMessage(message);
  }

  async function update(action: DispatchAction | undefined, notify: boolean): Promise<void> {
    if (isBusy) return;
    isBusy = true;
    try {
      await vscode.commands.executeCommand("setContext", READY_CONTEXT, false);
      let isRunning = await readGlobalDispatcher();
      if (action !== undefined && isRunning === (action === "stop")) {
        try {
          await runTicket(["dispatch", action, "--all"]);
        } catch (error) {
          reportFailure(error, `${action} ticket dispatch`, notify);
        }
        isRunning = await readGlobalDispatcher();
      }
      await vscode.commands.executeCommand("setContext", RUNNING_CONTEXT, isRunning);
      await vscode.commands.executeCommand("setContext", READY_CONTEXT, true);
    } catch (error) {
      reportFailure(error, "read ticket dispatch status", notify);
    } finally {
      isBusy = false;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("agentKit.startTicketDispatch", () => update("start", true)),
    vscode.commands.registerCommand("agentKit.stopTicketDispatch", () => update("stop", true)),
  );
  void update(undefined, false);
}
