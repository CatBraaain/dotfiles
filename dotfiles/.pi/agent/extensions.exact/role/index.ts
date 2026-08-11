import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Role = "orch" | "manager" | "worker" | "chat";

export const ROLES: readonly Role[] = ["orch", "manager", "worker", "chat"];

/** 新規セッションも保存済みセッションの再開も、保存前のロールによらず manager で始まる。 */
export const INITIAL_ROLE: Role = "manager";

export function initialRole(_previousRole?: Role): Role {
  return INITIAL_ROLE;
}

/** オーナーの切り替え操作で、orch / manager / worker / chat のいずれにも遷移できる。 */
export function switchRole(nextRole: Role): Role {
  return nextRole;
}

/** ファイルの読み取り/書き込みにあたるツール。orch / chat ではハードブロックされる。 */
export const FILE_OPERATION_TOOLS: readonly string[] = ["read", "write", "edit"];

export function isFileOperationTool(toolName: string): boolean {
  return FILE_OPERATION_TOOLS.includes(toolName);
}

/** chat ロールでのみ許可されるツール。 */
export const CHAT_ALLOWED_TOOLS: readonly string[] = ["web_search", "web_fetch"];

/** ロールがファイルの読み取り/書き込みを実行できるか。manager / worker のみ可。 */
export function canOperateFiles(role: Role): boolean {
  return role === "manager" || role === "worker";
}

/** ロールとツールから、そのツール呼び出しをハードブロックすべきかを決める。 */
export function shouldBlockToolCall(role: Role, toolName: string): boolean {
  if (role === "chat") return !CHAT_ALLOWED_TOOLS.includes(toolName);
  if (!canOperateFiles(role)) return isFileOperationTool(toolName);
  return false;
}

/** orch / chat ロールでシステムプロンプトに追記する、ファイル操作禁止の指示。manager / worker は空文字。 */
export function buildRoleSystemPromptAddendum(role: Role): string {
  if (canOperateFiles(role)) return "";
  return `\n\n[role ${role}] このロールではファイル操作（read / write / edit）は禁止されています。ファイルの読み書きが必要なときは、manager / worker へ委譲するか、オーナーに対応を相談してください。`;
}

/** 委譲元 × 委譲先 で、子セッションが起動するか。orch→manager と manager→worker のみ起動する。 */
export function canDelegate(fromRole: Role, toRole: Role): boolean {
  if (fromRole === "orch") return toRole === "manager";
  if (fromRole === "manager") return toRole === "worker";
  return false;
}

/** 子セッションが起動するときの初期ロール。起動しない場合は undefined。 */
export function childRole(fromRole: Role, toRole: Role): Role | undefined {
  return canDelegate(fromRole, toRole) ? toRole : undefined;
}

/** 委譲中の子エージェントから観測される、振る舞いの種別。 */
export type ChildObservationKind =
  | "progress"
  | "intermediate-log"
  | "final-result"
  | "work-highlights"
  | "artifact-info";

/** 子エージェントの観測。種別と内容。 */
export interface ChildObservation {
  readonly kind: ChildObservationKind;
  readonly content: string;
}

/** 親エージェントに渡る観測の種別。最終結果・作業要点・成果物情報の 3 つ。 */
export const PARENT_REPORT_OBSERVATION_KINDS: readonly ChildObservationKind[] = [
  "final-result",
  "work-highlights",
  "artifact-info",
];

/** 子の観測がオーナー画面に表示されるものか。進行（メッセージ・ツール実行）のみ。 */
export function isOwnerDisplayObservation(observation: ChildObservation): boolean {
  return observation.kind === "progress";
}

/** 子の観測が親エージェントに渡るものか。中間ログ・進行は親に渡らない。 */
export function isParentReportObservation(observation: ChildObservation): boolean {
  return PARENT_REPORT_OBSERVATION_KINDS.includes(observation.kind);
}

/** 報告先になり得る主体。セッションのロールか、オーナー。 */
export type Principal = Role | "owner";

/** タスクを遂行できない理由の区分。権限不足と、力量・情報不足。 */
export type FailureCategory = "permission" | "capacity";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = ["permission", "capacity"];

export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  permission: "権限不足",
  capacity: "力量・情報不足",
};

/** 報告元のロールと、誰に呼ばれたかから、報告先を決める。 */
export function reportDestination(reportingRole: Role, caller: Principal): Principal {
  if (reportingRole === "worker" || reportingRole === "manager") return caller;
  return "owner";
}

export default function roleExtension(pi: ExtensionAPI): void {
  let currentRole: Role = INITIAL_ROLE;

  pi.on("session_start", async (_event, ctx) => {
    currentRole = initialRole();
    ctx.ui.setWidget("role", (_ui, theme) => ({
      render: () => [theme.fg("dim", `🤖 role: ${currentRole}`)],
      invalidate: () => {},
    }), { placement: "aboveEditor" });
  });

  pi.on("before_agent_start", async (event) => {
    const addendum = buildRoleSystemPromptAddendum(currentRole);
    if (!addendum) return;
    return { systemPrompt: event.systemPrompt + addendum };
  });

  pi.on("tool_call", async (event) => {
    if (shouldBlockToolCall(currentRole, event.toolName)) {
      return { block: true, reason: `role ${currentRole} cannot use ${event.toolName}` };
    }
  });

  for (const role of ROLES) {
    pi.registerCommand(`role:${role}`, {
      description: `Switch the session role to ${role}.`,
      handler: async (_args, ctx) => {
        currentRole = switchRole(role);
        ctx.ui.setWidget("role", (_ui, theme) => ({
          render: () => [theme.fg("dim", `🤖 role: ${currentRole}`)],
          invalidate: () => {},
        }), { placement: "aboveEditor" });
        ctx.ui.notify(`role: ${currentRole}`, "info");
      },
    });
  }
}
