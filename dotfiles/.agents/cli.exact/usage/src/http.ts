import type { ResolvedAuth } from "./types";
import { abortError, errorMessage, redactSecrets } from "./util";

const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export interface ProviderJsonRequest {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  redirect?: RequestRedirect;
  userAgent?: boolean;
  maxSuccessBodyBytes?: number;
  responseError?: (status: number, text: string) => string | undefined;
}

export async function fetchProviderJson(
  url: string,
  auth: ResolvedAuth,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
  request: ProviderJsonRequest = {},
): Promise<Record<string, unknown>> {
  if (signal.aborted) throw abortError();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Usage query deadline expired.");
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = { ...auth.headers };
    if (request.userAgent !== false && !hasHeader(headers, "User-Agent")) {
      headers["User-Agent"] = "pi-usage";
    }
    if (request.body && !hasHeader(headers, "Content-Type")) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      method: request.method ?? "GET",
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.redirected) throw new Error(`${description} refused a redirected response.`);
    if (controller.signal.aborted) throw abortError();
    const text = await readBoundedResponse(
      response,
      response.ok ? (request.maxSuccessBodyBytes ?? MAX_SUCCESS_BODY_BYTES) : MAX_ERROR_BODY_BYTES,
      !response.ok,
      description,
      controller.signal,
    );
    if (controller.signal.aborted) throw abortError();
    const responseError = request.responseError?.(response.status, text);
    if (responseError) throw new Error(responseError);
    if (!response.ok) throw new Error(`${description} returned HTTP ${response.status}.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${description} returned invalid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${description} response was not an object.`);
    }
    return redactResponseStrings(parsed, auth.secrets) as Record<string, unknown>;
  } catch (error) {
    if (timedOut) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
    }
    if (signal.aborted) throw abortError();
    throw new Error(errorMessage(error, auth.secrets));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  truncateOverflow: boolean,
  description: string,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const abort = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (truncated && !truncateOverflow) {
    throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  return truncated ? `${text}…` : text;
}

function redactResponseStrings(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactResponseStrings(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        redactSecrets(key, secrets),
        redactResponseStrings(field, secrets),
      ]),
    );
  }
  return value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}
