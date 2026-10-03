// Search pipeline: render each engine's SERP through camoufox, parse it with
// openserp and pick the first engine that returns results (google →
// duckduckgo → bing, empty / challenge results advance to the next engine).
import { recoveryAttemptDuration, tryRecoveryBackends, type BackendEntry } from "./backends";
import { camoufoxRender, recoverCamoufoxBeforeRetry, shouldRetryCamoufox } from "./camoufox";
import {
  CAMOUFOX_SEARCH_SESSION_KEY,
  openserpBaseUrl,
  PARSE_TIMEOUT_MS,
  SERVER_WAIT_TIMEOUT_MS,
} from "./config";
import { ensureOpenserpServer } from "./server";
import {
  parseOpenserpResponse,
  serpUrl,
  type OpenserpSearchResult,
  type SearchEngine,
} from "./serp";
import { responseDetail } from "./util";

async function openserpParse(engine: SearchEngine, html: string): Promise<OpenserpSearchResult[]> {
  await ensureOpenserpServer(AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS));
  const response = await fetch(`${openserpBaseUrl()}/${engine}/parse?format=json`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: html,
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`parse: ${await responseDetail(response)}`);
  }
  return parseOpenserpResponse(await response.text());
}

export interface SearchOutcome {
  readonly engine: SearchEngine;
  readonly results: readonly OpenserpSearchResult[];
  readonly tookMs: number;
}

const SEARCH_ENGINES: readonly SearchEngine[] = ["google", "duckduckgo", "bing"];

// Spec: "engine を google → duckduckgo → bing の順で試行し、最初に成功した
// engine の結果上位 10 件を出力する"。空結果・captcha・challenge は backend
// 失敗として次の engine へ進む（tryRecoveryBackends）。
export async function searchOne(query: string, lang?: string): Promise<SearchOutcome> {
  const backends: BackendEntry<{ engine: SearchEngine; results: OpenserpSearchResult[] }>[] =
    SEARCH_ENGINES.map((engine) => [
      `camoufox+openserp(${engine})`,
      async () => {
        const searchUrl = serpUrl(engine, query, lang);
        const results = await openserpParse(
          engine,
          await camoufoxRender(searchUrl, CAMOUFOX_SEARCH_SESSION_KEY),
        );
        if (engine === "google") {
          for (const result of results) {
            if (result.url && !URL.canParse(result.url)) {
              result.url = URL.parse(result.url, searchUrl)?.href ?? result.url;
            }
          }
        }
        return { engine, results };
      },
    ]);
  const { payload, attempts } = await tryRecoveryBackends(
    "web search",
    backends,
    (payload) => payload.results.length === 0,
    shouldRetryCamoufox,
    recoverCamoufoxBeforeRetry,
  );
  return {
    engine: payload.engine,
    results: payload.results,
    tookMs: recoveryAttemptDuration(attempts),
  };
}
