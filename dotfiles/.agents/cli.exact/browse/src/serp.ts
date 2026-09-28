// SERP URL building for each engine (locale mapping included) and openserp
// response parsing for the search pipeline.

// Locale parameter values follow openserp's engine URL builders
// (bing/url.go mkt, duckduckgo/url.go kl, google/url.go hl+gl).
const BING_MARKET_BY_LANGUAGE: Record<string, string> = {
  en: "en-US",
  de: "de-DE",
  ru: "ru-RU",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  pt: "pt-BR",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  nl: "nl-NL",
  pl: "pl-PL",
  tr: "tr-TR",
  ar: "ar-SA",
};

const DUCKDUCKGO_KL_BY_LANGUAGE: Record<string, string> = {
  en: "us-en",
  de: "de-de",
  fr: "fr-fr",
  es: "es-es",
  it: "it-it",
  nl: "nl-nl",
  pt: "pt-pt",
  ru: "ru-ru",
  pl: "pl-pl",
  cs: "cz-cs",
  sk: "sk-sk",
  hu: "hu-hu",
  ro: "ro-ro",
  da: "dk-da",
  sv: "se-sv",
  no: "no-no",
  fi: "fi-fi",
  tr: "tr-tr",
  el: "gr-el",
  he: "il-he",
  ar: "xa-ar",
  zh: "cn-zh",
  ja: "jp-ja",
  ko: "kr-ko",
};

const GOOGLE_COUNTRY_BY_LANGUAGE: Record<string, string> = {
  en: "us",
  pt: "br",
  zh: "cn",
  ja: "jp",
  ko: "kr",
};

// Spec: "--lang <code> がある → engine 固有のロケールパラメータへ反映する"。
// google は hl へ常に設定し、gl は対応表にある lang のみ。bing mkt / duckduckgo kl
// も対応表にある lang のみで、対応表にない lang では付与せず hl のみ設定される。
export function serpUrl(engine: SearchEngine, query: string, lang?: string): string {
  const params = new URLSearchParams({ q: query });
  const language = lang?.toLowerCase();
  if (language) {
    if (engine === "bing") {
      const market = BING_MARKET_BY_LANGUAGE[language];
      if (market) params.set("mkt", market);
    } else if (engine === "duckduckgo") {
      const kl = DUCKDUCKGO_KL_BY_LANGUAGE[language];
      if (kl) params.set("kl", kl);
    } else {
      params.set("hl", language);
      const gl = GOOGLE_COUNTRY_BY_LANGUAGE[language];
      if (gl) params.set("gl", gl);
    }
  }
  return buildSerpUrl(engine, query, Object.fromEntries(params));
}

export type SearchEngine = "bing" | "duckduckgo" | "google";

const SERP_BASE_URL: Record<SearchEngine, string> = {
  bing: "https://www.bing.com/search",
  duckduckgo: "https://duckduckgo.com/",
  google: "https://www.google.com/search",
};

function buildSerpUrl(
  engine: SearchEngine,
  query: string,
  parameters: Readonly<Record<string, string | undefined>> = {},
): string {
  const params = new URLSearchParams({ q: query });
  for (const [name, value] of Object.entries(parameters)) {
    if (value) params.set(name, value);
  }
  const base = SERP_BASE_URL[engine];
  return `${base}${base.includes("?") ? "&" : "?"}${params}`;
}

export interface OpenserpSearchResult {
  rank?: number;
  type?: string;
  title?: string;
  url?: string;
  display_url?: string;
  snippet?: string;
}

export function parseOpenserpResponse(body: string): OpenserpSearchResult[] {
  let payload: { results?: OpenserpSearchResult[] };
  try {
    payload = JSON.parse(body) as { results?: OpenserpSearchResult[] };
  } catch {
    throw new Error("parse: response is not valid JSON");
  }
  const results = payload.results ?? [];
  if (results.length === 0) throw new Error("parse: empty response");
  return results;
}

