import { isAbsolute, resolve } from "node:path";
import { PSMUX_ROUTING } from "./configuration";
import {
  isSessionState,
  parseSource,
  type StateNotification,
  type StateSource,
} from "./pane-state";
import { isViewReceipt, type ViewReceipt } from "./session-metadata";
import { errorMessage, isRecord, SESSION_ID_PATTERN, UUID } from "./session-model";
import { isWindowsProcessIdentity, type WindowsProcessIdentity } from "./windows-process";
import { parseWorktreeSnapshotRequest, type WorktreeSnapshotRequest } from "./worktree-snapshot";

type ListOperation =
  | { kind: "list"; scope: "all" | "active"; json: boolean }
  | { kind: "list"; scope: "saved"; cwd: string | undefined; json: boolean }
  | { kind: "list"; scope: "displayed"; clientPid: number | undefined; json: boolean };

export type Operation =
  | { kind: "help" }
  | { kind: "new"; detached: boolean; clientPid?: number; request?: string; cwd?: string }
  | { kind: "open"; id: string; temporary: boolean; detached: boolean }
  | { kind: "open-exact"; id: string; file: string }
  | { kind: "inspect"; id: string }
  | { kind: "inspect-management"; socket: string }
  | { kind: "inspect-dispatch-inventory"; socket: string }
  | WindowsCreateDispatchWorker
  | {
      kind: "windows-claim-launch";
      token: string;
      command: string[];
      cwd: string;
      reload?: WindowsReloadRoute;
    }
  | { kind: "metadata"; id: string; viewFile?: string }
  | { kind: "worktree-snapshot"; request: WorktreeSnapshotRequest }
  | { kind: "record-view"; id: string; receipt: ViewReceipt }
  | DispatchTicketOperation
  | { kind: "state"; id: string; source: StateSource; notification: StateNotification }
  | { kind: "send"; id: string; waitSeconds: number | undefined; text: string }
  | { kind: "close"; id: string; ifTemporary: boolean }
  | ListOperation
  | { kind: "switch"; id: string; clientPid: number | undefined }
  | { kind: "history"; cwd: string | undefined; json: boolean }
  | { kind: "workspace"; action: "register" | "unregister"; cwd: string }
  | { kind: "snapshot"; generation?: string }
  | { kind: "restore" }
  | { kind: "stop"; force: boolean }
  | { kind: "reload"; id?: string }
  | { kind: "restart"; force: boolean };

export type DispatchTicketOperation = {
  kind: "inspect-dispatch-ticket";
  ownerId?: string;
  socket: string;
  project: string;
  ticketId: string;
  sessionName: string;
  cwd: string;
  prompt: string;
};

export type WindowsCreateDispatchWorker = {
  kind: "inspect-create-dispatch-worker";
  socket: string;
  generation: string;
  name: string;
  project: string;
  token: string;
  cwd: string;
  powershell: string;
  command: string;
};

export const DISPATCH_TICKET_ID_PATTERN = /^[0-9]{8}-[0-9]{6}(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export const DISPATCH_TICKET_ID_MAX_LENGTH = 252;

const MESSAGE_TEXT_MAX_CODE_POINTS = 2800;

export const VIEW_RECEIPT_MAX_ENCODED_LENGTH = 16_384;

export function parseOperation(argv: string[]): Operation {
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) return { kind: "help" };
  if (argv.length === 0) return { kind: "new", detached: false, clientPid: undefined };
  if (argv[0] === "new") {
    let index = 1;
    let detached = false;
    let clientPid: number | undefined;
    let cwd: string | undefined;
    while (index < argv.length) {
      if (argv[index] === "--detached" && !detached) {
        detached = true;
        index++;
        continue;
      }
      if (
        argv[index] === "--client-pid" &&
        clientPid === undefined &&
        /^[1-9]\d*$/.test(argv[index + 1] ?? "")
      ) {
        clientPid = Number(argv[index + 1]);
        index += 2;
        continue;
      }
      const cwdValue = argv[index + 1];
      if (
        argv[index] === "--cwd" &&
        cwd === undefined &&
        cwdValue !== undefined &&
        isAbsolute(cwdValue)
      ) {
        cwd = cwdValue;
        index += 2;
        continue;
      }
      break;
    }
    const requests = argv.slice(index);
    const request = requests[0];
    if (requests.length === 0) return { kind: "new", detached, clientPid, cwd };
    if (requests.length === 1 && request?.trim() && !request.includes("\0")) {
      if (request === "-h" || request === "--help") return { kind: "help" };
      return { kind: "new", detached, clientPid, request, cwd };
    }
  }
  if (argv[0] === "state") return parseStateOperation(argv);
  if (argv[0] === "send") {
    if (argv.length === 2 && (argv[1] === "-h" || argv[1] === "--help")) return { kind: "help" };
    let index = 1;
    let waitSeconds: number | undefined;
    if (argv[index] === "--wait" && /^[1-9]\d*$/.test(argv[index + 1] ?? "")) {
      waitSeconds = Number(argv[index + 1]);
      index += 2;
    }
    const id = argv[index];
    const textParts = argv.slice(index + 1);
    if (id && SESSION_ID_PATTERN.test(id) && textParts.length > 0) {
      const text = textParts.join(" ");
      if (text.trim() && !text.includes("\0")) {
        const length = [...text].length;
        if (length > MESSAGE_TEXT_MAX_CODE_POINTS)
          throw new Error(
            `Message text is ${length} code points; the limit is ${MESSAGE_TEXT_MAX_CODE_POINTS}`,
          );
        return { kind: "send", id, waitSeconds, text };
      }
    }
  }
  if (argv[0] === "open") {
    const [, mode, flag, file, exactId] = argv;
    if (
      argv.length === 5 &&
      mode === "--detached" &&
      flag === "--expect-file" &&
      file &&
      isAbsolute(file) &&
      file.endsWith(".jsonl") &&
      !file.includes("\0") &&
      exactId &&
      SESSION_ID_PATTERN.test(exactId)
    )
      return { kind: "open-exact", id: exactId, file };
    let index = 1;
    let temporary = false;
    let detached = false;
    for (; index < argv.length; index++) {
      if (argv[index] === "--temporary" && !temporary) temporary = true;
      else if (argv[index] === "--detached" && !detached) detached = true;
      else break;
    }
    const id = argv[index];
    if (argv.length === index + 1 && id && SESSION_ID_PATTERN.test(id))
      return { kind: "open", id, temporary, detached };
  }
  if (argv[0] === "inspect") {
    const id = argv[1];
    if (argv.length === 2 && id && SESSION_ID_PATTERN.test(id)) return { kind: "inspect", id };
    if (id === "--dispatch-ticket" || id === "--dispatch-open-ticket")
      return parseDispatchTicketOperation(id, argv.slice(2));
    if (
      id === "--management" &&
      argv.length === 3 &&
      isAbsolute(argv[2]!) &&
      !argv[2]!.includes("\0")
    )
      return { kind: "inspect-management", socket: argv[2]! };
    if (
      id === "--dispatch-inventory" &&
      argv.length === 3 &&
      isAbsolute(argv[2]!) &&
      !argv[2]!.includes("\0")
    )
      return { kind: "inspect-dispatch-inventory", socket: argv[2]! };
    if (id === "--create-dispatch-worker") return parseWindowsCreateDispatchWorker(argv.slice(2));
  }
  if (argv[0] === "windows-claim-launch" && argv.length === 4 && UUID.test(argv[1]!)) {
    const command: unknown = JSON.parse(Buffer.from(argv[2]!, "base64").toString("utf8"));
    if (
      !Array.isArray(command) ||
      !isAbsolute(command[0] ?? "") ||
      !command.every((arg) => typeof arg === "string" && !arg.includes("\0"))
    )
      throw new Error("Invalid Windows pi launch command");
    const destination: unknown = JSON.parse(Buffer.from(argv[3]!, "base64").toString("utf8"));
    if (typeof destination === "string") {
      if (!isAbsolute(destination) || destination.includes("\0"))
        throw new Error("Invalid Windows pi launch directory");
      return { kind: "windows-claim-launch", token: argv[1]!, command, cwd: destination };
    }
    const reload = parseWindowsReloadRoute(destination);
    return { kind: "windows-claim-launch", token: argv[1]!, command, cwd: reload.cwd, reload };
  }
  if (argv[0] === "worktree") {
    const [, action, encoded] = argv;
    if (argv.length !== 3 || action !== "snapshot" || encoded === undefined)
      throw new Error("usage: pi-mux worktree snapshot <JSON>");
    return { kind: "worktree-snapshot", request: parseWorktreeSnapshotRequest(encoded) };
  }
  if (argv[0] === "metadata") {
    const [, first, id, viewFile] = argv;
    if (argv.length === 2 && first && SESSION_ID_PATTERN.test(first))
      return { kind: "metadata", id: first };
    if (
      argv.length === 4 &&
      first === "--view-target" &&
      id &&
      SESSION_ID_PATTERN.test(id) &&
      viewFile &&
      isAbsolute(viewFile) &&
      viewFile.endsWith(".jsonl") &&
      !viewFile.includes("\0")
    )
      return { kind: "metadata", id, viewFile };
  }
  if (argv[0] === "record-view" && argv.length === 3) {
    const id = argv[1];
    if (id && SESSION_ID_PATTERN.test(id)) {
      const receipt: unknown = JSON.parse(argv[2]!);
      if (isViewReceipt(receipt)) return { kind: "record-view", id, receipt };
    }
    throw new Error("Invalid session view receipt");
  }
  if (argv[0] === "close") {
    const conditional = argv[1] === "--if-temporary";
    const id = argv[conditional ? 2 : 1];
    if (argv.length === (conditional ? 3 : 2) && id && SESSION_ID_PATTERN.test(id))
      return { kind: "close", id, ifTemporary: conditional };
  }
  if (
    argv.length === 3 &&
    argv[0] === "workspace" &&
    (argv[1] === "register" || argv[1] === "unregister") &&
    argv[2]?.trim() &&
    !argv[2].includes("\0")
  )
    return { kind: "workspace", action: argv[1], cwd: resolve(argv[2]) };
  const listing = parseListingOperation(argv);
  if (listing) return listing;
  if (argv[0] === "switch") {
    const id = argv[1];
    const pid = argv[2] === "--client-pid" ? argv[3] : undefined;
    if (
      id &&
      SESSION_ID_PATTERN.test(id) &&
      ((argv.length === 2 && pid === undefined) ||
        (argv.length === 4 && pid !== undefined && /^[1-9]\d*$/.test(pid)))
    )
      return { kind: "switch", id, clientPid: pid === undefined ? undefined : Number(pid) };
  }
  if (argv[0] === "reload") {
    if (argv.length === 1) return { kind: "reload", id: undefined };
    const id = argv[1];
    if (argv.length === 2 && id && SESSION_ID_PATTERN.test(id)) return { kind: "reload", id };
  }
  const lifecycleCommand = argv[0];
  if (
    (lifecycleCommand === "stop" || lifecycleCommand === "restart") &&
    (argv.length === 1 || (argv.length === 2 && argv[1] === "--force"))
  )
    return { kind: lifecycleCommand, force: argv[1] === "--force" };
  if (argv.length === 1 && argv[0] === "restore") return { kind: "restore" };
  if ((argv.length === 1 || argv.length === 2) && argv[0] === "snapshot")
    return { kind: "snapshot", generation: argv[1] };
  throw new Error(
    "usage: pi-mux [new [--detached] [--client-pid <pid>] [--cwd <absolute-cwd>] [initial-request] | open [--temporary] [--detached] <session-id> | open --detached --expect-file <absolute-jsonl-path> <session-id> | inspect <session-id> | metadata <session-id> | state <session-id> <state> --source <JSON> --title <JSON> | state <session-id> --clear --source <JSON> | send [--wait <seconds>] <session-id> <text...> | close [--if-temporary] <session-id> | list [--json] | list --active [--json] | list --saved [--cwd <absolute-cwd>] [--json] | list --displayed [--client-pid <pid>] [--json] | switch <session-id> [--client-pid <pid>] | history [--cwd <absolute-cwd>] [--json] | workspace register|unregister <cwd> | snapshot [server-generation] | restore | stop [--force] | reload [<session-id>] | restart [--force]]",
  );
}

function parseListOperation(args: string[]): ListOperation | undefined {
  let scope: ListOperation["scope"] = "all";
  let cwd: string | undefined;
  let clientPid: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json" && !json) {
      json = true;
    } else if (
      scope === "all" &&
      (flag === "--active" || flag === "--saved" || flag === "--displayed")
    ) {
      if (flag === "--active") scope = "active";
      else if (flag === "--saved") scope = "saved";
      else scope = "displayed";
    } else if (flag === "--cwd" && cwd === undefined) {
      const value = args[++index];
      if (!value || !isAbsolute(value)) return;
      cwd = value;
    } else if (flag === "--client-pid" && clientPid === undefined) {
      const value = args[++index];
      if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return;
      clientPid = Number(value);
    } else {
      return;
    }
  }
  if (scope === "displayed" && cwd === undefined) return { kind: "list", scope, clientPid, json };
  if (clientPid !== undefined) return;
  if (scope === "saved") return { kind: "list", scope, cwd, json };
  if (scope !== "displayed" && cwd === undefined) return { kind: "list", scope, json };
}

function parseListingOperation(argv: string[]): Operation | undefined {
  const kind = argv[0];
  if (kind === "list") return parseListOperation(argv.slice(1));
  if (kind !== "history") return;

  const jsonFirst = argv[1] === "--json";
  const jsonLast = argv.at(-1) === "--json";
  const json = jsonFirst || jsonLast;
  const args = jsonFirst ? argv.slice(2) : argv.slice(1, jsonLast ? -1 : undefined);

  if (args.length === 0) return { kind, cwd: undefined, json };
  const [flag, cwd] = args;
  if (args.length === 2 && flag === "--cwd" && cwd && isAbsolute(cwd)) return { kind, cwd, json };
}

function parseStateOperation(argv: string[]): Operation {
  const id = argv[1];
  try {
    if (!id || !SESSION_ID_PATTERN.test(id)) throw new Error("Invalid complete conversation ID");
    const state = argv[2];
    const clear = state === "--clear";
    if (!clear && !isSessionState(state)) throw new Error("Invalid state");
    const options = new Map<string, unknown>();
    for (let index = 3; index < argv.length; index += 2) {
      const key = argv[index]!;
      const value = argv[index + 1];
      if ((key !== "--source" && key !== "--title") || options.has(key) || value === undefined)
        throw new Error("Missing, duplicate, or unexpected state argument");
      options.set(key, JSON.parse(value));
    }
    const hasRequiredOptions =
      options.has("--source") && (clear ? options.size === 1 : options.has("--title"));
    if (!hasRequiredOptions)
      throw new Error("State requires source and title; clear requires only source");
    const source = parseSource(options.get("--source"));
    if (clear) return { kind: "state", id, source, notification: { clear: true } };

    const title = options.get("--title");
    if (title !== null && typeof title !== "string") throw new Error("Invalid title");
    return { kind: "state", id, source, notification: { clear: false, state, title } };
  } catch (error) {
    throw new Error(`state ${id ?? "<missing>"}: ${errorMessage(error)}`);
  }
}

function parseWindowsCreateDispatchWorker(args: string[]): WindowsCreateDispatchWorker {
  const [socket, generation, name, project, token, cwd, powershell, command] = args;
  if (
    args.length !== 8 ||
    !socket ||
    !generation ||
    !/^[0-9a-f]{16}$/.test(generation) ||
    project === undefined ||
    [".", ".."].includes(project) ||
    /[\\/\0\t\r\n]/.test(project) ||
    name !== `ticket_dispatch_${project ? Buffer.from(project).toString("hex") : "all"}` ||
    !token ||
    !UUID.test(token) ||
    !cwd ||
    !isAbsolute(cwd) ||
    cwd.includes("\0") ||
    !powershell ||
    !command ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(command)
  )
    throw new Error("Invalid Windows dispatcher worker arguments");
  return {
    kind: "inspect-create-dispatch-worker",
    socket,
    generation,
    name,
    project,
    token,
    cwd,
    powershell,
    command,
  };
}

export type WindowsReloadRoute = {
  name: string;
  identity: string;
  instance: string;
  pane: string;
  session: string;
  id: string;
  cwd: string;
  launchToken: string;
  launcher: WindowsProcessIdentity;
  inheritedOverrides: [string, string | null][];
};

function parseWindowsReloadRoute(route: unknown): WindowsReloadRoute {
  if (
    !isRecord(route) ||
    typeof route.name !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(route.name) ||
    typeof route.identity !== "string" ||
    !/^[1-9]\d*:[1-9]\d*$/.test(route.identity) ||
    typeof route.instance !== "string" ||
    !/^[0-9a-f]{16}$/.test(route.instance) ||
    typeof route.pane !== "string" ||
    !/^%\d+$/.test(route.pane) ||
    typeof route.session !== "string" ||
    !/^\$\d+$/.test(route.session) ||
    typeof route.id !== "string" ||
    !SESSION_ID_PATTERN.test(route.id) ||
    typeof route.cwd !== "string" ||
    !isAbsolute(route.cwd) ||
    route.cwd.includes("\0") ||
    typeof route.launchToken !== "string" ||
    !UUID.test(route.launchToken) ||
    !isWindowsProcessIdentity(route.launcher) ||
    !Array.isArray(route.inheritedOverrides) ||
    !route.inheritedOverrides.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        /^[^=\0\r\n]+$/.test(entry[0]) &&
        !PSMUX_ROUTING.has(entry[0].toUpperCase()) &&
        (entry[1] === null || (typeof entry[1] === "string" && !entry[1].includes("\0"))),
    )
  )
    throw new Error("Invalid Windows reload launch route");
  return route as WindowsReloadRoute;
}

function parseDispatchTicketOperation(
  flag: "--dispatch-ticket" | "--dispatch-open-ticket",
  args: string[],
): DispatchTicketOperation {
  const locked = flag === "--dispatch-ticket";
  if (args.length !== (locked ? 7 : 6))
    throw new Error(`Invalid argument count for inspect ${flag}`);
  const ownerId = locked ? args[0]! : undefined;
  if (ownerId !== undefined && (ownerId !== ownerId.trim() || !SESSION_ID_PATTERN.test(ownerId)))
    throw new Error("Invalid ticket owner ID");
  const [socket, project, ticketId, sessionName, cwd, prompt] = locked ? args.slice(1) : args;
  if (!socket || socket.includes("\0")) throw new Error("Invalid ticket dispatch socket");
  if (!project || project === "." || project === ".." || /[/\\\0]/.test(project))
    throw new Error("Invalid ticket project");
  if (
    !ticketId ||
    ticketId.length > DISPATCH_TICKET_ID_MAX_LENGTH ||
    ticketId !== ticketId.trim() ||
    !DISPATCH_TICKET_ID_PATTERN.test(ticketId)
  )
    throw new Error("Invalid ticket ID");
  const nameId = ticketId.replaceAll(".", "_");
  const projectHex = Buffer.from(project, "utf8").toString("hex");
  if (sessionName !== `handle_${nameId}` && sessionName !== `handle_${projectHex}_${nameId}`)
    throw new Error("Invalid ticket tmux session name");
  if (!cwd || !isAbsolute(cwd) || cwd.includes("\0"))
    throw new Error("Ticket workspace must be an absolute path");
  if (!prompt || prompt.includes("\0")) throw new Error("Invalid ticket dispatch prompt");
  return {
    kind: "inspect-dispatch-ticket",
    ...(ownerId !== undefined ? { ownerId } : {}),
    socket,
    project,
    ticketId,
    sessionName,
    cwd,
    prompt,
  };
}
