import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  compileCommandRuleEntries,
  defaultGuardrailConfigPath,
  type CompiledCommandRuleEntry,
  type GuardrailConfig,
  type MatchSpan,
  parseGuardrailConfig,
  pathCovers,
  pathsMatchCandidate,
  resolveCommandActionMatch,
  resolvePathActionMatch,
  splitCommandSegments,
} from "./config.ts";
import {
  type DynamicPaths,
  type SandboxMode,
  buildSandboxArgs,
  credentialPaths,
  prepareWriteDirectories,
  readActionMatch,
  resolveGrantWritableViaBash,
  warmGlobCache,
  writePaths,
  writePathsByFinalAction,
} from "./sandbox.ts";

export type PathApproval = {
  operation: "read" | "write";
  scope: "file" | "directory";
  grantedPath: string;
  bashWritable?: boolean;
};

export type WritePermissionRequest =
  | { status: "already granted"; grantedPath: string; bashWritable: boolean }
  | { status: "granted"; grantedPath: string; bashWritable: boolean }
  | { status: "denied"; grantedPath: string; reason?: string };

export type CommandPermissionRequest =
  | { status: "already granted"; command: string; approvedPattern?: string; grant?: "turn" }
  | {
      status: "granted";
      command: string;
      grant: "once" | "session" | "turn";
      approvedPattern?: string;
    }
  | { status: "denied"; command: string; reason?: string };

/** §2.3 approval note for a write grant approved via a confirmation dialog.
 * Unset paths become writable including via bash; ask-final paths stay
 * read-only in the bash sandbox (§6.1), which the note spells out. */
export function writeApprovalNote(approval: PathApproval): string {
  if (approval.bashWritable === false)
    return approval.scope === "directory"
      ? `User approved write access via confirmation (scope: directory ${approval.grantedPath}); the subtree is writable via fs tools for the rest of the session, but not via bash (ask-configured paths stay read-only in the bash sandbox).`
      : `User approved write access via confirmation (scope: file ${approval.grantedPath}); writable via fs tools for the rest of the session, but not via bash (ask-configured paths stay read-only in the bash sandbox).`;
  return approval.scope === "directory"
    ? `User approved write access via confirmation (scope: directory ${approval.grantedPath}); the subtree is writable for the rest of the session, including via bash.`
    : `User approved write access via confirmation (scope: file ${approval.grantedPath}); writable for the rest of the session, including via bash.`;
}

export type ToolUI = {
  confirm(title: string, message: string): Promise<boolean>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  /** Provides the dialog accent color so the highlight can restore it afterwards. */
  theme?: { getFgAnsi(color: "accent"): string };
};

export type ToolContext = {
  cwd?: string;
  hasUI?: boolean;
  ui?: ToolUI;
};

const ALLOW_OPTION = "Yes, allow";
const ALLOW_ONCE_OPTION = "Allow once";
const ALLOW_SESSION_OPTION = "Allow in this session";
const ALLOW_TURN_OPTION = "Allow in this turn";
const EXPIRED_TURN_APPROVAL = "Turn approval expired. Request approval again.";
const DENY_OPTION = "No, deny (reason next)";

/** Guidance returned with an `ask_with_reason` rejection so the model re-requests via ask_permission (§3・§4). */
export const COMMAND_REASON_HINT =
  "This command requires a reason. Call ask_permission with this exact command and a reason; do not rewrite the command to bypass the gate.";

/** Dialog line explaining which pattern caused the confirmation (§2.3). */
function matchedPatternNote(matched: string | undefined): string {
  return matched === undefined ? "no matching pattern (default ask)" : `matched: ${matched}`;
}

// Invert + yellow: the inverted background stays visible on any terminal palette,
// where basic yellow alone can sit too close to the dialog accent color. Selective
// SGRs (no full reset) so the dialog's accent/bold styling survives.
const MATCH_HIGHLIGHT = "\x1b[7m\x1b[33m";
const MATCH_HIGHLIGHT_END = "\x1b[27m";

function highlightCommandMatch(raw: string, span: MatchSpan, accentStart: string): string {
  let highlighted = raw;
  for (const range of [...span.ranges].sort((left, right) => right.index - left.index)) {
    highlighted =
      highlighted.slice(0, range.index) +
      MATCH_HIGHLIGHT +
      highlighted.slice(range.index, range.index + range.length) +
      MATCH_HIGHLIGHT_END +
      accentStart +
      highlighted.slice(range.index + range.length);
  }
  return highlighted;
}

export class Guardrail {
  private readonly dynamicPaths = new Map<string, Set<"read" | "write">>();
  /** One-shot ask_permission approvals, as normalized command segments (§3). */
  private readonly approvedCommands: string[][][] = [];
  /**
   * Session-approved command patterns (§3): config pattern strings approved
   * via an "Allow in this session" selection. Commands matching one of these
   * run without confirmation for the rest of the session; the grant is never
   * consumed and dies with the session.
   */
  private readonly sessionApprovedPatterns: string[] = [];
  private readonly turnApprovedPatterns = new Set<string>();
  private turnApprovalGeneration = 0;
  // pi's TUI has a single slot for extension dialogs: a second dialog replaces
  // the first without resolving its promise, deadlocking that tool call.
  // One global queue; split per dialog kind if contention ever matters.
  private uiQueue: Promise<void> = Promise.resolve();
  private readonly config: GuardrailConfig;
  /** Command entries with patterns compiled to regex once at startup (SPEC §6). */
  private readonly commandEntries: CompiledCommandRuleEntry[];
  /** Configured command patterns that failed regex compilation, deduped in config order (SPEC §6). */
  readonly invalidCommandPatterns: string[];
  /** Glob expansions are computed once per resolved pattern (§3 startup semantics). */
  private readonly globCache: Map<string, string[]>;

  constructor(
    private readonly cwd: string,
    configPath = defaultGuardrailConfigPath(),
  ) {
    try {
      this.config = parseGuardrailConfig(readFileSync(configPath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`guardrails.yaml (${configPath}): ${message}`);
    }
    const compiledCommands = compileCommandRuleEntries(this.config.commands);
    this.commandEntries = compiledCommands.entries;
    this.invalidCommandPatterns = [...new Set(compiledCommands.invalidPatterns)];
    this.globCache = warmGlobCache(this.config, this.cwd);
    prepareWriteDirectories(this.config, this.cwd, this.globCache);
  }

  /** Effective write paths, excluding paths covered by the credentials deny list. */
  getWritePathsByFinalAction(): { allow: string[]; ask: string[]; deny: string[] } {
    const { allow, ask, deny } = writePathsByFinalAction(this.config, this.cwd, this.globCache);
    const credentials = credentialPaths(this.config, this.cwd, this.globCache);
    const excludeCredentials = (paths: string[]) =>
      paths.filter((path) => !pathsMatchCandidate(credentials, path));
    return {
      allow: excludeCredentials(allow),
      ask: excludeCredentials(ask),
      deny: excludeCredentials(deny),
    };
  }

  /** Build the bwrap argument list (delegates to the shared pure builder; tests use this entry). */
  buildArgs(mode: SandboxMode, commandCwd = this.cwd): string[] {
    return buildSandboxArgs({
      cwd: this.cwd,
      config: this.config,
      globCache: this.globCache,
      dynamicPaths: this.dynamicPaths,
      mode,
      commandCwd,
    });
  }

  getDynamicPaths(): DynamicPaths {
    return new Map(this.dynamicPaths);
  }

  async authorizePath(
    operation: "read" | "write",
    candidatePath: string,
    context: ToolContext,
  ): Promise<PathApproval | undefined> {
    const absolutePath = resolve(candidatePath);
    if (pathsMatchCandidate(credentialPaths(this.config, this.cwd, this.globCache), absolutePath)) {
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    }
    const { action, matched } =
      operation === "read"
        ? readActionMatch(this.config, this.cwd, this.globCache, absolutePath)
        : resolvePathActionMatch(writePaths(this.config, this.cwd, this.globCache), absolutePath);
    if (action === "allow") return undefined;
    if (action === "deny" && matched !== undefined)
      throw new Error(`Access denied: ${absolutePath}`);
    if (this.hasDynamicGrant(operation, absolutePath)) return undefined;
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      // A sibling tool call may have obtained the grant while this call queued.
      if (this.hasDynamicGrant(operation, absolutePath)) return undefined;
      return this.requestAccess(operation, absolutePath, ui, matched);
    });
  }

  private async withUiLock<T>(showDialog: () => Promise<T>): Promise<T> {
    const previous = this.uiQueue;
    let release!: () => void;
    this.uiQueue = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await showDialog();
    } finally {
      release();
    }
  }

  private hasDynamicGrant(operation: "read" | "write", candidatePath: string): boolean {
    for (const [grantedPath, accessModes] of this.dynamicPaths)
      if (accessModes.has(operation) && pathCovers(grantedPath, candidatePath)) return true;
    return false;
  }

  /**
   * Request user approval for writing under a directory subtree via the
   * ask_permission tool (§3 許可要求ツール). Explicit deny and credential
   * paths throw; denial resolves so the tool can return it as its result.
   */
  async requestWritePermission(
    directoryPath: string,
    reason: string,
    context: ToolContext,
  ): Promise<WritePermissionRequest> {
    const absolutePath = resolve(directoryPath);
    if (pathsMatchCandidate(credentialPaths(this.config, this.cwd, this.globCache), absolutePath)) {
      throw new Error(`Access denied for credential path: ${absolutePath}`);
    }
    const { action, matched } = resolvePathActionMatch(
      writePaths(this.config, this.cwd, this.globCache),
      absolutePath,
    );
    if (action === "deny" && matched !== undefined)
      throw new Error(`Access denied: ${absolutePath}`);
    const grantedPath = this.directoryScopePath(absolutePath);
    if (action === "allow" || this.hasDynamicGrant("write", grantedPath))
      return {
        status: "already granted",
        grantedPath,
        bashWritable: this.grantWritableViaBash(grantedPath),
      };
    if (!context.hasUI || !context.ui)
      throw new Error(`Access requires confirmation: ${absolutePath}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      // A sibling tool call may have obtained the grant while this call queued.
      if (this.hasDynamicGrant("write", grantedPath))
        return {
          status: "already granted",
          grantedPath,
          bashWritable: this.grantWritableViaBash(grantedPath),
        };
      return this.confirmWritePermission(grantedPath, reason, ui, matched);
    });
  }

  /** The write scope for a permission request: the path itself, or its parent for a file path (§3). */
  private directoryScopePath(absolutePath: string): string {
    try {
      return statSync(absolutePath).isDirectory() ? absolutePath : dirname(absolutePath);
    } catch {
      // Non-existent paths (e.g. a worktree to create) request the subtree at the path.
      return absolutePath;
    }
  }

  private async confirmWritePermission(
    grantedPath: string,
    reason: string,
    ui: ToolUI,
    matched?: string,
  ): Promise<WritePermissionRequest> {
    const question = "Allow write access to directory subtree?";
    const details = `${grantedPath}\nreason: ${reason}\n${matchedPatternNote(matched)}`;
    if (ui.select) {
      const selectedOption = await ui.select(`${question}\n${details}`, [
        ALLOW_OPTION,
        DENY_OPTION,
      ]);
      if (selectedOption === ALLOW_OPTION) return this.grantWriteDirectory(grantedPath);
    } else if (await ui.confirm(question, details)) {
      return this.grantWriteDirectory(grantedPath);
    }
    const denialReason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return { status: "denied", grantedPath, ...(denialReason ? { reason: denialReason } : {}) };
  }

  /** Grant the directory-scope dynamic write and build the request result (§3). */
  private grantWriteDirectory(grantedPath: string): WritePermissionRequest {
    this.addDynamicGrant("write", grantedPath, "directory");
    return {
      status: "granted",
      grantedPath,
      bashWritable: this.grantWritableViaBash(grantedPath),
    };
  }

  private async requestAccess(
    operation: "read" | "write",
    absolutePath: string,
    ui: ToolUI,
    matched?: string,
  ): Promise<PathApproval> {
    const directoryScopeOption = "Directory (subtree)";
    const title = `Allow ${operation} access?\n${absolutePath}\n${matchedPatternNote(matched)}`;
    if (ui.select) {
      const selectedOption = await ui.select(
        title,
        operation === "write"
          ? ["File only", directoryScopeOption, DENY_OPTION]
          : [ALLOW_OPTION, DENY_OPTION],
      );
      if (selectedOption === undefined || selectedOption === DENY_OPTION)
        throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
      if (operation === "write") {
        if (selectedOption !== "File only" && selectedOption !== directoryScopeOption)
          throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
        const scope = selectedOption === directoryScopeOption ? "directory" : "file";
        const grantPath = scope === "directory" ? dirname(absolutePath) : absolutePath;
        this.addDynamicGrant("write", grantPath, scope);
        return {
          operation: "write",
          scope,
          grantedPath: grantPath,
          bashWritable: this.grantWritableViaBash(grantPath),
        };
      }
      if (selectedOption !== ALLOW_OPTION)
        throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
      this.addDynamicGrant(operation, absolutePath, "file");
      return { operation, scope: "file", grantedPath: absolutePath };
    }
    const approved = await ui.confirm(
      `Allow ${operation} access?`,
      `${absolutePath}\n${matchedPatternNote(matched)}`,
    );
    if (!approved) throw await this.deniedError(`Access denied by user: ${absolutePath}`, ui);
    this.addDynamicGrant(operation, absolutePath, "file");
    if (operation === "write")
      return {
        operation,
        scope: "file",
        grantedPath: absolutePath,
        bashWritable: this.grantWritableViaBash(absolutePath),
      };
    return { operation, scope: "file", grantedPath: absolutePath };
  }

  /** Build the denial error after a canceled selection dialog, asking for an optional reason (§2.3). */
  private async deniedError(message: string, ui: ToolUI): Promise<Error> {
    const reason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return new Error(reason ? `${message}\nUser reason: ${reason}` : message);
  }

  private addDynamicGrant(
    operation: "read" | "write",
    grantPath: string,
    scope: "file" | "directory",
  ): void {
    if (operation === "write") this.ensureGrantPathExists(grantPath, scope);
    const accessModes = this.dynamicPaths.get(grantPath) ?? new Set<"read" | "write">();
    accessModes.add(operation);
    this.dynamicPaths.set(grantPath, accessModes);
  }

  private ensureGrantPathExists(grantPath: string, scope: "file" | "directory"): void {
    if (scope === "directory") {
      mkdirSync(grantPath, { recursive: true });
      return;
    }
    mkdirSync(dirname(grantPath), { recursive: true });
    if (!existsSync(grantPath)) writeFileSync(grantPath, "");
  }

  /**
   * Match `command` against the one-shot ask_permission approvals (§3).
   * Quoting differences normalize away while token boundaries remain distinct.
   * Consumes the approval on an exact token-sequence match.
   */
  private consumeApprovedCommand(command: string): boolean {
    const segments = splitCommandSegments(command);
    const index = this.approvedCommands.findIndex(
      (approved) =>
        approved.length === segments.length &&
        approved.every(
          (segment, i) =>
            segment.length === segments[i]?.length &&
            segment.every((token, j) => token === segments[i]?.[j]),
        ),
    );
    if (index === -1) return false;
    this.approvedCommands.splice(index, 1);
    return true;
  }

  /**
   * Request user approval for a gated command via the ask_permission tool
   * (§3 許可要求ツール). Explicit deny and `ask` (confirmed at bash time)
   * throw; denial resolves so the tool can return it as its result.
   */
  async requestCommandPermission(
    command: string,
    reason: string,
    context: ToolContext,
  ): Promise<CommandPermissionRequest> {
    const { action, matched, matchSpan } = resolveCommandActionMatch(this.commandEntries, command);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    if (action === "allow") return { status: "already granted", command };
    if (action === "ask")
      throw new Error(`Command is confirmed when run via bash; no pre-approval needed: ${command}`);
    const generation = this.turnApprovalGeneration;
    const existingApproval = this.commandPatternApproval(command, matched, generation);
    if (existingApproval) return existingApproval;
    if (!context.hasUI || !context.ui) throw new Error(`Access requires confirmation: ${command}`);
    const ui = context.ui;
    return this.withUiLock(async () => {
      const approval = this.commandPatternApproval(command, matched, generation);
      return (
        approval ??
        this.confirmCommandPermission(command, reason, ui, generation, matched, matchSpan)
      );
    });
  }

  private async confirmCommandPermission(
    command: string,
    reason: string,
    ui: ToolUI,
    generation: number,
    matched?: string,
    matchSpan?: MatchSpan,
  ): Promise<CommandPermissionRequest> {
    const question = "Allow command execution?";
    // Same highlight rule as the `ask` dialog (§2.3): show where the pattern
    // matched, unless the UI lacks a theme or NO_COLOR is set.
    const display =
      matchSpan !== undefined && ui.theme && !process.env.NO_COLOR
        ? highlightCommandMatch(command, matchSpan, ui.theme.getFgAnsi("accent"))
        : command;
    const details = `${display}\nreason: ${reason}\n${matchedPatternNote(matched)}`;
    if (ui.select) {
      const selectedOption = await ui.select(`${question}\n${details}`, [
        ALLOW_ONCE_OPTION,
        ALLOW_SESSION_OPTION,
        ALLOW_TURN_OPTION,
        DENY_OPTION,
      ]);
      if (selectedOption === ALLOW_TURN_OPTION && matched !== undefined) {
        if (generation !== this.turnApprovalGeneration)
          return { status: "denied", command, reason: EXPIRED_TURN_APPROVAL };
        this.turnApprovedPatterns.add(matched);
        return { status: "granted", command, grant: "turn", approvedPattern: matched };
      }
      if (selectedOption === ALLOW_SESSION_OPTION && matched !== undefined) {
        this.sessionApprovedPatterns.push(matched);
        return { status: "granted", command, grant: "session", approvedPattern: matched };
      }
      if (selectedOption === ALLOW_ONCE_OPTION || selectedOption === ALLOW_SESSION_OPTION)
        return this.grantCommandApproval(command);
    } else if (await ui.confirm(question, details)) {
      // No select UI: no way to choose the scope, so fall back to "once".
      return this.grantCommandApproval(command);
    }
    const denialReason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
    return { status: "denied", command, ...(denialReason ? { reason: denialReason } : {}) };
  }

  private grantCommandApproval(command: string): CommandPermissionRequest {
    this.approvedCommands.push(splitCommandSegments(command));
    return { status: "granted", command, grant: "once" };
  }

  expireTurnCommandApprovals(): void {
    this.turnApprovedPatterns.clear();
    this.turnApprovalGeneration++;
  }

  private commandPatternApproval(
    command: string,
    matched: string | undefined,
    generation: number,
  ): CommandPermissionRequest | undefined {
    if (matched === undefined) return undefined;
    if (this.sessionApprovedPatterns.includes(matched))
      return { status: "already granted", command, approvedPattern: matched };
    if (generation === this.turnApprovalGeneration && this.turnApprovedPatterns.has(matched))
      return { status: "already granted", command, approvedPattern: matched, grant: "turn" };
    return undefined;
  }

  authorizeCommand(command: string, context: ToolContext): Promise<boolean> {
    const { action, matched, matchSpan } = resolveCommandActionMatch(this.commandEntries, command);
    if (action === "allow") return Promise.resolve(false);
    if (action === "deny") throw new Error(`Command denied: ${command}`);
    const generation = this.turnApprovalGeneration;
    if (this.commandPatternApproval(command, matched, generation)) return Promise.resolve(true);
    if (action === "ask_with_reason") {
      if (this.consumeApprovedCommand(command)) return Promise.resolve(true);
      throw new Error(`Command requires a reason: ${command}\n${COMMAND_REASON_HINT}`);
    }
    if (!context.hasUI || !context.ui) throw new Error(`Command requires confirmation: ${command}`);
    const ui = context.ui;
    const note = matchedPatternNote(matched);
    const display =
      matchSpan !== undefined && ui.theme && !process.env.NO_COLOR
        ? highlightCommandMatch(command, matchSpan, ui.theme.getFgAnsi("accent"))
        : command;
    return this.withUiLock(async () => {
      if (this.commandPatternApproval(command, matched, generation)) return true;
      if (ui.select) {
        const options =
          matched === undefined
            ? [ALLOW_ONCE_OPTION, DENY_OPTION]
            : [ALLOW_ONCE_OPTION, ALLOW_SESSION_OPTION, ALLOW_TURN_OPTION, DENY_OPTION];
        const selectedOption = await ui.select(`Allow command?\n${display}\n${note}`, options);
        if (selectedOption === ALLOW_TURN_OPTION && matched !== undefined) {
          if (generation !== this.turnApprovalGeneration)
            throw new Error(`Command denied: ${command}\n${EXPIRED_TURN_APPROVAL}`);
          this.turnApprovedPatterns.add(matched);
        }
        if (selectedOption === ALLOW_SESSION_OPTION && matched !== undefined)
          this.sessionApprovedPatterns.push(matched);
        if (selectedOption === undefined || selectedOption === DENY_OPTION)
          throw await this.deniedError(`Command denied by user: ${command}`, ui);
        return true;
      }
      if (await ui.confirm("Allow command?", `${display}\n${note}`)) return true;
      throw await this.deniedError(`Command denied by user: ${command}`, ui);
    });
  }

  private grantWritableViaBash(grantedPath: string): boolean {
    return resolveGrantWritableViaBash(this.config, this.cwd, this.globCache, grantedPath);
  }
}
