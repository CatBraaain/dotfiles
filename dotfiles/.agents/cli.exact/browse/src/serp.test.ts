import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { serpUrl } from "./serp";

const locales = [
  ["en", "us", "en-US", "us-en"],
  ["de", undefined, "de-DE", "de-de"],
  ["ru", undefined, "ru-RU", "ru-ru"],
  ["fr", undefined, "fr-FR", "fr-fr"],
  ["es", undefined, "es-ES", "es-es"],
  ["it", undefined, "it-IT", "it-it"],
  ["pt", "br", "pt-BR", "pt-pt"],
  ["zh", "cn", "zh-CN", "cn-zh"],
  ["ja", "jp", "ja-JP", "jp-ja"],
  ["ko", "kr", "ko-KR", "kr-ko"],
  ["nl", undefined, "nl-NL", "nl-nl"],
  ["pl", undefined, "pl-PL", "pl-pl"],
  ["tr", undefined, "tr-TR", "tr-tr"],
  ["ar", undefined, "ar-SA", "xa-ar"],
  ["cs", undefined, undefined, "cz-cs"],
  ["sk", undefined, undefined, "sk-sk"],
  ["hu", undefined, undefined, "hu-hu"],
  ["ro", undefined, undefined, "ro-ro"],
  ["da", undefined, undefined, "dk-da"],
  ["sv", undefined, undefined, "se-sv"],
  ["no", undefined, undefined, "no-no"],
  ["fi", undefined, undefined, "fi-fi"],
  ["el", undefined, undefined, "gr-el"],
  ["he", undefined, undefined, "il-he"],
  ["xx", undefined, undefined, undefined],
] as const;

describe("search locale mapping", () => {
  for (const [language, country, market, region] of locales) {
    it(`normalizes ${language.toUpperCase()} and sets only supported locale parameters`, () => {
      const google = new URL(serpUrl("google", "a & b", language.toUpperCase()));
      const bing = new URL(serpUrl("bing", "a & b", language.toUpperCase()));
      const duck = new URL(serpUrl("duckduckgo", "a & b", language.toUpperCase()));
      assert.deepEqual(Object.fromEntries(google.searchParams), {
        q: "a & b",
        hl: language,
        ...(country ? { gl: country } : {}),
      });
      assert.deepEqual(Object.fromEntries(bing.searchParams), {
        q: "a & b",
        ...(market ? { mkt: market } : {}),
      });
      assert.deepEqual(Object.fromEntries(duck.searchParams), {
        q: "a & b",
        ...(region ? { kl: region } : {}),
      });
    });
  }

  it("leaves locale parameters absent without --lang", () => {
    for (const engine of ["google", "duckduckgo", "bing"] as const) {
      assert.deepEqual(Object.fromEntries(new URL(serpUrl(engine, "query")).searchParams), {
        q: "query",
      });
    }
  });
});
