// Backend retry engine shared by search and fetch: runs each backend in turn,
// retries camoufox-classified failures (challenge / recoverable render) and
// collects attempts for the AllBackendsFailedError message.

type CamoufoxFailureKind = "challenge" | "recoverable-render" | "other";

function classifyCamoufoxFailure(message: string): CamoufoxFailureKind {
  if (
    message === "parse: captcha detected" ||
    message === "render: challenge detected"
  ) {
    return "challenge";
  }
  if (
    message.startsWith("render:") &&
    /aborted|closed|connection|disconnected|timed? out|timeout/i.test(message)
  ) {
    return "recoverable-render";
  }
  return "other";
}

export function camoufoxFailureKind(error: unknown): CamoufoxFailureKind {
  return classifyCamoufoxFailure(
    error instanceof Error ? error.message : String(error),
  );
}

interface CamoufoxRetryDecision {
  readonly kind: CamoufoxFailureKind;
  readonly shouldRetry: boolean;
  readonly consumesRecoveryBudget: boolean;
}

function decideCamoufoxRetry(
  error: unknown,
  backendAlreadyRetried: boolean,
): CamoufoxRetryDecision {
  const kind = camoufoxFailureKind(error);
  return {
    kind,
    consumesRecoveryBudget: kind === "recoverable-render",
    shouldRetry: !backendAlreadyRetried && kind !== "other",
  };
}

export function isCamoufoxServerCommand(
  args: readonly string[],
  scriptPath: string,
  serverSubcommand: string,
): boolean {
  return args[1] === scriptPath && args[2] === serverSubcommand;
}

export function lockedBrowseArgs(
  lockedSubcommand: string,
  args: readonly string[],
): string[] {
  return [lockedSubcommand, ...args];
}

export type Attempt =
  | {
      readonly backend: string;
      readonly ok: true;
      readonly durationMs?: number;
    }
  | {
      readonly backend: string;
      readonly ok: false;
      readonly error: string;
      readonly durationMs?: number;
    };

export type BackendEntry<T = string> = readonly [name: string, run: () => Promise<T>];
type BackendOperation = "web search" | "web fetch";

export interface RetryPreparation {
  readonly shouldRetry: boolean;
  readonly consumesRecoveryBudget: boolean;
}

interface CamoufoxRecoveryActions {
  readonly isServerResponsive: () => Promise<boolean>;
  readonly restartServer: () => Promise<void>;
}

export async function prepareCamoufoxRetry(
  error: unknown,
  recoveryRetries: number,
  actions: CamoufoxRecoveryActions,
): Promise<RetryPreparation> {
  const failureKind = camoufoxFailureKind(error);
  if (failureKind === "challenge") {
    return { shouldRetry: true, consumesRecoveryBudget: false };
  }
  if (failureKind !== "recoverable-render") {
    return { shouldRetry: false, consumesRecoveryBudget: false };
  }
  if (await actions.isServerResponsive()) {
    return { shouldRetry: true, consumesRecoveryBudget: false };
  }
  if (recoveryRetries > 0) {
    return { shouldRetry: false, consumesRecoveryBudget: false };
  }
  await actions.restartServer();
  return { shouldRetry: true, consumesRecoveryBudget: true };
}

type RetryHook = (
  error: unknown,
  recoveryRetries: number,
) => Promise<RetryPreparation>;

function renderAbortHint(attempts: readonly Attempt[]): string {
  const renderAborted = attempts.some(
    (attempt) =>
      !attempt.ok &&
      attempt.error.startsWith("render:") &&
      /aborted/i.test(attempt.error),
  );
  return renderAborted
    ? `\nHint: automatic render recovery did not resolve the failure. Render aborts are often transient, so retry the same call before concluding the service is down. If it fails again, run \`bun ~/.agents/cli/browse server restart\` and retry.`
    : "";
}

class AllBackendsFailedError extends Error {
  constructor(
    readonly operation: BackendOperation,
    readonly attempts: Attempt[],
  ) {
    super(
      `All ${operation} backends failed: ${attempts
        .filter((attempt) => !attempt.ok)
        .map((attempt) => `${attempt.backend}: ${attempt.error}`)
        .join("; ")}${renderAbortHint(attempts)}`,
    );
  }
}

export async function tryRecoveryBackends<T>(
  operation: BackendOperation,
  backends: readonly BackendEntry<T>[],
  isEmpty: (payload: T) => boolean,
  shouldRetry?: (error: unknown) => boolean,
  beforeRetry?: RetryHook,
): Promise<{ payload: T; backend: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  let recoverableRenderRetries = 0;
  for (const [name, run] of backends) {
    let challengeRetried = false;
    let recoverableRenderRetried = false;
    while (true) {
      const startedAt = Date.now();
      try {
        const payload = await run();
        if (isEmpty(payload)) throw new Error("empty response");
        attempts.push({
          backend: name,
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        return { payload, backend: name, attempts };
      } catch (error) {
        attempts.push({
          backend: name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
        const failureKind = camoufoxFailureKind(error);
        const alreadyRetried =
          failureKind === "challenge"
            ? challengeRetried
            : failureKind === "recoverable-render"
              ? recoverableRenderRetried
              : true;
        const retryDecision = decideCamoufoxRetry(error, alreadyRetried);
        if (!retryDecision.shouldRetry || !shouldRetry?.(error)) break;
        let preparation: RetryPreparation = {
          shouldRetry: true,
          consumesRecoveryBudget: retryDecision.consumesRecoveryBudget,
        };
        try {
          if (beforeRetry) {
            preparation = await beforeRetry(error, recoverableRenderRetries);
          }
        } catch (recoveryError) {
          attempts.push({
            backend: `${name} recovery`,
            ok: false,
            error:
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError),
          });
          break;
        }
        if (!preparation.shouldRetry) break;
        if (failureKind === "challenge") challengeRetried = true;
        if (failureKind === "recoverable-render") {
          recoverableRenderRetried = true;
        }
        if (preparation.consumesRecoveryBudget) recoverableRenderRetries += 1;
      }
    }
  }
  throw new AllBackendsFailedError(operation, attempts);
}

export function recoveryAttemptDuration(attempts: readonly Attempt[]): number {
  const last = attempts.at(-1);
  return last?.ok ? (last.durationMs ?? 0) : 0;
}

