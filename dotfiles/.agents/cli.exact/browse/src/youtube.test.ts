import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import {
  formatDuration,
  parseYouTubeUrl,
  pickSubtitleUrl,
  renderYouTubeMarkdown,
  vttToText,
} from "./youtube";

describe("parseYouTubeUrl", () => {
  it("parses a watch URL", () => {
    assert.deepEqual(parseYouTubeUrl("https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ"), {
      videoId: "dQw4w9WgXcQ",
      permalink: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("parses a youtu.be short link and a shorts path", () => {
    for (const raw of [
      "https://youtu.be/dQw4w9WgXcQ?si=xyz",
      "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    ]) {
      assert.equal(parseYouTubeUrl(raw)?.videoId, "dQw4w9WgXcQ");
    }
  });

  it("rejects non-video URLs", () => {
    for (const raw of [
      "https://www.youtube.com/@channel",
      "https://www.youtube.com/playlist?list=PL123",
      "https://vimeo.com/12345",
      "not a url",
    ]) {
      assert.equal(parseYouTubeUrl(raw), undefined);
    }
  });
});

describe("pickSubtitleUrl", () => {
  it("prefers manual ja captions before auto en", () => {
    const url = pickSubtitleUrl({
      en: [{ url: "https://example.com/en.vtt", ext: "vtt" }],
      "ja-auto": [{ url: "https://example.com/ja-auto.vtt", ext: "vtt" }],
    });
    assert.equal(url, "https://example.com/ja-auto.vtt");
  });

  it("falls back to en when no ja track exists", () => {
    const url = pickSubtitleUrl({
      fr: [{ url: "https://example.com/fr.vtt", ext: "vtt" }],
      en: [{ url: "https://example.com/en.vtt", ext: "vtt" }],
    });
    assert.equal(url, "https://example.com/en.vtt");
  });

  it("returns undefined without usable tracks", () => {
    assert.equal(pickSubtitleUrl(undefined), undefined);
    assert.equal(pickSubtitleUrl({ fr: [{ url: "https://example.com/fr.vtt", ext: "vtt" }] }), undefined);
  });
});

describe("vttToText", () => {
  it("strips headers, timings and duplicate rolling lines", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: ja",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000 align:start position:0%",
      "hello <b>world</b>",
      "",
      "2",
      "00:00:04.000 --> 00:00:06.000",
      "hello world",
      "second line",
      "",
    ].join("\n");
    assert.equal(vttToText(vtt), "hello world\nsecond line");
  });
});

describe("formatDuration", () => {
  it("formats below and above one hour", () => {
    assert.equal(formatDuration(65), "1:05");
    assert.equal(formatDuration(3675), "1:01:15");
  });
});

describe("renderYouTubeMarkdown", () => {
  it("renders metadata, description and transcript fallback", () => {
    const markdown = renderYouTubeMarkdown(
      {
        title: "Demo",
        channel: "Chan",
        webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        upload_date: "20260801",
        duration: 65,
        description: "A demo",
      },
      undefined,
    );
    assert.match(markdown, /^# Demo\n/);
    assert.match(markdown, /- Channel: Chan/);
    assert.match(markdown, /- Published: 2026-08-01/);
    assert.match(markdown, /- Duration: 1:05/);
    assert.match(markdown, /## Transcript\n\nNo subtitles available/);
  });
});
