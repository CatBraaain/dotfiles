/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when the agent settles (stops running
 * on its own and waits for input). Only active in TUI mode, so RPC/JSON/print
 * sessions never write notification sequences to stdout.
 *
 * Supported protocols (chosen by environment variables, in this order):
 * - Windows toast: WT_SESSION is set (Windows Terminal on WSL)
 * - OSC 99: KITTY_WINDOW_ID is set or TERM_PROGRAM is "vscode" (Kitty, VSCode)
 * - OSC 777: fallback (Ghostty, iTerm2, WezTerm, rxvt-unicode)
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type NotificationProtocol = "windows" | "osc99" | "osc777";

type ExecFileFn = (file: string, args: string[], callback: (error: Error | null) => void) => void;

export interface NotifyOptions {
  protocol: NotificationProtocol;
  title: string;
  body: string;
  /** Sink for OSC-based notification sequences. */
  write: (output: string) => void;
  /** Launcher for the Windows toast script. */
  execFile: ExecFileFn;
}

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join("; ");
}

export function selectProtocol(env: NodeJS.ProcessEnv): NotificationProtocol {
  if (env.WT_SESSION) return "windows";
  if (env.KITTY_WINDOW_ID || env.TERM_PROGRAM === "vscode") return "osc99";
  return "osc777";
}

export function notify(options: NotifyOptions): void {
  const { protocol, title, body, write, execFile } = options;
  if (protocol === "windows") {
    // Errors (powershell.exe missing, non-zero exit, ...) are ignored so the
    // extension keeps running and pi never crashes.
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", windowsToastScript(title, body)],
      () => {},
    );
    return;
  }
  if (protocol === "osc99") {
    write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
    // p=1 marks the notification payload as complete.
    write(`\x1b]99;i=1:p=1;${body}\x1b\\`);
    return;
  }
  write(`\x1b]777;notify;${title};${body}\x07`);
}

let execFileImpl: ExecFileFn = execFile;

/** Injection seam for tests: swap the execFile used by the default export. */
export const testHooks = {
  get execFile(): ExecFileFn {
    return execFileImpl;
  },
  set execFile(value: ExecFileFn) {
    execFileImpl = value;
  },
};

export default function (pi: ExtensionAPI): void {
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    notify({
      protocol: selectProtocol(process.env),
      title: "Pi",
      body: "Ready for input",
      write: (output) => process.stdout.write(output),
      execFile: execFileImpl,
    });
  });
}
