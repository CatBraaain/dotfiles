import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import {
  createGuardrailsAPI,
  publishDirectoryWriteAccess,
  type GuardedToolRequest,
  type GuardrailsAPI,
} from "../guardrails/api.ts";
import { rewriteBashCommand } from "./rtk.ts";
import { modelSupportsImages } from "../shared/image-input.ts";

const WORKER_ENTRYPOINT = fileURLToPath(new URL("./run-tools.ts", import.meta.url));

export default function toolsExtension(pi: ExtensionAPI, configPath?: string): void {
  const guardrails = initializeGuardrails(pi, configPath);
  const cwd = process.cwd();
  const bash = createBashTool(cwd);
  const definitions = [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
    bash,
  ];
  for (const definition of definitions) {
    const execute = createGuardedExecutor(definition, guardrails);
    registerGuardedTool(pi, definition, execute);
  }
}

type GuardedExecutor = (
  request: Omit<GuardedToolRequest, "toolName" | "executor">,
) => Promise<AgentToolResult<unknown>>;

function createGuardedExecutor(
  definition: ToolDefinition,
  guardrails: Pick<GuardrailsAPI, "execute">,
): GuardedExecutor {
  return async function execute(request) {
    const model = request.context?.model;
    const readData =
      definition.name === "read"
        ? {
            data: {
              supportsImages: modelSupportsImages(model ?? {}),
              provider: model?.provider,
              modelId: model?.id,
            },
          }
        : {};
    return guardrails.execute({
      ...request,
      executor: { entrypoint: WORKER_ENTRYPOINT, ...readData },
      toolName: definition.name,
    });
  };
}

function registerGuardedTool(
  pi: ExtensionAPI,
  definition: ToolDefinition,
  execute: GuardedExecutor,
): void {
  pi.registerTool({
    ...definition,
    description: TOOL_DESCRIPTIONS[definition.name] ?? definition.description,
    ...(definition.name === "edit" ? { renderShell: "default" as const } : {}),
    async execute(id, params, signal, onUpdate, context) {
      const input = params as Record<string, unknown>;
      const guardedParams =
        definition.name === "bash" && typeof input.command === "string"
          ? { ...input, command: await rewriteBashCommand(input.command, context, signal) }
          : input;
      return execute({ id, params: guardedParams, signal, onUpdate, context });
    },
  });
}

function initializeGuardrails(
  pi: ExtensionAPI,
  configPath?: string,
): Pick<GuardrailsAPI, "execute"> {
  try {
    const guardrails = createGuardrailsAPI(pi, configPath);
    publishDirectoryWriteAccess(pi, guardrails);
    return guardrails;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, context) => {
      context.ui.notify(message, "error");
    });
    return {
      async execute() {
        throw error;
      },
    };
  }
}

const maxOutputKb = DEFAULT_MAX_BYTES / 1024;
const writePermissionGuidance =
  " 実効書き込みルールが `ask` または未設定のパスでは、ユーザーに許可を求める。明示的な `deny` と認証情報のパスは確認なしで拒否する。" +
  " 承認すると、対象範囲の Guardrails の書き込み権限がセッション終了まで更新され、その権限を使うすべてのツールで共有される。明示的な `deny` と認証情報のパスは保護されたまま。";

const TOOL_DESCRIPTIONS: Partial<Record<string, string>> = {
  read:
    "ファイルの内容を読み取る。テキストと画像（jpg、png、gif、webp、bmp）に対応し、画像は添付で返す。" +
    ` テキストは ${DEFAULT_MAX_LINES} 行と ${maxOutputKb}KB のうち先に達した上限で切り詰める。大きなファイルには \`offset\` と \`limit\` を使う。全文が必要なら \`offset\` を進めて最後まで読む。` +
    " 現在のモデルが画像入力に対応する場合、画像を Vision 入力として返す。非対応の場合は `vision` エージェントへの委譲を案内するエラーを返す。",
  write:
    "ファイルに内容を書き込む。ファイルがなければ作成し、既存のファイルは上書きする。親ディレクトリは自動で作成する。" +
    writePermissionGuidance,
  edit:
    "完全一致するテキストを置換して、1つのファイルを編集する。" +
    " 各 `edits[].oldText` は元のファイル内で1箇所にだけ一致し、ほかの置換範囲と重複してはならない。同じブロックや近接する行を編集する場合は1件にまとめる。離れた変更をつなぐためだけに、大きな未変更範囲を含めない。" +
    writePermissionGuidance,
  grep:
    "ファイルの内容からパターンを検索し、一致した行をファイルパスと行番号付きで返す。`.gitignore` に従う。" +
    ` 出力は100件と ${maxOutputKb}KB のうち先に達した上限で切り詰める。長い行は500文字で切り詰める。`,
  find:
    "glob パターンでファイルを検索し、一致したパスを検索ディレクトリからの相対パスで返す。`.gitignore` に従う。" +
    ` 出力は1000件と ${maxOutputKb}KB のうち先に達した上限で切り詰める。`,
  ls:
    "ディレクトリの内容を名前順で返す。ドットファイルも含め、ディレクトリ名の末尾には `/` を付ける。" +
    ` 出力は500件と ${maxOutputKb}KB のうち先に達した上限で切り詰める。`,
  bash:
    "現在の作業ディレクトリで Bash コマンドを実行し、標準出力と標準エラーを返す。" +
    ` 出力は末尾から最大 ${DEFAULT_MAX_LINES} 行または ${maxOutputKb}KB（先に達した上限）に収める。切り詰めた場合は全出力を一時ファイルに保存する。タイムアウトは秒単位で指定できる。` +
    ' ファイルシステムはサンドボックスで保護されている。許可範囲外への書き込みは "Read-only file system" で失敗する。この場合、同じ操作を `bash` で再試行しない。' +
    " `ask_permission` で申請できるのは、実効書き込みルールが `ask` または未設定のパスに限る。明示的な `deny` と認証情報のパスは許可できない。" +
    " 承認すると、許可された範囲の Guardrails の書き込み権限が更新され、その権限を使うすべてのツールで共有される。明示的な `deny` と認証情報のパスは保護されたまま。" +
    ' "Command requires a reason" で拒否された場合は、拒否されたコマンドを変更せず、理由を添えて `ask_permission` で申請する。承認を迂回するためにコマンドを書き換えない。',
};
