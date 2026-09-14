// §2.3 confirmation dialogs over the userQuestions seam. The seam's shape
// (questions with options plus a free-text answer, agent scoping, an abort
// signal) is all the confirmation flows need; the labels and message lines
// below are the plugin's wording source of truth.
//
// Every dialog here treats a canceled or interrupted question as a denial,
// and a free-text ("custom") answer on a choice question as a denial too:
// the model-facing option sets are fixed by SPEC §2.3, so answering outside
// them is not an approval. The optional denial-reason follow-up question
// returns undefined for an empty answer or a cancel (no reason).

/** Option labels (SPEC §2.3). */
export const ALLOW_OPTION = "Yes, allow";
export const DENY_OPTION = "No, deny (reason next)";
export const FILE_OPTION = "File only";
export const DIRECTORY_OPTION = "Directory (subtree)";

/** Follow-up prompt shown after a denial so the user may give a reason. */
export const DENIAL_REASON_PROMPT = "Denied. Optional reason for the agent:";

/**
 * Structural subset of the userQuestions seam (`ctx.userQuestions`) used by
 * the confirmation flows, so tests inject a fake and the plugin holds no
 * runtime dependency on the service package.
 */
export type ConfirmUi = {
  ask(request: {
    questions: {
      id: string;
      question: string;
      detail?: string;
      header?: string;
      options?: { label: string }[];
    }[];
    agent?: unknown;
    signal?: AbortSignal;
  }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>;
};

/** Dialog line explaining which pattern caused the confirmation (§2.3). */
export function matchedPatternNote(matched: string | undefined): string {
  return matched === undefined ? "no matching pattern (default ask)" : `matched: ${matched}`;
}

/** One single-select question. `options` are plain labels (§2.3 tables). */
export type ConfirmRequest = {
  question: string;
  detail: string;
  options: string[];
  agent?: unknown;
  signal?: AbortSignal;
};

export type SelectionOutcome = { kind: "selected"; label: string } | { kind: "denied" };

/**
 * Ask one single-select question and resolve to the chosen label, or to a
 * denial when the question was canceled/interrupted or answered as free text
 * instead of one of the offered labels (§2.3: cancel and interruption count
 * as denial; the option sets are fixed).
 */
export async function askChoice(ui: ConfirmUi, request: ConfirmRequest): Promise<SelectionOutcome> {
  const id = "confirm";
  let answer: { answers: { id: string; selected: string[]; custom?: string }[] };
  try {
    answer = await ui.ask({
      questions: [
        {
          id,
          question: request.question,
          detail: request.detail,
          options: request.options.map((label) => ({ label })),
        },
      ],
      ...(request.agent !== undefined ? { agent: request.agent } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  } catch {
    return { kind: "denied" };
  }
  const item = answer.answers.find((entry) => entry.id === id);
  const label = item?.selected.at(0);
  if (item === undefined || label === undefined || item.custom !== undefined)
    return { kind: "denied" };
  return { kind: "selected", label };
}

/**
 * Ask the optional denial-reason follow-up as a free-text question. Returns
 * the trimmed reason, or undefined for an empty answer, a cancel, or an
 * interrupted question (§2.3: blank or cancel means no reason).
 */
export async function askDenialReason(
  ui: ConfirmUi,
  scope: { agent?: unknown; signal?: AbortSignal },
): Promise<string | undefined> {
  const id = "denial-reason";
  let answer: { answers: { id: string; selected: string[]; custom?: string }[] };
  try {
    answer = await ui.ask({
      questions: [{ id, question: DENIAL_REASON_PROMPT }],
      ...(scope.agent !== undefined ? { agent: scope.agent } : {}),
      ...(scope.signal !== undefined ? { signal: scope.signal } : {}),
    });
  } catch {
    return undefined;
  }
  const reason = answer.answers.find((entry) => entry.id === id)?.custom?.trim();
  return reason === undefined || reason === "" ? undefined : reason;
}
