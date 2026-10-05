// YouTube-only parsing and rendering: video URL detection, yt-dlp metadata +
// subtitle retrieval and Markdown shaping for the fetch pipeline.
import { PARSE_TIMEOUT_MS, YTDLP_TIMEOUT_MS } from "./config";
import { runWithStdin } from "./util";

export interface YouTubeVideoUrl {
  videoId: string;
  permalink: string;
}

// Spec: `youtube.com/watch?v=<id>`・`youtu.be/<id>`・`/shorts/<id>` を動画 URL
// として扱う。それ以外の YouTube URL は判別しない（camoufox 経路へ進む）。
export function parseYouTubeUrl(rawUrl: string): YouTubeVideoUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "youtu.be") {
    const videoId = url.pathname.split("/").filter(Boolean)[0];
    return videoId && isVideoId(videoId)
      ? { videoId, permalink: `https://www.youtube.com/watch?v=${videoId}` }
      : undefined;
  }
  if (
    hostname !== "youtube.com" &&
    hostname !== "www.youtube.com" &&
    hostname !== "m.youtube.com" &&
    hostname !== "music.youtube.com"
  ) {
    return undefined;
  }
  const videoId =
    (url.pathname === "/watch" ? url.searchParams.get("v") : undefined) ??
    /^\/shorts\/([^/]+)/.exec(url.pathname)?.[1];
  if (!videoId || !isVideoId(videoId)) return undefined;
  return { videoId, permalink: `https://www.youtube.com/watch?v=${videoId}` };
}

function isVideoId(videoId: string): boolean {
  return /^[\w-]{11}$/.test(videoId);
}

interface SubtitleTrack {
  url?: string;
  ext?: string;
}

// Subtitle language preference: native captions before auto-generated, ja
// before en (spec: ja → en の順で利用可能なもの)。
export function pickSubtitleUrl(
  captions: Record<string, SubtitleTrack[]> | undefined,
): string | undefined {
  if (!captions) return undefined;
  for (const lang of ["ja", "en"]) {
    for (const [key, tracks] of Object.entries(captions)) {
      if (!key.toLowerCase().startsWith(lang)) continue;
      const track = (tracks ?? []).find(
        (candidate) => candidate?.ext === "vtt" || candidate?.url?.includes(".vtt"),
      );
      if (track?.url) return track.url;
    }
  }
  return undefined;
}

// VTT cue text to plain text: drop the header, cue timings, sequence numbers
// and inline tags, then de-duplicate the repeated rolling-caption lines.
export function vttToText(vtt: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine
      .replace(/<[^>]+>/g, "")
      .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}.*$/, "")
      .trim();
    if (!line) continue;
    if (
      line === "WEBVTT" ||
      line.startsWith("NOTE") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      /^\d+$/.test(line)
    ) {
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join("\n");
}

interface YtDlpInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  webpage_url?: string;
  upload_date?: string;
  duration?: number;
  view_count?: number;
  description?: string;
  subtitles?: Record<string, SubtitleTrack[]>;
  automatic_captions?: Record<string, SubtitleTrack[]>;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function renderYouTubeMarkdown(
  info: YtDlpInfo,
  transcript: string | undefined,
): string {
  const lines = [
    `# ${info.title || "YouTube video"}`,
    "",
    `- Channel: ${info.channel ?? info.uploader ?? "unknown"}`,
    `- URL: ${info.webpage_url || ""}`,
  ];
  if (info.upload_date && /^\d{8}$/.test(info.upload_date)) {
    lines.push(
      `- Published: ${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`,
    );
  }
  if (typeof info.duration === "number" && info.duration > 0) {
    lines.push(`- Duration: ${formatDuration(info.duration)}`);
  }
  if (typeof info.view_count === "number" && info.view_count > 0) {
    lines.push(`- Views: ${info.view_count}`);
  }
  lines.push("", "## Description", "", info.description?.trim() || "(no description)");
  lines.push("", "## Transcript", "", transcript?.trim() || "No subtitles available");
  return lines.join("\n").trim();
}

// Prefer a PATH yt-dlp; machines without it fall back to uvx (uv is already
// required by the twifork wrapper). @latest re-resolves on every run so the
// frequently-breaking yt-dlp stays current at the cost of a registry lookup.
async function runYtDlp(args: string[]): Promise<string> {
  const run = (command: string, prefixedArgs: string[]): Promise<string> =>
    runWithStdin(command, [...prefixedArgs, ...args], "", YTDLP_TIMEOUT_MS);
  try {
    return await run("yt-dlp", []);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(
        `yt-dlp failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return run("uvx", ["yt-dlp@latest"]).catch((uvxError: unknown) => {
      throw new Error(
        `yt-dlp failed (uvx): ${uvxError instanceof Error ? uvxError.message : String(uvxError)}`,
      );
    });
  }
}

// Spec: yt-dlp でメタデータと字幕 URL（手動字幕を優先し自動字幕にフォールバック）
// を取得し、字幕 VTT を plain text 化して description とともに出力する。
export async function fetchYouTubeMarkdown(rawUrl: string): Promise<string> {
  const output = await runYtDlp([
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    rawUrl,
  ]);

  let info: YtDlpInfo;
  try {
    info = JSON.parse(output) as YtDlpInfo;
  } catch {
    throw new Error("yt-dlp returned no JSON metadata");
  }

  const subtitleUrl =
    pickSubtitleUrl(info.subtitles) ?? pickSubtitleUrl(info.automatic_captions);
  let transcript: string | undefined;
  if (subtitleUrl) {
    const response = await fetch(subtitleUrl, {
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    });
    if (response.ok) transcript = vttToText(await response.text());
  }
  return renderYouTubeMarkdown(info, transcript);
}
